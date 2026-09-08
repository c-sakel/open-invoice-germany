# Phase 12d — API-Anfrageprotokoll

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Betreiberwunsch aus dem Phase-12-Auftrag: „Die API-Übersicht weiter ausbauen: man sollte die Requests der API sehen, um Fehler zu prüfen (empfangen/gesendet), aber nicht zu viel Datenmüll." Jede `/api/v1/*`-Anfrage bekommt eine Request-Id, die auf **jeder** Antwort steht; wer das Protokoll einschaltet, sieht Zeit, Methode, Pfad, Status, Dauer und Schlüssel in Einstellungen → API — und auf Wunsch die gekürzten, geschwärzten Bodies. Standard ist **aus**, Antwort-Bodies gibt es nur bei Fehlern, aufgeräumt wird im bestehenden Cleanup-Job.

**Architecture:** Vier Schichten, streng getrennt. (1) Zwei neue Tabellen — `ApiRequestLog` (die Zeilen) und `ApiSettings` (die zwei Schalter + Retention). (2) Reine Funktionen für Redaktion und Kürzung in `src/domain/api-log/redact.ts` — ohne DB, ohne Request, damit sie sich einzeln testen lassen. (3) Der Einhängepunkt ist `wrapped` in `src/api/auth.ts`: Request-Id am Anfang, Antwort am Ende, Log-Schreibvorgang **nach** dem Antwortbau als `void …catch(() => {})` — nie blockierend, nie in einer fremden Transaktion, ein Fehler beim Loggen darf die Anfrage nicht kippen. (4) Retention hängt sich in `runCleanupJob` (`src/domain/scheduler/cleanup.ts`), den letzten Job in `JOB_ORDER` — kein neuer Job.

**Tech Stack:** Next.js App Router, Prisma (SQLite + Postgres, keine Enums), Zod, Vitest (`environment: "node"`, **kein RTL** ⇒ keine Komponententests), Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-08-phase-12-feinschliff-design.md` — Paket **E** (Abschnitt 2: „API-Protokoll: Datenmodell / Erfassung / Sparsamkeit / UI & Schnittstellen / Retention"), Struktur Abschnitt 3 Block E, Tests Abschnitt 4 E, Teilphase 4 in Abschnitt 5, Ruling am Dateiende („Antwort-Bodies nur bei Status ≥ 400; Request-Bodies nur bei eingeschaltetem ‚Bodies mitschreiben'; beide auf 2 KB gekürzt, Secrets geschwärzt").

## Global Constraints

- Branch `phase-12d/api-protokoll` aus Fork-`main` (nach dem Merge von 12c). Jeder Commit mit `git commit -s`.
- **Keine neue Abhängigkeit.** `randomUUID` kommt aus `node:crypto`.
- **Datenminimierung (Art. 5 Abs. 1 lit. c DSGVO, COMPLIANCE.md §13/§18):** `logRequests` **und** `logBodies` sind standardmäßig `false`. Der `Authorization`-Header wird **nie** gespeichert. Response-Bodies nur bei `status >= 400`. Beides auf 2048 Byte gekürzt, Schlüssel gegen `/(secret|token|password|passwort|api[_-]?key|authorization|iban|bic)/i` geschwärzt.
- **GoBD (§51):** Das Protokoll ist **kein** Belegereignis und geht **nicht** in den `ChangeLog` (Audit-Ruling K5, CLAUDE.md). Die `@@unique([orgId, prevHash])`-Serialisierung des ChangeLogs gilt hier nicht — der Log-Schreibvorgang darf parallel laufen.
- **Kein Bypass (§50/§55):** `ApiSettings` wird ausschließlich über `apiSettingsInputSchema` (Zod) geschrieben, Filter für die Liste über `apiRequestLogFilterSchema`. Die Session-Route und die REST-Route rufen dieselben Domain-Funktionen.
- **Nie blockierend:** `logApiRequest` wird **nach** dem Bau der Antwort als `void logApiRequest(...).catch(() => {})` gestartet. Ein Fehler dort verändert weder Status noch Body. Protokolliert wird nur, was `verifyApiToken` passiert hat — Vor-Auth-429 und 401 mit unbekanntem Schlüssel bleiben ungeloggt (keine Organisation, der man den Eintrag zuordnen könnte).
- TypeScript strict, kein `any`. Dateien ≤ ~250 Zeilen. Deutsche UI-Texte mit echten Umlauten.
- **Nichts doppelt bauen (§1.4):** `runCleanupJob`, `withApi`, `apiList`/`parsePagination`, `SettingsTabs`, das UI-Muster aus `WebhooksManager.tsx` („Zustellprotokoll") werden erweitert bzw. übernommen, nicht kopiert.
- **Migration (§53):** ein Paar `prisma/migrations/…_phase12d_api_log` **und** `prisma/migrations-postgres/…_phase12d_api_log`; beide Schemadateien gepflegt (CI `schema-drift`). **Zwei neue Tabellen ⇒ jede `43`-Zusicherung in `scripts/test-postgres-migrations.sh` wird zu `45`** (Zeilen 42, 516, 618, 651 sowie die in 12c ergänzten Fälle 18 und 19). Anwenden mit `npx prisma migrate deploy`.
- Prüfkette vor jedem Commit **im Vordergrund**: `npm run typecheck && npm run lint && TZ=UTC npm test`. Vor dem letzten Commit zusätzlich `npm run build`, `npm run validate:erechnung`, `npm run api:check`. Alle Bestandstests bleiben grün (§1.7), besonders `test/unit/withapi-coverage.test.ts` und `test/integration/api-auth.test.ts`.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `prisma/schema.prisma`, `prisma/schema.postgres.prisma` | `model ApiRequestLog`, `model ApiSettings`, Relationen auf `Organization` |
| `prisma/migrations{,-postgres}/…_phase12d_api_log/migration.sql` | DDL (2 Tabellen, 4 Indizes) |
| `src/schemas/api-log.ts` | neu — `apiSettingsInputSchema`, `apiRequestLogFilterSchema` |
| `src/domain/api-log/redact.ts` | neu — reine Funktionen `redactJson`, `truncateBody`, `shouldLogPath` |
| `src/domain/api-log/settings.ts` | neu — `loadApiSettings`, `saveApiSettings`, `DEFAULT_API_SETTINGS` |
| `src/domain/api-log/write.ts` | neu — `logApiRequest` (nie werfend) |
| `src/domain/api-log/list.ts` | neu — `listApiRequestLogs`, `findApiRequestLog` |
| `src/domain/api-log/purge.ts` | neu — `purgeApiRequestLogs` (Retention), `clearApiRequestLogs` (Knopf) |
| `src/api/auth.ts` | Request-Id, `X-Request-Id`, `ApiContext.requestId`, Log-Hook |
| `src/domain/scheduler/cleanup.ts` | `apiRequestLogsDeleted` im `CleanupResult` |
| `src/app/api/settings/api-log/route.ts`, `.../[id]/route.ts` | Session-Routen (GET/PUT/DELETE bzw. GET) |
| `src/components/api-keys/ApiRequestLogPanel.tsx` | neu — Schalter, Tabelle, Filter, Detail-Schublade |
| `src/app/einstellungen/api/page.tsx` | Abschnitt „Anfrageprotokoll" |
| `src/app/api/v1/ApiRequestLog/route.ts`, `.../[id]/route.ts` | lesende REST-Ressource (Scope `read`) |
| `src/api/serializers/api-request-log.ts` | neu — `serializeApiRequestLog`, `apiRequestLogSchema` |
| `src/api/openapi.ts` | `RESOURCE_SCHEMAS` += `ApiRequestLog` |
| `src/mcp/tools/system.ts` | `list_api_requests` |
| `scripts/test-postgres-migrations.sh` | Fall 20, alle `43` → `45` |
| `openapi/openapi.json` | regeneriert |
| `docs/{API,MCP,ANLEITUNG,LIMITATIONEN,ARCHITEKTUR}.md`, `COMPLIANCE.md` | Doku |

---

### Task 1: Datenmodell, Zod, Einstellungs-Domain, Postgres-Fall

**Files:**
- Modify: `prisma/schema.prisma` (nach `model ApiIdempotency`, Z. 1120–1132) + `prisma/schema.postgres.prisma` (gleiche Stelle), `scripts/test-postgres-migrations.sh:42,516,618,651` + Fälle 18/19 + Dateiende
- Create: `prisma/migrations/20260911090000_phase12d_api_log/migration.sql`, `prisma/migrations-postgres/20260911090100_phase12d_api_log/migration.sql`, `src/schemas/api-log.ts`, `src/domain/api-log/settings.ts`, `test/unit/api-log-schemas.test.ts`

**Befund (verifiziert):** Das Schema kennt **keine** Prisma-Enums (Schemakopf: „KEINE Prisma-enums → String + Zod"). `ApiIdempotency` (Z. 1120) ist das nächstgelegene Vorbild für eine reine Infrastrukturtabelle: `orgId` ohne Relation wäre inkonsistent — `WebhookDelivery` (Z. 1165) trägt `orgId` ebenfalls ohne `Organization`-Relation, `ApiIdempotency` genauso. **Ruling:** `ApiRequestLog`/`ApiSettings` folgen `ApiIdempotency` und tragen `orgId String` **ohne** Relationsfeld — sonst müsste `model Organization` um zwei Rückrelationen wachsen und der Löschpfad einer Organisation (heute `onDelete: Cascade` nur dort, wo eine Relation existiert) würde sich ändern. Der Cleanup-Job räumt ohnehin nach Alter.

**Interfaces:**
```ts
// src/schemas/api-log.ts
export const apiSettingsInputSchema = z.object({
  logRequests: z.boolean().default(false),
  logBodies: z.boolean().default(false),
  retentionDays: z.coerce.number().int().min(1).max(90).default(7),
  maxRows: z.coerce.number().int().min(100).max(20000).default(2000),
});
export type ApiSettingsInput = z.infer<typeof apiSettingsInputSchema>;

