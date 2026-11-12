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

# Basis-Image mit Digest gepinnt (reproduzierbar); Dependabot haelt Tag + Digest aktuell.
ARG NODE_IMAGE=node:22.23.5-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64

FROM ${NODE_IMAGE} AS base
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
             src/app/favicon.ico \
             node_modules/swagger-ui-dist/swagger-ui-bundle.js \
             node_modules/pdfkit/js/data/Helvetica.afm; do \
      [ -e "$f" ] || { echo "FEHLER: $f fehlt im Standalone-Output" >&2; exit 1; }; \
    done; \
    ls src/generated/prisma/libquery_engine-*.so.node >/dev/null; \
    # Nicht benoetigt: sharp/libvips (Bildoptimierung ist aus, ~46 MB, kommt ueber den
    # Trace von next-server), vereinzelt mitgetracte TypeScript-Quellen, die Trace-Listen
    # selbst (*.nft.json, nur fuer den Build) und die Entwickler-Notiz zu den Schriften
    # (die OFL-Lizenztexte bleiben).
    rm -rf node_modules/sharp node_modules/@img assets/fonts/README.md; \
    find src -name '*.ts' -delete; \
    find .next -name '*.nft.json' -delete

# ── Prisma-CLI fuer "migrate deploy" beim Start ────────────────────────────────
# Eigene, schlanke Installation (nur prisma + dotenv fuer prisma.postgres.config.ts) in
# exakt den Versionen aus package-lock.json, statt aller Entwicklungsabhaengigkeiten.
FROM base AS prisma-cli
WORKDIR /opt/prisma-cli
COPY package-lock.json /tmp/package-lock.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    set -eu; \
    v() { node -p "require('/tmp/package-lock.json').packages['node_modules/$1'].version"; }; \
    echo '{"private":true}' > package.json; \
    npm install --no-audit --no-fund --no-package-lock "prisma@$(v prisma)" "dotenv@$(v dotenv)"; \
    npx prisma --version

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
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    ATTACHMENTS_DIR=/app/data/attachments \
    ARCHIVE_DIR=/app/data/archive

# Reihenfolge: zuerst die Prisma-CLI, darueber der Standalone-Server — bei
# gemeinsamen Paketen gewinnt der Stand, mit dem die App gebaut wurde.
COPY --from=prisma-cli --chown=node:node /opt/prisma-cli/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Migrationen + Start
COPY --from=build --chown=node:node /app/prisma/schema.postgres.prisma ./prisma/schema.postgres.prisma
COPY --from=build --chown=node:node /app/prisma/migrations-postgres ./prisma/migrations-postgres
COPY --from=build --chown=node:node /app/prisma.postgres.config.ts ./prisma.postgres.config.ts
COPY --from=build --chown=node:node \
     /app/scripts/docker-entrypoint.sh /app/scripts/db-prepare.sh /app/scripts/check-baseline.sql \
     ./scripts/
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE

# Datenverzeichnisse (Volumes oig-attachments / oig-archive). Neue benannte Volumes
# uebernehmen Eigentuemer und Rechte dieser Verzeichnisse; 750, damit Belege nicht
# weltlesbar sind.
RUN install -d -o node -g node -m 750 /app/data /app/data/attachments /app/data/archive /app/.next/cache

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

USER node
EXPOSE 3000
VOLUME ["/app/data/attachments", "/app/data/archive"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./scripts/docker-entrypoint.sh"]
