# syntax=docker/dockerfile:1
#
# OpenInvoice Germany — Produktions-Image (PostgreSQL).
#
#   docker build -t open-invoice-germany .
#
# Aufbau: deps (npm ci) -> build (Prisma-Client + Next.js standalone) -> runner.
# Das Laufzeit-Image enthaelt nur den Next.js-Standalone-Server samt der per Tracing
# ermittelten Laufzeitdateien (Prisma-Engine, PDF-Schriften, OpenAPI-Dokument, Favicon,
# Swagger-UI) und die Prisma-CLI fuer die Migrationen beim Start.
# Was ueberhaupt in den Build-Kontext darf, regelt die Whitelist in .dockerignore.

# Basis-Image mit Digest gepinnt (reproduzierbar); Dependabot haelt Tag + Digest aktuell
# (deshalb als literale FROM-Zeile, nicht ueber ARG).
FROM node:22.23.5-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64 AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ── Abhaengigkeiten ────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
# --ignore-scripts: postinstall ("prisma generate") braucht das Schema, das hier noch
# fehlt — die build-Stage generiert den Client explizit.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund --ignore-scripts

# ── Build ──────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_OUTPUT_STANDALONE=1
# PostgreSQL-Client generieren + Production-Build (force-dynamic Seiten -> kein DB-Zugriff im Build)
RUN npx prisma generate --config prisma.postgres.config.ts \
 && npx next build