export const apiRequestLogFilterSchema = z.object({
  apiKeyId: z.string().min(1).optional(),
  errorsOnly: z.coerce.boolean().default(false),
  path: z.string().min(1).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// src/domain/api-log/settings.ts
export const DEFAULT_API_SETTINGS: ApiSettingsInput;                 // = apiSettingsInputSchema.parse({})
export async function loadApiSettings(orgId: string): Promise<ApiSettingsInput>;
export async function saveApiSettings(orgId: string, raw: unknown): Promise<ApiSettingsInput>;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/api-log-schemas.test.ts
/** Phase 12d, Task 1 — Zod fuer ApiSettings und den Listenfilter. */
import { describe, it, expect } from "vitest";
import { apiSettingsInputSchema as S, apiRequestLogFilterSchema as F } from "@/schemas/api-log";

describe("apiSettingsInputSchema", () => {
  it("ist standardmaessig AUS (Datenminimierung)", () => {
    expect(S.parse({})).toMatchObject({ logRequests: false, logBodies: false, retentionDays: 7, maxRows: 2000 });
  });
  it("Grenzen: retentionDays 1..90, maxRows 100..20000, ganzzahlig", () => {
    for (const bad of [{ retentionDays: 0 }, { retentionDays: 91 }, { retentionDays: 7.5 }, { maxRows: 99 }, { maxRows: 20001 }]) {
      expect(S.safeParse(bad).success).toBe(false);
    }
    expect(S.parse({ retentionDays: 90, maxRows: 20000 })).toMatchObject({ retentionDays: 90, maxRows: 20000 });
  });
});

describe("apiRequestLogFilterSchema", () => {
  it("Defaults: 50 Zeilen, alle Status, kein Schluesselfilter", () => {
    expect(F.parse({})).toMatchObject({ errorsOnly: false, limit: 50, offset: 0 });
    expect(F.parse({}).apiKeyId).toBeUndefined();
  });
  it("nimmt Query-Strings entgegen (coerce) und deckelt limit bei 200", () => {
    const v = F.parse({ errorsOnly: "true", limit: "10", offset: "20", from: "2026-01-01" });
    expect(v).toMatchObject({ errorsOnly: true, limit: 10, offset: 20 });
    expect(v.from?.getUTCFullYear()).toBe(2026);
    expect(F.safeParse({ limit: 201 }).success).toBe(false);
  });
});
```
> `z.coerce.boolean()` macht aus jedem nicht-leeren String `true` — für `errorsOnly` ist das korrekt, weil die UI den Parameter nur setzt, wenn der Haken sitzt. Der Kommentar dazu gehört ins Schema.

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/api-log-schemas.test.ts`.

- [ ] **Step 3: Prisma + beide Migrationen**

In **beiden** Schemadateien nach `model ApiIdempotency`:
```prisma
/// Anfrageprotokoll der REST-API (Phase 12d, §18 COMPLIANCE.md). Standardmaessig AUS
/// (ApiSettings.logRequests). Bodies nur bei zusaetzlich eingeschaltetem logBodies,
/// Antwort-Bodies nur bei status >= 400, beide auf 2048 Byte gekuerzt und geschwaerzt.
/// KEIN Belegereignis -> geht NICHT in den ChangeLog (Audit-Ruling K5).
/// `orgId` ohne Relationsfeld — wie ApiIdempotency/WebhookDelivery (Infrastrukturtabelle).
model ApiRequestLog {
  id             String   @id @default(cuid())
  orgId          String
  apiKeyId       String?
  requestId      String
  method         String
  path           String
  query          String?
  status         Int
  durationMs     Int
  errorCode      String?
  ip             String?
  userAgent      String?
  requestBody    String?
  responseBody   String?
  bodyTruncated  Boolean  @default(false)
  createdAt      DateTime @default(now())

  @@index([orgId, createdAt])
  @@index([orgId, status, createdAt])
  // Ohne orgId-Praefix: der Aufraeumjob scannt ueber alle Organisationen
  // (gleiches Muster wie WebhookDelivery.@@index([status, nextAttemptAt])).
  @@index([createdAt])
}

/// Schalter und Retention des Anfrageprotokolls je Organisation (Phase 12d).
model ApiSettings {
  id            String   @id @default(cuid())
  orgId         String   @unique
  logRequests   Boolean  @default(false)
  logBodies     Boolean  @default(false)
  retentionDays Int      @default(7)
  maxRows       Int      @default(2000)
  updatedAt     DateTime @updatedAt
}
```
`prisma/migrations/20260911090000_phase12d_api_log/migration.sql` (SQLite):
```sql
-- Phase 12d — Anfrageprotokoll der REST-API. Zwei neue Tabellen, kein Bestandsdatensatz
-- wird angefasst; ohne ApiSettings-Zeile gelten die Defaults (Protokoll AUS).
-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "requestId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "query" TEXT,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "errorCode" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestBody" TEXT,
    "responseBody" TEXT,
    "bodyTruncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ApiSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "logRequests" BOOLEAN NOT NULL DEFAULT false,
    "logBodies" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "maxRows" INTEGER NOT NULL DEFAULT 2000,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ApiRequestLog_orgId_createdAt_idx" ON "ApiRequestLog"("orgId", "createdAt");
CREATE INDEX "ApiRequestLog_orgId_status_createdAt_idx" ON "ApiRequestLog"("orgId", "status", "createdAt");
CREATE INDEX "ApiRequestLog_createdAt_idx" ON "ApiRequestLog"("createdAt");
CREATE UNIQUE INDEX "ApiSettings_orgId_key" ON "ApiSettings"("orgId");
```
`prisma/migrations-postgres/20260911090100_phase12d_api_log/migration.sql` — dieselbe Struktur in Postgres-Syntax (`TEXT NOT NULL`, `INTEGER NOT NULL`, `BOOLEAN NOT NULL DEFAULT false`, `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`, `CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")`) — Vorbild ist `prisma/migrations-postgres/20260904205901_phase10_webhooks/migration.sql`, dessen `CREATE TABLE`-Form **wörtlich zu übernehmen** ist (nicht aus dem Kopf schreiben).

Anwenden: `npx prisma migrate deploy`, danach `npx prisma generate`.

- [ ] **Step 4: Zod + Einstellungs-Domain**
  - `src/schemas/api-log.ts` mit den beiden Schemas aus „Interfaces" anlegen; in `src/schemas/index.ts` re-exportieren (`export * from "./api-log";` — dem bestehenden Muster für `./customer`/`./quote-share` folgen, **erst prüfen**, wie die vorhandenen Re-Exporte formuliert sind).
  - `src/domain/api-log/settings.ts` nach dem Vorbild `src/domain/document/settings.ts` (Selbstheilung ohne Zeile):
    ```ts
    export const DEFAULT_API_SETTINGS: ApiSettingsInput = apiSettingsInputSchema.parse({});

    export async function loadApiSettings(orgId: string): Promise<ApiSettingsInput> {
      const row = await dbInternal.apiSettings.findUnique({ where: { orgId } });
      if (!row) return DEFAULT_API_SETTINGS;
      return apiSettingsInputSchema.parse({
        logRequests: row.logRequests,
        logBodies: row.logBodies,
        retentionDays: row.retentionDays,
        maxRows: row.maxRows,
      });
    }

    export async function saveApiSettings(orgId: string, raw: unknown): Promise<ApiSettingsInput> {
      const input = apiSettingsInputSchema.parse(raw);
      await dbInternal.apiSettings.upsert({ where: { orgId }, create: { orgId, ...input }, update: { ...input } });
      return input;
    }
    ```

- [ ] **Step 5: Postgres-Skript**
  1. **Alle vier bestehenden `43`-Zusicherungen** (Zeilen 42, 516, 618, 651) und die in 12c ergänzten Fälle 18/19 auf `45` setzen; die zugehörigen `echo`-Texte mitziehen und in Fall 1 die Aufzählung um „Phase 12d: ApiRequestLog, ApiSettings" erweitern.
  2. Neuer **Fall 20** am Dateiende (vor `echo "ALLE TESTS BESTANDEN"`), Muster Fall 16/18: alle Migrationen außer `20260911090100_phase12d_api_log` einspielen, `org20` anlegen, `npx prisma migrate deploy`, dann:
     ```sh
     echo "==> Fall 20 (Phase 12d): Anfrageprotokoll — zwei neue Tabellen, Indizes, Defaults"
     for TBL in ApiRequestLog ApiSettings; do
       EXISTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select to_regclass('\"$TBL\"') is not null")
       [ "$EXISTS" = "t" ] || fail "Tabelle $TBL fehlt nach der Phase-12d-Migration"
     done
     for IDX in ApiRequestLog_orgId_createdAt_idx ApiRequestLog_orgId_status_createdAt_idx ApiRequestLog_createdAt_idx ApiSettings_orgId_key; do
       N=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from pg_indexes where indexname='$IDX'")
       [ "$N" = "1" ] || fail "Index $IDX fehlt"
     done
     docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
     INSERT INTO "ApiSettings" ("id","orgId","updatedAt") VALUES ('as20','org20',NOW());
     SQL
     DEFAULTS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
       "select \"logRequests\",\"logBodies\",\"retentionDays\",\"maxRows\" from \"ApiSettings\" where id='as20'")
     [ "$DEFAULTS" = "f|f|7|2000" ] || fail "ApiSettings-Defaults abweichend ('$DEFAULTS'), erwartet f|f|7|2000"
     COUNT20=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
       "select count(*) from information_schema.tables where table_schema='public'")
     [ "$COUNT20" = "45" ] || fail "erwartet 45 Tabellen nach Phase 12d, gefunden $COUNT20"
     echo "    ok — ApiRequestLog + ApiSettings mit vier Indizes, Protokoll standardmaessig AUS, 45 Tabellen"
     ```

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add prisma src/schemas src/domain/api-log scripts/test-postgres-migrations.sh test/unit/api-log-schemas.test.ts
git commit -s -m "feat(api-log): ApiRequestLog und ApiSettings mit Zod und Einstellungs-Domain (Phase 12d, Task 1)"
```

---

### Task 2: Redaktion, Kürzung, Schreib-/Lese-/Löschfunktionen

**Files:**
- Create: `src/domain/api-log/redact.ts`, `src/domain/api-log/write.ts`, `src/domain/api-log/list.ts`, `src/domain/api-log/purge.ts`, `test/unit/api-log-redact.test.ts`

**Interfaces:**
```ts
// src/domain/api-log/redact.ts
export const MAX_BODY_BYTES = 2048;
export const REDACTED = "[redaktiert]";
export const SECRET_KEY_PATTERN = /(secret|token|password|passwort|api[_-]?key|authorization|iban|bic)/i;
export const UNLOGGED_PATHS: readonly string[];
export function shouldLogPath(pathname: string): boolean;
export function redactJson(value: unknown): unknown;
export function prepareBody(raw: string | null | undefined): { text: string | null; truncated: boolean };

// src/domain/api-log/write.ts
export interface ApiLogInput {
  orgId: string; apiKeyId: string | null; requestId: string;
  method: string; path: string; query: string | null;
  status: number; durationMs: number; errorCode: string | null;
  ip: string | null; userAgent: string | null;
  requestBody: string | null;      // roher Text, noch ungekuerzt
  responseBody: string | null;     // nur vom Aufrufer gesetzt, wenn status >= 400
}
export async function logApiRequest(input: ApiLogInput): Promise<void>;   // wirft NIE

// src/domain/api-log/list.ts
export interface ApiRequestLogListResult { rows: ApiRequestLog[]; total: number; limit: number; offset: number }
export async function listApiRequestLogs(orgId: string, rawFilter: unknown): Promise<ApiRequestLogListResult>;
export async function findApiRequestLog(orgId: string, id: string): Promise<ApiRequestLog | null>;

// src/domain/api-log/purge.ts
export async function purgeApiRequestLogs(now?: Date): Promise<number>;   // Retention, alle Orgs
export async function clearApiRequestLogs(orgId: string): Promise<number>;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/api-log-redact.test.ts
/** Phase 12d, Task 2 — Redaktion, Kuerzung, Pfad-Ausschluss (reine Funktionen, keine DB). */
import { describe, it, expect } from "vitest";
import { redactJson, prepareBody, shouldLogPath, MAX_BODY_BYTES, REDACTED } from "@/domain/api-log/redact";

describe("redactJson", () => {
  it("schwaerzt verdaechtige Schluessel, gross wie klein, verschachtelt und in Arrays", () => {
    expect(redactJson({ token: "x", Secret: "y", passwort: "z", apiKey: "a", api_key: "b" })).toEqual({
      token: REDACTED, Secret: REDACTED, passwort: REDACTED, apiKey: REDACTED, api_key: REDACTED,
    });
    expect(redactJson({ a: { b: { iban: "DE02..." } }, list: [{ bic: "XX" }, { ok: 1 }] })).toEqual({
      a: { b: { iban: REDACTED } }, list: [{ bic: REDACTED }, { ok: 1 }],
    });
  });
  it("laesst harmlose Felder und Nicht-Objekte unveraendert", () => {
    expect(redactJson({ name: "Kunde AG", netTotalCents: 11900 })).toEqual({ name: "Kunde AG", netTotalCents: 11900 });
    expect(redactJson("text")).toBe("text");
    expect(redactJson(null)).toBeNull();
  });
});

describe("prepareBody", () => {
  it("schwaerzt vor dem Kuerzen und markiert das Kuerzen", () => {
    const r = prepareBody(JSON.stringify({ token: "geheim", note: "a".repeat(4000) }));
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(r.text).toContain(REDACTED);
    expect(r.text).not.toContain("geheim");
  });
  it("laesst Nicht-JSON als Text durch, leerer/fehlender Body -> null", () => {
    expect(prepareBody("kein json")).toEqual({ text: "kein json", truncated: false });
    for (const empty of ["", null, undefined]) expect(prepareBody(empty).text).toBeNull();
  });
  it("kuerzt an einer Zeichengrenze, nicht mitten in einem Mehrbyte-Zeichen", () => {
    const r = prepareBody("ü".repeat(3000));
    expect(r.text?.endsWith("�")).toBe(false);
    expect(Buffer.byteLength(r.text ?? "", "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });
});

describe("shouldLogPath", () => {
  it("schliesst Doku, OpenAPI, ping und das Protokoll selbst aus", () => {
    for (const p of ["/api/docs", "/api/docs/assets/x.js", "/api/v1/openapi.json", "/api/v1/ping", "/api/v1/ApiRequestLog", "/api/v1/ApiRequestLog/abc"]) {
      expect(shouldLogPath(p)).toBe(false);
    }
    expect(shouldLogPath("/api/v1/Invoice")).toBe(true);
    expect(shouldLogPath("/api/v1/Invoice/abc/finalize")).toBe(true);
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/api-log-redact.test.ts`.

- [ ] **Step 3: `redact.ts` schreiben**

```ts
// src/domain/api-log/redact.ts
/**
 * Reine Helfer fuer das Anfrageprotokoll (Phase 12d) — kein DB-Zugriff, kein Request:
 * Schwaerzen verdaechtiger JSON-Schluessel, Kuerzen auf 2 KB, Ausschluss der Pfade, die
 * nichts zum Debuggen beitragen (Doku/OpenAPI/ping) oder eine Rekursion ausloesen wuerden
 * (die Protokoll-Route selbst). Der Authorization-HEADER wird nirgends gespeichert — er
 * kommt gar nicht erst in diese Datei; das Muster deckt nur ein gleichnamiges JSON-Feld ab.
 */
export const MAX_BODY_BYTES = 2048;
export const REDACTED = "[redaktiert]";
export const SECRET_KEY_PATTERN = /(secret|token|password|passwort|api[_-]?key|authorization|iban|bic)/i;

/** Pfade ohne Protokolleintrag — exakt ODER als Praefix mit "/". */
export const UNLOGGED_PATHS: readonly string[] = ["/api/docs", "/api/v1/openapi.json", "/api/v1/ping", "/api/v1/ApiRequestLog"];

export function shouldLogPath(pathname: string): boolean {
  return !UNLOGGED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactJson(v);
  }
  return out;
}

/**
 * Schwaerzt (sofern JSON) und kuerzt. Gekuerzt wird ZEICHENweise gegen die Byte-Grenze —
 * ein Schnitt mitten in einem Mehrbyte-Zeichen wuerde ein Ersatzzeichen erzeugen.
 */
export function prepareBody(raw: string | null | undefined): { text: string | null; truncated: boolean } {
  if (!raw) return { text: null, truncated: false };
  let text = raw;
  try {
    text = JSON.stringify(redactJson(JSON.parse(raw)));
  } catch {
    // kein JSON -> unveraendert (aber gekuerzt) uebernehmen
  }
  if (Buffer.byteLength(text, "utf8") <= MAX_BODY_BYTES) return { text, truncated: false };
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > MAX_BODY_BYTES) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
```

- [ ] **Step 4: `write.ts`, `list.ts`, `purge.ts`**
  - `write.ts#logApiRequest`: lädt `loadApiSettings(orgId)`; bei `!logRequests` sofort `return`; bei `!shouldLogPath(path)` ebenfalls. Bodies nur bei `logBodies` (`requestBody` immer, `responseBody` nur wenn der Aufrufer einen übergeben hat — die `status >= 400`-Regel setzt `withApi` durch, weil nur dort geklont wird). `bodyTruncated` ist `true`, sobald **eines** der beiden gekürzt wurde. Der gesamte Rumpf steht in `try { … } catch { /* Protokollieren darf die Anfrage nie kippen */ }` — die Funktion wirft nie.
  - `list.ts`: exakt nach dem Vorbild `src/domain/email/log-list.ts` (dort `prisma`, nicht `dbInternal`). `where` = `{ orgId, ...(apiKeyId ? { apiKeyId } : {}), ...(errorsOnly ? { status: { gte: 400 } } : {}), ...(path ? { path: { contains: path } } : {}), ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) }`, `orderBy: { createdAt: "desc" }`, `count` + `findMany` per `Promise.all`.
    > `path: { contains: … }` ist ohne `mode: "insensitive"` in SQLite ohnehin case-insensitive und in Postgres case-sensitive — für einen Pfad-Teilstring wie „Invoice" akzeptabel. Der Kommentar dazu gehört in den Code; `src/lib/db.ts` bringt bereits einen portablen `contains`-Helfer mit (Schemakopf-Kommentar prüfen und **falls vorhanden diesen nutzen**).
  - `purge.ts#purgeApiRequestLogs(now = new Date())`:
    ```ts
    const orgs = await dbInternal.apiRequestLog.findMany({ distinct: ["orgId"], select: { orgId: true } });
    let deleted = 0;
    for (const { orgId } of orgs) {
      const { retentionDays, maxRows } = await loadApiSettings(orgId);
      const threshold = new Date(now.getTime() - retentionDays * DAY_MS);
      deleted += (await dbInternal.apiRequestLog.deleteMany({ where: { orgId, createdAt: { lt: threshold } } })).count;
      // Danach auf maxRows kuerzen — blockweise (SQLite mag keine riesigen IN-Listen).
      for (;;) {
        const surplus = await dbInternal.apiRequestLog.findMany({
          where: { orgId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: maxRows,
          take: 1000,
          select: { id: true },
        });
        if (surplus.length === 0) break;
        deleted += (await dbInternal.apiRequestLog.deleteMany({ where: { id: { in: surplus.map((r) => r.id) } } })).count;
        if (surplus.length < 1000) break;
      }
    }
    return deleted;
    ```
    `orderBy` mit `id` als zweitem Kriterium: bei gleichem `createdAt` (SQLite schreibt Millisekunden) wäre die Reihenfolge sonst unbestimmt und der Schnitt nicht reproduzierbar. `clearApiRequestLogs(orgId)` ist ein einfaches `deleteMany({ where: { orgId } })`.

- [ ] **Step 5: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/domain/api-log test/unit/api-log-redact.test.ts
git commit -s -m "feat(api-log): Redaktion, Kuerzung, Schreib-/Lese-/Aufraeumfunktionen (Phase 12d, Task 2)"
```

---

### Task 3: Request-Id und Einhängepunkt in `withApi`

**Files:**
- Modify: `src/api/auth.ts:1-36,56-62,88-175`
- Create: `test/integration/api-log-hook.test.ts`

**Befund (verifiziert):** `wrapped` (Z. 93–172) liest den Body **genau einmal** (Z. 117 `rawBody = await req.text()`) und hält ihn bereits in einer lokalen Variablen — für das Protokoll wird **nicht** erneut gelesen. Es gibt zwei Rückgabepunkte im `try` (Idempotenz-Replay Z. 143, Normalfall Z. 168) und einen im `catch` (Z. 170). `ApiContext` (Z. 56–62) kennt heute `orgId`, `apiKey`, `actor`, `params`, `body` — keine Request-Id. `apiError(e)` baut die Fehlerantwort; der Fehlercode steht im Body unter `error.code`.

**Ruling (Struktur):** Damit **alle drei** Rückgabepunkte dieselbe Nachbearbeitung durchlaufen, wandert der heutige `try`-Rumpf unverändert in eine innere `async function run(): Promise<NextResponse>`; `wrapped` ruft sie in einem `try/catch` auf und setzt danach `X-Request-Id` und den Log-Hook. `run()` schreibt die für das Protokoll nötigen Werte in ein lokales `trace`-Objekt. Der Diff bleibt damit auf Einrückung + Rahmen beschränkt — **keine** Zeile der bestehenden Logik wird inhaltlich verändert.

**Interfaces:**
```ts
export interface ApiContext<TParams = Record<string, string>> {
  orgId: string; apiKey: VerifiedApiKey; actor: string; params: TParams; body: unknown;
  /** Phase 12d — auch als X-Request-Id auf der Antwort und in ApiRequestLog.requestId. */
  requestId: string;
}
export const REQUEST_ID_HEADER = "X-Request-Id";
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/api-log-hook.test.ts
/**
 * Phase 12d, Task 3 — der Log-Hook in withApi. Eigenes Jahr 2082 (Testjahr-Konvention),
 * kein Rechnungsbezug. `logApiRequest` laeuft als void-Promise: die Tests warten mit einer
 * kleinen Schleife auf die Zeile, statt eine feste Pause zu setzen.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { saveApiSettings } from "@/domain/api-log/settings";
import { GET as pingGet } from "@/app/api/v1/ping/route";

let orgId: string;

function req(url: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

/** Wartet, bis mindestens `min` Zeilen fuer die Organisation vorliegen (void-Promise). */
async function waitForRows(min: number, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const n = await dbInternal.apiRequestLog.count({ where: { orgId } });
    if (n >= min) return n;
    await new Promise((r) => setTimeout(r, 20));
  }
  return dbInternal.apiRequestLog.count({ where: { orgId } });
}

const echo = withApi(async (_req, ctx) => {
  const parsed = z.object({ note: z.string() }).safeParse(ctx.body);
  if (!parsed.success) throw parsed.error;
  return apiData({ note: parsed.data.note, requestId: ctx.requestId });
}, { scope: "write" });

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Protokoll Test GmbH", addressLine1: "Logweg 1", postalCode: "10115", city: "Berlin", vatId: "DE822222222", taxNumber: "82/222/22222" },
  });
  orgId = org.id;
});

beforeEach(async () => {
  resetRateLimits();
  await dbInternal.apiRequestLog.deleteMany({ where: { orgId } });
});

describe("X-Request-Id", () => {
  it("steht auf Erfolg UND auf Fehler auf der Antwort", async () => {
    const key = await createApiKey(orgId, { name: `k${Math.random()}`, scopes: ["read"], expiresAt: null });
    const ok = await pingGet(req("http://x/api/v1/ping", { token: key.token }));
    expect(ok.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    const bad = await pingGet(req("http://x/api/v1/ping"));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("Protokollierung", () => {
  it("logRequests=false -> keine Zeile", async () => {
    await saveApiSettings(orgId, { logRequests: false, logBodies: false });
    const key = await createApiKey(orgId, { name: `k${Math.random()}`, scopes: ["read"], expiresAt: null });
    await pingGet(req("http://x/api/v1/ping", { token: key.token }));
    await new Promise((r) => setTimeout(r, 100));
    expect(await dbInternal.apiRequestLog.count({ where: { orgId } })).toBe(0);
  });

  it("logRequests=true ohne logBodies -> Kopfdaten, keine Bodies; requestId == X-Request-Id", async () => {
    await saveApiSettings(orgId, { logRequests: true, logBodies: false });
    const key = await createApiKey(orgId, { name: `k${Math.random()}`, scopes: ["write"], expiresAt: null });
    const res = await echo(req("http://x/api/v1/Echo?a=1", { method: "POST", token: key.token, body: { note: "hallo" } }));
    expect(res.status).toBe(200);
    await waitForRows(1);
    const row = await dbInternal.apiRequestLog.findFirstOrThrow({ where: { orgId }, orderBy: { createdAt: "desc" } });
    expect(row.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(row).toMatchObject({ method: "POST", path: "/api/v1/Echo", query: "a=1", status: 200, apiKeyId: key.id, requestBody: null, responseBody: null });
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logBodies bei 200 -> Request-Body (geschwaerzt), KEIN Response-Body", async () => {
    await saveApiSettings(orgId, { logRequests: true, logBodies: true });
    const key = await createApiKey(orgId, { name: `k${Math.random()}`, scopes: ["write"], expiresAt: null });
    await echo(req("http://x/api/v1/Echo", { method: "POST", token: key.token, body: { note: "hallo", token: "geheim" } }));
    await waitForRows(1);
    const row = await dbInternal.apiRequestLog.findFirstOrThrow({ where: { orgId }, orderBy: { createdAt: "desc" } });
    expect(row.requestBody).toContain("hallo");
    expect(row.requestBody).toContain("[redaktiert]");
    expect(row.requestBody).not.toContain("geheim");
    expect(row.responseBody).toBeNull();
  });

  it("logBodies bei 400 -> beide Bodies, errorCode gesetzt", async () => {
    await saveApiSettings(orgId, { logRequests: true, logBodies: true });
    const key = await createApiKey(orgId, { name: `k${Math.random()}`, scopes: ["write"], expiresAt: null });
    expect((await echo(req("http://x/api/v1/Echo", { method: "POST", token: key.token, body: { falsch: 1 } }))).status).toBe(400);
    await waitForRows(1);
    const row = await dbInternal.apiRequestLog.findFirstOrThrow({ where: { orgId }, orderBy: { createdAt: "desc" } });
    expect(row).toMatchObject({ status: 400, errorCode: "VALIDATION" });
    expect(row.requestBody).toContain("falsch");
    expect(row.responseBody).toContain("VALIDATION");
  });

  it("Vor-Auth-401 und /api/v1/ping erzeugen keine Zeile", async () => {
    await saveApiSettings(orgId, { logRequests: true, logBodies: true });
    const before = await dbInternal.apiRequestLog.count();
    await pingGet(req("http://x/api/v1/ping", { token: `oig_${"a".repeat(40)}` }));   // unbekanntes Token
    const key = await createApiKey(orgId, { name: `k${Math.random()}`, scopes: ["read"], expiresAt: null });
    await pingGet(req("http://x/api/v1/ping", { token: key.token }));                 // Rauschfilter
    await new Promise((r) => setTimeout(r, 100));
    expect(await dbInternal.apiRequestLog.count()).toBe(before);
  });

  it("ein Fehler beim Protokollieren veraendert die Antwort nicht", async () => {
    await saveApiSettings(orgId, { logRequests: true, logBodies: false });
    const key = await createApiKey(orgId, { name: `k${Math.random()}`, scopes: ["write"], expiresAt: null });
    // Schreibfehler erzwingen: Spalte `path` mit einem Wert, den die DB annimmt, ist nicht
    // provozierbar — stattdessen die Settings-Abfrage brechen lassen.
    const spy = vi.spyOn(await import("@/domain/api-log/settings"), "loadApiSettings").mockRejectedValue(new Error("DB weg"));
    const res = await echo(req("http://x/api/v1/Echo", { method: "POST", token: key.token, body: { note: "trotzdem" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.note).toBe("trotzdem");
    spy.mockRestore();
  });
});
```
> `vi` importieren. Falls sich `loadApiSettings` nicht spionieren lässt (ESM-Live-Binding), stattdessen `vi.mock("@/domain/api-log/settings", …)` mit einer werfenden Implementierung in einer **eigenen** Testdatei — die Zusicherung (Antwort unverändert) ist entscheidend, nicht die Technik.

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/api-log-hook.test.ts`.

- [ ] **Step 3: `withApi` umbauen**

```ts
import { randomUUID } from "node:crypto";
import { logApiRequest } from "@/domain/api-log/write";
import { shouldLogPath } from "@/domain/api-log/redact";

export const REQUEST_ID_HEADER = "X-Request-Id";

export function withApi<TParams = Record<string, string>>(handler: ApiHandler<TParams>, opts: { scope: ApiKeyScope; maxBodyBytes?: number }) {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const wrapped = async (req: Request, routeCtx?: ApiRouteContext<TParams>): Promise<NextResponse> => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    // Was `run()` fuer das Protokoll zurueckmeldet — nur gesetzt, wenn die Anfrage
    // verifyApiToken passiert hat (vorher gibt es keine Organisation).
    const trace: { apiKey?: VerifiedApiKey; rawBody: string } = { rawBody: "" };

    async function run(): Promise<NextResponse> {
      // ── unveraendert der bisherige try-Rumpf (Z. 95-168) ──
      // ergaenzt an genau drei Stellen:
      //   const apiKey = await verifyApiToken(...);  ->  trace.apiKey = apiKey;
      //   rawBody = await req.text();                ->  trace.rawBody = rawBody;
      //   const ctx: ApiContext<TParams> = { orgId: apiKey.orgId, apiKey, actor, params, body, requestId };
    }

    let res: NextResponse;
    try {
      res = await run();
    } catch (e) {
      res = apiError(e);
    }
    res.headers.set(REQUEST_ID_HEADER, requestId);

    const url = new URL(req.url);
    if (trace.apiKey && shouldLogPath(url.pathname)) {
      // Fehlerantworten werden GEKLONT, bevor Next.js den Body ausliefert — nur bei
      // status >= 400 (Ruling: dort liegt der Debug-Wert; sonst waeren es Kilobytes
      // Listenrauschen). Der Klon wird synchron erzeugt, gelesen wird er im Hintergrund.
      const errorClone = res.status >= 400 ? res.clone() : null;
      const key = trace.apiKey;
      void (async () => {
        const responseBody = errorClone ? await errorClone.text().catch(() => null) : null;
        let errorCode: string | null = null;
        if (responseBody) {
          try {
            const parsed = JSON.parse(responseBody) as { error?: { code?: unknown } };
            if (typeof parsed.error?.code === "string") errorCode = parsed.error.code;
          } catch {
            // Nicht-JSON-Fehlerantwort (z. B. PDF-Route) — kein Code ableitbar
          }
        }
        await logApiRequest({
          orgId: key.orgId,
          apiKeyId: key.id,
          requestId,
          method: req.method.toUpperCase(),
          path: url.pathname,
          query: url.search ? url.search.slice(1) : null,
          status: res.status,
          durationMs: Date.now() - startedAt,
          errorCode,
          ip: clientIpFromHeaders(req.headers),
          userAgent: req.headers.get("user-agent"),
          requestBody: trace.rawBody || null,
          responseBody,
        });
      })().catch(() => {
        // Protokollieren darf die Anfrage nie kippen (Global Constraint).
      });
    }
    return res;
  };
  Object.defineProperty(wrapped, WITH_API_MARKER, { value: true, enumerable: false });
  return wrapped;
}
```
Zusätzlich: `ApiContext` um `requestId: string` erweitern und den Modulkommentar (Z. 14–27) um einen Absatz „`ctx.requestId` — dieselbe Kennung wie der `X-Request-Id`-Header und `ApiRequestLog.requestId`" ergänzen.

- [ ] **Step 4: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
Achtung: `test/integration/api-auth.test.ts` und `test/unit/withapi-coverage.test.ts` müssen unverändert grün bleiben — das ist die Regressionsschranke für diesen Umbau.
```bash
git add src/api/auth.ts test/integration/api-log-hook.test.ts
git commit -s -m "feat(api-log): Request-Id auf jeder Antwort und nicht blockierender Log-Hook in withApi (Phase 12d, Task 3)"
```

---

### Task 4: Retention im Cleanup-Job, Session-Routen, Oberfläche

**Files:**
- Modify: `src/domain/scheduler/cleanup.ts:1-38`, `src/app/einstellungen/api/page.tsx`, `test/integration/scheduler-cleanup.test.ts`
- Create: `src/app/api/settings/api-log/route.ts`, `src/app/api/settings/api-log/[id]/route.ts`, `src/components/api-keys/ApiRequestLogPanel.tsx`, `test/integration/api-log-retention.test.ts`

**Befund (verifiziert):** `runCleanupJob(now)` räumt heute `WebhookDelivery` (90 T) und `ApiIdempotency` (24 h) und gibt `{ webhookDeliveriesDeleted, apiIdempotencyDeleted }` zurück; er läuft als letzter Eintrag in `JOB_ORDER` (`src/domain/scheduler/runner.ts:46`). `test/integration/scheduler-cleanup.test.ts` prüft die beiden bestehenden Zweige und nutzt bewusst `toBeGreaterThanOrEqual` statt exakter Zähler (geteilte Test-DB) — dasselbe Muster gilt für den neuen Zweig.

**Ruling (Session-Route):** Die Spec nennt `GET/DELETE /api/settings/api-log`. Die zwei Schalter brauchen ebenfalls einen Schreibpfad; statt einer zweiten Route bekommt dieselbe Datei ein **`PUT`** für `ApiSettings` (Muster: `PUT /api/settings/branding`). Die Detail-Schublade lädt über `GET /api/settings/api-log/[id]`.

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/api-log-retention.test.ts
/**
 * Phase 12d, Task 4 — Retention im bestehenden Cleanup-Job. Eigenes Jahr 2083
 * (Testjahr-Konvention), kein Rechnungsbezug.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { saveApiSettings } from "@/domain/api-log/settings";
import { runCleanupJob } from "@/domain/scheduler/cleanup";

const NOW = new Date("2083-06-15T10:00:00.000Z");
let orgId: string;
let otherOrgId: string;

async function makeRow(org: string, createdAt: Date, status = 200) {
  return dbInternal.apiRequestLog.create({
    data: { orgId: org, apiKeyId: null, requestId: `r-${org}-${createdAt.getTime()}-${Math.random()}`, method: "GET", path: "/api/v1/Invoice", status, durationMs: 5, createdAt },
  });
}

beforeAll(async () => {
  const a = await dbInternal.organization.create({ data: { legalName: "Retention A GmbH", addressLine1: "A 1", postalCode: "10115", city: "Berlin" } });
  const b = await dbInternal.organization.create({ data: { legalName: "Retention B GmbH", addressLine1: "B 1", postalCode: "10115", city: "Berlin" } });
  orgId = a.id;
  otherOrgId = b.id;
});

describe("Retention des Anfrageprotokolls", () => {
  it("loescht Zeilen aelter als retentionDays, laesst juengere und fremde Organisationen stehen", async () => {
    await saveApiSettings(orgId, { logRequests: true, logBodies: false, retentionDays: 7, maxRows: 2000 });
    const old = await makeRow(orgId, new Date(NOW.getTime() - 8 * 24 * 3600 * 1000));
    const fresh = await makeRow(orgId, new Date(NOW.getTime() - 1 * 24 * 3600 * 1000));
    const foreign = await makeRow(otherOrgId, new Date(NOW.getTime() - 2 * 24 * 3600 * 1000));
    const result = await runCleanupJob(NOW);
    expect(result.apiRequestLogsDeleted).toBeGreaterThanOrEqual(1);
    expect(await dbInternal.apiRequestLog.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await dbInternal.apiRequestLog.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await dbInternal.apiRequestLog.findUnique({ where: { id: foreign.id } })).not.toBeNull();
  });

  it("kuerzt auf maxRows und behaelt die NEUESTEN", async () => {
    await dbInternal.apiRequestLog.deleteMany({ where: { orgId } });
    await saveApiSettings(orgId, { logRequests: true, logBodies: false, retentionDays: 90, maxRows: 100 });
    for (let i = 0; i < 250; i++) await makeRow(orgId, new Date(NOW.getTime() - i * 60_000));
    await runCleanupJob(NOW);
    const rows = await dbInternal.apiRequestLog.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
    expect(rows).toHaveLength(100);
    expect(rows[0].createdAt.getTime()).toBe(NOW.getTime());
  });

  it("ohne ApiSettings-Zeile gelten 7 Tage / 2000 Zeilen", async () => {
    const noSettingsOrg = await dbInternal.organization.create({ data: { legalName: "Ohne Settings GmbH", addressLine1: "C 1", postalCode: "10115", city: "Berlin" } });
    const old = await makeRow(noSettingsOrg.id, new Date(NOW.getTime() - 8 * 24 * 3600 * 1000));
    await runCleanupJob(NOW);
    expect(await dbInternal.apiRequestLog.findUnique({ where: { id: old.id } })).toBeNull();
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/api-log-retention.test.ts`.

- [ ] **Step 3: Cleanup-Job erweitern**
  - `CleanupResult` += `apiRequestLogsDeleted: number;`
  - In `runCleanupJob` nach dem `ApiIdempotency`-Block: `const apiRequestLogsDeleted = await purgeApiRequestLogs(now);` und ins Rückgabeobjekt.
  - Modulkommentar um einen dritten Spiegelstrich ergänzen: „`ApiRequestLog`, je Organisation nach `ApiSettings.retentionDays` (Default 7) **und** `maxRows` (Default 2000, die neuesten bleiben) — Phase 12d."
  - `test/integration/scheduler-cleanup.test.ts`: die bestehende Prüfung des `CleanupResult`-Objekts (falls sie auf exakte Schlüssel testet) um `apiRequestLogsDeleted` erweitern — **erst prüfen**, ob dort `toEqual` auf dem ganzen Objekt steht.

- [ ] **Step 4: Session-Routen**
  - `src/app/api/settings/api-log/route.ts`:
    - `GET` — `getActiveOrg()`, `listApiRequestLogs(org.id, Object.fromEntries(new URL(req.url).searchParams))`, Antwort `{ rows, total, limit, offset, settings }` (die Einstellungen mitliefern spart dem Panel eine zweite Anfrage).
    - `PUT` — `saveApiSettings(org.id, await req.json())`, Antwort `{ settings }`; `z.ZodError` → 400 mit `issues` (Muster: `PUT /api/settings/branding`).
    - `DELETE` — `clearApiRequestLogs(org.id)`, Antwort `{ deleted }`.
    - `export const dynamic = "force-dynamic"` und `runtime = "nodejs"` wie in den Nachbarrouten.
  - `src/app/api/settings/api-log/[id]/route.ts`: `GET` → `findApiRequestLog(org.id, id)`, 404 wenn `null`.
- [ ] **Step 5: Oberfläche**
  - `ApiRequestLogPanel.tsx` (Client, ≤ 230 Zeilen, Muster `WebhooksManager.tsx`):
    - Kopf: zwei Schalter („Anfragen protokollieren", „Bodies mitschreiben" — Letzterer nur aktivierbar, wenn der erste an ist), zwei Zahlenfelder (`retentionDays` 1–90, `maxRows` 100–20000), „Speichern" (`PUT`) und „Protokoll leeren" (`DELETE`, mit `ConfirmDialog` aus Phase 12a).
    - Unter den Schaltern der Datenschutz-Hinweis wörtlich: „Standardmäßig aus. Bodies werden auf 2 KB gekürzt; Felder mit Namen wie token, secret, password, apiKey, iban oder bic werden vor dem Speichern geschwärzt. Antwort-Bodies werden nur bei Fehlern (Status ≥ 400) gespeichert. Der Authorization-Header wird nie gespeichert."
    - Filterzeile: Schlüssel-Auswahl (`<select>` aus `initialKeys`), Haken „nur Fehler (≥ 400)", Pfad-Teilstring, Zeitraum von/bis (`type="date"`) — jede Änderung lädt per `GET` neu.
    - Tabelle: Zeit (`toLocaleString("de-DE")`), Methode, Pfad, Status (grün < 400, amber 4xx, rose 5xx), Dauer in ms, Schlüsselname. Klick auf eine Zeile öffnet die Detail-Schublade (`<aside>` rechts, kein `<dialog>`) mit Request-Id, vollem Pfad + Query, IP, User-Agent, beiden Bodies in `<pre>` und dem Hinweis „gekürzt", wenn `bodyTruncated`.
    - Leerzustand: „Noch keine Anfragen protokolliert." bzw. bei ausgeschaltetem Protokoll „Das Protokoll ist ausgeschaltet."
  - `src/app/einstellungen/api/page.tsx`: unter dem bestehenden `<section>` „API-Schluessel" eine zweite `<section>` „Anfrageprotokoll" mit `<ApiRequestLogPanel initialSettings={…} initialKeys={keys.map(k => ({ id: k.id, name: k.name }))} />`; `loadApiSettings(org.id)` zum bestehenden Laden hinzufügen.

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build`
```bash
git add src/domain/scheduler/cleanup.ts src/app/api/settings/api-log src/components/api-keys src/app/einstellungen/api/page.tsx test/integration/api-log-retention.test.ts test/integration/scheduler-cleanup.test.ts
git commit -s -m "feat(api-log): Retention im Cleanup-Job, Session-Routen und Oberflaeche in Einstellungen -> API (Phase 12d, Task 4)"
```

---

### Task 5: Lesende REST-Ressource, MCP-Tool, Doku, Smoke, Gesamtprüfung

**Files:**
- Modify: `src/api/openapi.ts:97-113` (`RESOURCE_SCHEMAS`), `src/mcp/tools/system.ts`, `docs/API.md`, `docs/MCP.md`, `docs/ANLEITUNG.md`, `docs/LIMITATIONEN.md`, `docs/ARCHITEKTUR.md`, `COMPLIANCE.md`, `openapi/openapi.json`
- Create: `src/app/api/v1/ApiRequestLog/route.ts`, `src/app/api/v1/ApiRequestLog/[id]/route.ts`, `src/api/serializers/api-request-log.ts`, `test/integration/api-log-resource.test.ts`

**Befund (verifiziert):** `discoverRouteSpecs()` scannt `src/app/api/v1/**/route.ts` und **wirft**, wenn eine Route keinen `spec`-Export hat — beide neuen Dateien brauchen ihn zwingend. `RouteSpec.method` kennt nur `GET | POST | PATCH` (`src/api/spec.ts:32`); die Ressource ist ohnehin nur lesend. `RESOURCE_SCHEMAS` ist eine handgepflegte Zuordnung `objectName → Zod-Schema` und braucht einen Eintrag, damit die OpenAPI-Antwort nicht `z.unknown()` bleibt. Vorbild für Route + Serialisierer ist `EmailLog` (ebenfalls nur GET).

**Ruling (Selbstbezug):** `/api/v1/ApiRequestLog` steht in `UNLOGGED_PATHS` — sonst erzeugt jeder Abruf des Protokolls eine neue Protokollzeile. Der Test unten prüft das.

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/api-log-resource.test.ts
/** Phase 12d, Task 5 — lesende REST-Ressource. Eigenes Jahr 2084 (Testjahr-Konvention). */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { saveApiSettings } from "@/domain/api-log/settings";
import { GET as listGet } from "@/app/api/v1/ApiRequestLog/route";
import { GET as oneGet } from "@/app/api/v1/ApiRequestLog/[id]/route";

let orgId: string;
let token: string;
let rowId: string;

function req(url: string, withToken = true) {
  const headers = new Headers();
  if (withToken) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { headers });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Protokoll-API GmbH", addressLine1: "Apiweg 1", postalCode: "10115", city: "Berlin", vatId: "DE844444444", taxNumber: "84/444/44444" },
  });
  orgId = org.id;
  token = (await createApiKey(orgId, { name: "Leser", scopes: ["read"], expiresAt: null })).token;
  await saveApiSettings(orgId, { logRequests: true, logBodies: false, retentionDays: 7, maxRows: 2000 });
  const row = await dbInternal.apiRequestLog.create({
    data: { orgId, apiKeyId: null, requestId: "req-2084-1", method: "GET", path: "/api/v1/Invoice", status: 500, durationMs: 12 },
  });
  rowId = row.id;
});

beforeEach(() => resetRateLimits());

describe("GET /api/v1/ApiRequestLog", () => {
  it("liefert die Zeilen der eigenen Organisation im Listen-Umschlag und filtert auf Fehler", async () => {
    const res = await listGet(req("http://x/api/v1/ApiRequestLog?limit=10"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.total).toBeGreaterThanOrEqual(1);
    expect(j.data[0].objectName).toBe("ApiRequestLog");
    expect(j.limit).toBe(10);
    const err = await (await listGet(req("http://x/api/v1/ApiRequestLog?errorsOnly=true"))).json();
    expect(err.data.every((r: { status: number }) => r.status >= 400)).toBe(true);
  });

  it("erzeugt selbst KEINE Protokollzeile (Rekursionsschutz)", async () => {
    const before = await dbInternal.apiRequestLog.count({ where: { orgId } });
    await listGet(req("http://x/api/v1/ApiRequestLog"));
    await new Promise((r) => setTimeout(r, 100));
    expect(await dbInternal.apiRequestLog.count({ where: { orgId } })).toBe(before);
  });

  it("ohne Token -> 401", async () => {
    expect((await listGet(req("http://x/api/v1/ApiRequestLog", false))).status).toBe(401);
  });
});

describe("GET /api/v1/ApiRequestLog/[id]", () => {
  it("liefert eine Zeile, unbekannte Id -> 404", async () => {
    const ok = await oneGet(req(`http://x/api/v1/ApiRequestLog/${rowId}`), { params: Promise.resolve({ id: rowId }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.requestId).toBe("req-2084-1");
    expect((await oneGet(req("http://x/api/v1/ApiRequestLog/gibtsnicht"), { params: Promise.resolve({ id: "gibtsnicht" }) })).status).toBe(404);
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/api-log-resource.test.ts`.

- [ ] **Step 3: Serialisierer und beide Routen**
  - `src/api/serializers/api-request-log.ts` nach dem Vorbild `email-log.ts`: `import "../openapi-zod-init";` zuerst, `serializeApiRequestLog(l)` mit `objectName: "ApiRequestLog" as const` und allen Feldern (`createdAt` über `iso()`), dazu das gleichnamige `apiRequestLogSchema`.
  - `src/app/api/v1/ApiRequestLog/route.ts` (Vorbild `EmailLog/route.ts`):
    ```ts
    export const GET = withApi(async (req, ctx) => {
      const { searchParams } = new URL(req.url);
      const result = await listApiRequestLogs(ctx.orgId, Object.fromEntries(searchParams));
      return apiList(result.rows.map(serializeApiRequestLog), result);
    }, { scope: "read" });

    export const spec = {
      list: {
        path: "/api/v1/ApiRequestLog",
        method: "GET",
        summary: "Anfrageprotokoll auflisten (Filter: apiKeyId, errorsOnly, path, from/to)",
        scope: "read",
        request: { query: apiRequestLogFilterSchema },
        response: apiListResponseSchema(z.unknown()),
        errors: [400, 401, 403, 429],
      },
    } satisfies Record<string, RouteSpec>;
    ```
  - `src/app/api/v1/ApiRequestLog/[id]/route.ts`: `findApiRequestLog`, bei `null` `throw new NotFoundError("Protokolleintrag nicht gefunden.")` (→ 404 über `mapApiError`), sonst `apiData(serializeApiRequestLog(row))`; eigener `spec`-Export mit `path: "/api/v1/ApiRequestLog/{id}"` und `errors: [401, 403, 404, 429]`.
  - `src/api/openapi.ts`: Import von `apiRequestLogSchema` und Eintrag `ApiRequestLog: apiRequestLogSchema` in `RESOURCE_SCHEMAS`.
- [ ] **Step 4: MCP-Tool `list_api_requests`**

In `src/mcp/tools/system.ts` (nach `get_status`), Muster der übrigen Listen-Tools:
```ts
server.registerTool(
  "list_api_requests",
  {
    title: "API-Anfrageprotokoll",
    description:
      "Listet protokollierte REST-API-Anfragen (Phase 12d) zur Fehlersuche: Zeit, Methode, Pfad, Status, Dauer, Schluessel. Das Protokoll ist standardmaessig AUS (Einstellungen -> API); ohne Einschaltung ist die Liste leer. Bodies erscheinen nur, wenn zusaetzlich 'Bodies mitschreiben' aktiv ist — gekuerzt auf 2 KB und mit geschwaerzten Geheimnissen.",
    inputSchema: {
      apiKeyId: z.string().optional(),
      errorsOnly: z.boolean().optional(),
      path: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  },
  async (args): Promise<Result> => {
    try {
      const org = await ctx.requireOrg();
      const result = await listApiRequestLogs(org.id, args);
      return ctx.ok(JSON.stringify(result, null, 2));
    } catch (e) {
      if (e instanceof ToolError) return ctx.fail(e.message);
      return ctx.failUnknown(e);
    }
  },
);
```

- [ ] **Step 5: Doku**
  - **API.md:** neuer Abschnitt „Anfrageprotokoll": `X-Request-Id` auf **jeder** Antwort (auch auf Fehlern) und identisch mit `ApiRequestLog.requestId`; `GET /api/v1/ApiRequestLog` + `/{id}` (Scope `read`, nur lesend — kein Schreiben/Löschen über die API); Filterparameter; **ausdrücklich**: Anfragen, die die Authentifizierung nicht passieren (401 mit unbekanntem Schlüssel, Vor-Auth-429), werden **nicht** protokolliert; `/api/docs`, `/api/v1/openapi.json`, `/api/v1/ping` und die Protokollroute selbst ebenfalls nicht.
  - **MCP.md:** `list_api_requests` in die Werkzeugliste.
  - **ANLEITUNG.md:** „Einstellungen → API → Anfrageprotokoll" — einschalten, Fehler nachvollziehen, Detail öffnen, leeren; Warnung, dass „Bodies mitschreiben" Kundendaten in die Protokolltabelle schreibt.
  - **LIMITATIONEN.md:** drei Sätze — (1) „Vor-Auth-Fehler (unbekannter Schlüssel, Vor-Auth-Rate-Limit) werden nicht protokolliert — es gibt keine Organisation, der sie zuzuordnen wären." (2) „Nur `/api/v1/*` wird protokolliert; Session-Routen des UI nicht." (3) „Die Retention läuft im Scheduler-Cleanup — ohne aktiven Scheduler wächst die Tabelle bis zum nächsten Lauf."
  - **ARCHITEKTUR.md:** `src/domain/api-log/*` in die Modulübersicht, der Hinweis „kein ChangeLog-Eintrag (Audit-Ruling K5)".
  - **COMPLIANCE.md** §13/§18: „Umsetzung dieser Software"-Absatz — Datenminimierung (aus per Default, zwei Schalter, 2-KB-Grenze, Schwärzung, Retention 7 Tage/2000 Zeilen), keine neue Datenkategorie (die Bodies gehören der Organisation, die sie selbst gesendet/empfangen hat), Löschknopf im UI.

- [ ] **Step 6: Playwright-Smoke** (Skill `webapp-testing`; `npm run dev` im Vordergrund, Seed-Login `admin@example.com` / `demo1234`; Screenshots nach `<scratchpad>/ui-previews/12d-*.png`):
  1. Einstellungen → API: Anfrageprotokoll einschalten, „Bodies mitschreiben" ebenfalls, speichern.
  2. Einen API-Schlüssel mit Scope `read` anlegen und per `curl`/`fetch` **zwei** Anfragen absetzen: `GET /api/v1/Invoice` (200) und `GET /api/v1/Invoice/gibtsnicht` (404).
  3. Seite neu laden → beide Zeilen erscheinen, die 404-Zeile ist farbig markiert; Filter „nur Fehler" lässt nur sie stehen.
  4. Detail der 404-Zeile öffnen → Request-Id, Pfad, Antwort-Body mit `NOT_FOUND` sichtbar; die 200-Zeile hat **keinen** Antwort-Body.
  5. „Protokoll leeren" → Tabelle leer; Protokoll wieder ausschalten.
  Konsolenfehler protokollieren; kein CI-Gate.

- [ ] **Step 7: Gesamtprüfung + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check`
`api:check` schlägt an (neue Routen) ⇒ `npm run api:check -- --write`, Diff mitcommitten, erneut prüfen. Mit Docker zusätzlich `bash scripts/test-postgres-migrations.sh`.
```bash
git add src/app/api/v1/ApiRequestLog src/api docs COMPLIANCE.md src/mcp/tools/system.ts openapi/openapi.json test/integration/api-log-resource.test.ts
git commit -s -m "feat(api-log): lesende REST-Ressource, MCP-Tool list_api_requests und Doku (Phase 12d, Task 5)"
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. **Nie blockierend, nie kippend:** `logApiRequest` wird ausschließlich als `void (...)().catch(() => {})` **nach** dem Bau der Antwort gestartet; sein Rumpf ist selbst in `try/catch` gefasst. Der Testfall „ein Fehler beim Protokollieren verändert die Antwort nicht" ist grün. Kein `await` auf den Log-Schreibvorgang im Anfragepfad.
2. **Body nur einmal gelesen:** `grep -n "req.text()\|req.json()" src/api/auth.ts` zeigt weiterhin genau **einen** Treffer; das Protokoll benutzt `trace.rawBody`. Der Handler-Vertrag im Modulkommentar („NIE erneut `req.text()`") gilt unverändert.
3. **Request-Id:** auf Erfolg **und** Fehler gesetzt, identisch mit `ApiRequestLog.requestId`, im Handler als `ctx.requestId` verfügbar. Auch die Idempotenz-Replay-Antwort trägt den Header (alle drei Rückgabepunkte laufen durch `run()`).
4. **Sparsamkeit (Rulings):** Standard aus (`DEFAULT_API_SETTINGS`); Request-Bodies nur bei `logBodies`; Response-Bodies **nur** bei `status >= 400` — im Code sichtbar daran, dass `res.clone()` unter `res.status >= 400` steht; beide auf 2048 Byte; `bodyTruncated` gesetzt; `Authorization` nirgends gespeichert (`grep -rn "authorization" src/domain/api-log/` trifft nur das Redaktionsmuster).
5. **Rauschfilter und Rekursion:** `/api/docs`, `/api/v1/openapi.json`, `/api/v1/ping` und `/api/v1/ApiRequestLog` erzeugen keine Zeile (Testfälle vorhanden). `shouldLogPath` prüft exakt-oder-mit-Slash, nicht `startsWith` allein.
6. **Vor-Auth:** ohne `trace.apiKey` wird nichts geschrieben — ein 401 mit unbekanntem Token und ein Vor-Auth-429 hinterlassen keine Zeile, und das steht so in `docs/API.md` und LIMITATIONEN.
7. **Retention:** kein neuer Scheduler-Job — `runCleanupJob` bekommt einen dritten Zweig und bleibt letzter Eintrag in `JOB_ORDER`. Der Trim behält die **neuesten** `maxRows` (stabile Sortierung über `createdAt` **und** `id`), arbeitet in 1000er-Blöcken und lässt fremde Organisationen unberührt. Ohne `ApiSettings`-Zeile gelten 7 Tage / 2000 Zeilen.
8. **GoBD/Audit:** `grep -rn "appendChangeLog" src/domain/api-log/` ist leer — das Protokoll ist kein Belegereignis (Audit-Ruling K5). Interne Notizen (§48) erscheinen nur dann in einer Zeile, wenn der Betreiber sie selbst im Request gesendet hat.
9. **Migration:** beide `migration.sql` wirkungsgleich (2 Tabellen, 3 Indizes + 1 Unique); `schema.prisma`/`schema.postgres.prisma` unterscheiden sich weiterhin nur in der `provider`-Zeile; **alle** `43`-Zusicherungen in `scripts/test-postgres-migrations.sh` stehen auf `45`, Fall 20 prüft Tabellen, Indizes und Defaults.
10. **Schnittstellen:** `openapi/openapi.json` regeneriert (`npm run api:check` grün); `RESOURCE_SCHEMAS` kennt `ApiRequestLog`; beide neuen Routen exportieren `spec` (sonst wirft `discoverRouteSpecs`); `test/unit/withapi-coverage.test.ts` bleibt grün; die Ressource ist **nur** lesend (kein POST/PATCH/DELETE).
11. **Bestand:** `test/integration/api-auth.test.ts` (Auth/Scope/Rate-Limit/Idempotenz/Fehlerformat) läuft unverändert durch — der `run()`-Umbau hat keine bestehende Logikzeile verändert (Diff gegen den Branch-Punkt gegenlesen).
12. **Smoke:** Screenshots zeigen die Tabelle mit einer 200- und einer 404-Zeile, den Fehlerfilter, die Detail-Schublade mit Request-Id und Fehler-Body sowie das geleerte Protokoll. Betreiberfrage: „Siehst du die fehlgeschlagenen Anfragen mit genug Kontext — und ohne Datenmüll?"