# Dateien, die die App zur Laufzeit relativ zu process.cwd() liest, muss das Tracing in
# .next/standalone abgelegt haben — fehlt eine, bricht der Build hier ab statt erst
# im Betrieb mit ENOENT (so fehlten frueher openapi.json, die PDF-Schriften und das Favicon).
RUN set -eu; cd .next/standalone; \
    for f in server.js \
             openapi/openapi.json \
             assets/fonts/LiberationSans-Regular.ttf \
             assets/fonts/IBMPlexSans-Regular.ttf \
             assets/fonts/IBMPlexSerif-Regular.ttf \
             assets/fonts/Inter-Regular.ttf \
             assets/fonts/SourceSerif4-Regular.ttf \
             src/app/favicon.ico \
             node_modules/swagger-ui-dist/swagger-ui-bundle.js \
             node_modules/pdfkit/js/data/Helvetica.afm; do \
      [ -e "$f" ] || { echo "FEHLER: $f fehlt im Standalone-Output" >&2; exit 1; }; \
    done; \
    ls src/generated/prisma/libquery_engine-*.so.node >/dev/null; \
    # Nicht benoetigt: sharp/libvips (Bildoptimierung ist aus, ~46 MB, kommt ueber den
    # Trace von next-server), vereinzelt mitgetracte TypeScript-Quellen, die Trace-Listen
    # (*.nft.json) und Sourcemaps (nur fuer den Build) sowie die Entwickler-Notiz zu den
    # Schriften (die OFL-Lizenztexte bleiben).
    rm -rf node_modules/sharp node_modules/@img assets/fonts/README.md; \
    find src -name '*.ts' -delete; \
    find .next \( -name '*.nft.json' -o -name '*.map' \) -delete; \
    find node_modules -name '*.map' -delete; \
    # Das Tracing kopiert nur die benoetigten Dateien je Paket — Lizenz- und Copyright-
    # Hinweise (MIT/BSD/Apache verlangen sie bei Weitergabe) aus node_modules nachziehen.
    find node_modules -name package.json -not -path '*/node_modules/*/node_modules/*/*/*' \
      | while read -r pkg; do \
          dir=$(dirname "$pkg"); \
          for lic in "/app/$dir"/LICEN[CS]E* "/app/$dir"/licen[cs]e* "/app/$dir"/NOTICE* "/app/$dir"/COPYING*; do \
            if [ -f "$lic" ]; then cp -n "$lic" "$dir/"; fi; \
          done; \
        done; \
    missing=$(for d in node_modules/* node_modules/@*/*; do \
                case "$d" in node_modules/@*/*|node_modules/[!@]*) ;; *) continue;; esac; \
                [ -f "$d/package.json" ] || continue; \
                # nur melden, wenn das Paket selbst eine Lizenzdatei mitbringt (manche, z. B.
                # brotli, liefern keine — dort steht die Lizenz nur in package.json/SBOM)
                if ls "/app/$d" | grep -qiE '^(licen[cs]e|copying)' \
                   && ! ls "$d" | grep -qiE '^(licen[cs]e|copying)'; then echo "${d#node_modules/}"; fi; \
              done); \
    [ -z "$missing" ] || { echo "FEHLER: Lizenzdatei fehlt fuer: $missing" >&2; exit 1; }

# ── Prisma-CLI fuer "migrate deploy" beim Start ────────────────────────────────
# Eigene, schlanke Installation (nur prisma + dotenv fuer prisma.postgres.config.ts)
# statt aller Entwicklungsabhaengigkeiten — mit eigenem Lockfile, also vollstaendig
# gepinnt. Die Versionen von prisma/dotenv prueft test/unit/dockerfile.test.ts gegen
# package-lock.json. Scripts laufen hier: @prisma/engines laedt die Schema-Engine.
FROM base AS prisma-cli
WORKDIR /opt/prisma-cli
COPY docker/prisma-cli/package.json docker/prisma-cli/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund \
 && find node_modules -name '*.map' -delete \
 && npx prisma --version

# ── Laufzeit ───────────────────────────────────────────────────────────────────
FROM base AS runner

# tini als PID 1: leitet SIGTERM an Node weiter und raeumt Zombie-Prozesse ab.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends tini

ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    ATTACHMENTS_DIR=/app/data/attachments \
    ARCHIVE_DIR=/app/data/archive

# Programmdateien gehoeren root und sind fuer den Laufzeitbenutzer nur lesbar.
# Reihenfolge: zuerst die Prisma-CLI, darueber der Standalone-Server (die beiden
# node_modules-Baeume haben derzeit keine gemeinsamen Pakete).
COPY --from=prisma-cli /opt/prisma-cli/node_modules ./node_modules
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Migrationen + Start
COPY --from=build /app/prisma/schema.postgres.prisma ./prisma/schema.postgres.prisma
COPY --from=build /app/prisma/migrations-postgres ./prisma/migrations-postgres
COPY --from=build /app/prisma.postgres.config.ts ./prisma.postgres.config.ts
COPY --from=build \
     /app/scripts/docker-entrypoint.sh /app/scripts/db-prepare.sh /app/scripts/check-baseline.sql \
     /app/scripts/disable-2fa.sh \
     ./scripts/
COPY --from=build /app/LICENSE ./LICENSE

# Beschreibbar fuer "node" sind nur die Datenverzeichnisse (Volumes oig-attachments /
# oig-archive; neue benannte Volumes uebernehmen Eigentuemer und Rechte, 750 = Belege
# nicht weltlesbar) und der Next.js-Cache.
RUN install -d -o node -g node -m 750 /app/data /app/data/attachments /app/data/archive \
 && install -d -o node -g node -m 755 /app/.next/cache

# Metadaten (OCI). VERSION/REVISION/CREATED setzt die CI (.github/workflows/docker.yml).
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED
LABEL org.opencontainers.image.title="OpenInvoice Germany" \
      org.opencontainers.image.description="Selbst gehostete Rechnungssoftware nach deutschem Recht: XRechnung, ZUGFeRD, GoBD" \
      org.opencontainers.image.source="https://github.com/c-sakel/open-invoice-germany" \
      org.opencontainers.image.url="https://github.com/c-sakel/open-invoice-germany" \
      org.opencontainers.image.documentation="https://github.com/c-sakel/open-invoice-germany#readme" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

# Kein VOLUME: ohne explizites Mount landeten Belege sonst unbemerkt in anonymen Volumes.
# Die Datenverzeichnisse bindet docker-compose.yml als benannte Volumes ein.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./scripts/docker-entrypoint.sh"]
