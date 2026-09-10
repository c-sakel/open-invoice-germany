# Phase 13d — Belegvorlagen und Tags

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wiederkehrende Belege lassen sich als **Belegvorlage** speichern und mit zwei Klicks zu einem neuen Entwurf machen; Belege lassen sich mit **Tags** ordnen und danach filtern — in der Oberfläche, über die REST-API v1 und über MCP. Drei neue Tabellen, zwei Migrationspaare (SQLite + handgeschrieben Postgres), sechs REST-Routen, acht MCP-Werkzeuge. Tags sind Metadaten: an festgeschriebenen Belegen erlaubt, nie im PDF, nie im XML, nie in einer Kunden-Mail, nie im öffentlichen Angebotslink.

**Architecture:** Fünf Schichten, streng getrennt. (1) Datenmodell: `DocumentTemplate` (Stammdaten mit `payloadJson` als Zod-validiertem String — **kein** `Json`-Typ, Portabilitätsregel des Schemakopfs), `Tag` und `DocumentTag` (polymorph `docType`+`docId` wie `DocumentAttachment`/`ActivityLog`, bewusst ohne Prisma-Relation auf Invoice/Quote/DeliveryNote). (2) Zod an jeder Grenze: `src/schemas/{tag,template}.ts` — dieselben Schemas für Server-Actions, REST und MCP. (3) Domain: `src/domain/tag/*` und `src/domain/template/*`; `applyTemplate` erzeugt Belege **ausschließlich** über `createDraftInvoice`/`createBusinessDocument`/`createDeliveryNote` — kein zweiter Erzeugungspfad, kein Bypass von `assertAllowedTaxRates`. (4) Oberfläche: `/vorlagen`, `/einstellungen/tags`, Tag-Chips in Liste und Belegkarte, Tag-Filter als `FilterBar`-Feld (13a-Konfiguration). (5) Schnittstellen: sechs `route.ts` unter `src/app/api/v1` (Discovery-Pflicht: `spec`-Export) plus zwei MCP-Module.

**Tech Stack:** Next.js App Router, Prisma (SQLite + Postgres, keine Enums, kein `Json`, kein `Decimal`), Zod, `@asteasolutions/zod-to-openapi`, MCP-SDK, Vitest (`environment: "node"`, **kein RTL**), Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-10-phase-13-listen-editor-beleg-design.md` — Paket **D** (Abschnitt 2: „Vorlagen: Modell/Domain", „Tags: Modell/Wirkung", „Tag-Filter", „UI-Orte", „API + MCP"), Struktur Abschnitt 3 Block D + Migrationsabsatz, Tests Abschnitt 4 D, Teilphase 4 in Abschnitt 5, Ruling „Tags sind Metadaten".

## Global Constraints

- Branch `phase-13d/vorlagen-tags` aus Fork-`main`, **nach dem Merge von 13c**. Jeder Commit mit `git commit -s`.
- **Setzt 13a und 13c voraus:** die `FilterBar`-Feldliste (13a) nimmt das Tag-Feld als reine Konfiguration auf, die Belegkarte „Details" (13c) die Tag-Chips; `TEMPLATE_SAVE` aus `availableActions` (13a) wird **hier** zum ersten Mal gerendert. **Keine neue Abhängigkeit.**
- **GoBD (§51):** Tags und Vorlagen sind **keine** Belegdaten. Kein Schreibpfad dieser Phase fasst eine Spalte von `Invoice`/`InvoiceLine` an; der Guard in `src/lib/db.ts` bleibt unverändert und wird nicht umgangen. Protokolliert wird im `ActivityLog` (Audit-Ruling K5), **nie** im `ChangeLog` — die `@@unique([orgId, prevHash])`-Serialisierung gilt hier nicht.
- **§48 + Ruling „Tags sind Metadaten":** `saveTemplateFromDocument` entfernt `internalNotes` **aktiv** aus dem Payload (nicht nur „zeigt es nicht an"). Tagnamen erscheinen in keinem PDF, keinem XRechnung/CII-XML, keinem Mailtext und in keinem öffentlichen Angebotslink — je ein Testfall.
- **Kein Bypass (§50/§55):** `applyTemplate` ruft `createDraftInvoice` / `createBusinessDocument` / `createDeliveryNote` (die öffentlichen Einstiege, **nicht** die `…WithinTx`-Varianten mit fremder Transaktion) — damit laufen `assertAllowedTaxRates`, Nummernvergabe, Snapshots, Textvorlagen-Selbstheilung und Pflichthinweis-Logik unverändert. **Migration (§53):** zwei Paare, rein additiv, keine Bestandsdaten betroffen, nichts Destruktives. Beide Schemadateien pflegen (CI `schema-drift`: `schema.prisma` und `schema.postgres.prisma` dürfen sich weiterhin **nur** in der `provider`-Zeile unterscheiden — `diff prisma/schema.prisma prisma/schema.postgres.prisma` zeigt genau eine Hunk-Stelle). Anwenden mit `npx prisma migrate deploy` (`db:migrate` ist interaktiv).
- **Drei neue Tabellen ⇒ jede `45`-Zusicherung in `scripts/test-postgres-migrations.sh` wird zu `48`** (8 numerische Vergleiche + 16 Meldungstexte, `grep -n 45 scripts/test-postgres-migrations.sh`). Keine Phase-7-Tabelle betroffen ⇒ keine Regex-Ausklammerung in Fall 9.
- **Nichts doppelt bauen (§1.4):** `TextTemplate`/`EmailTemplate` (Textbausteine) und `duplicate.ts` bleiben, wie sie sind — eine Belegvorlage ist etwas anderes und ersetzt keines von beidem. `withApi`, `apiData`/`apiList`, `SettingsTabs`, `ActionMenu`, `FilterBar` werden erweitert bzw. genutzt, nicht kopiert. TypeScript strict, kein `any`; Prisma nur mit `select`/`include`; Dateien ≤ ~250 Zeilen; deutsche UI-Texte mit echten Umlauten; Fremdanbieternamen nirgends.
- Prüfkette vor jedem Commit **im Vordergrund**: `npm run typecheck && npm run lint && TZ=UTC npm test`. Vor dem letzten Commit zusätzlich `npm run build`, `npm run validate:erechnung` und `npm run api:check`. Bestandstests bleiben grün (§1.7), besonders `test/unit/openapi.test.ts`, `test/unit/withapi-coverage.test.ts`, `test/integration/api-resources.test.ts`.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `prisma/schema.prisma`, `prisma/schema.postgres.prisma` | `model DocumentTemplate`, `model Tag`, `model DocumentTag` + 3 Rückrelationen auf `Organization` |
| `prisma/migrations{,-postgres}/…_phase13d_templates|_tags/migration.sql` | DDL (3 Tabellen, 3 Uniques, 3 Indizes, 3 FKs) |
| `scripts/test-postgres-migrations.sh` | Fall 22 (Vorlagen), Fall 23 (Tags), alle `45` → `48` |
| `src/schemas/tag.ts`, `src/schemas/template.ts` | neu — `tagInputSchema`, `tagAssignSchema`, `documentTemplate*Schema`, `applyTemplateSchema` |
| `src/domain/tag/{manage,assign,list}.ts` | neu — CRUD, Zuordnen/Entfernen (idempotent), `tagsForDocuments`, `docIdsForTag` |
| `src/domain/template/{save,apply,list}.ts` | neu — `saveTemplateFromDocument`, `applyTemplate`, `listTemplates` |
| `src/domain/activity/log.ts`, `src/domain/{invoice,document}/list.ts`, `src/schemas/index.ts` | vier neue `ACTIVITY_TYPES`, `tag`-Filter in den drei Listenschemas |
| `src/app/vorlagen/page.tsx`, `src/app/einstellungen/tags/page.tsx`, `src/lib/nav.ts` | neue Seiten + Navigation |
| `src/components/tags/{TagChips,TagPicker,TagManager}.tsx`, `src/components/templates/SaveTemplateDialog.tsx` | neu |
| `src/app/api/v1/DocumentTemplate/**`, `src/app/api/v1/Tag/**` | sieben REST-Routen (`read`/`write`) |
| `src/api/spec.ts`, `src/api/openapi.ts`, `src/api/serializers/{document-template,tag}.ts`, `openapi/openapi.json` | `DELETE` im `RouteSpec`, Schemas, Regeneration |
| `src/mcp/tools/{templates,tags}.ts`, `src/mcp/server.ts`, `docs/{API,MCP,ANLEITUNG,LIMITATIONEN,ARCHITEKTUR}.md` | acht MCP-Werkzeuge, Doku |

---

### Task 1: Datenmodell, zwei Migrationspaare, Postgres-Fälle 22/23

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/schema.postgres.prisma`, `scripts/test-postgres-migrations.sh`
- Create: `prisma/migrations/20260913090000_phase13d_templates/migration.sql`, `prisma/migrations/20260913092000_phase13d_tags/migration.sql`, `prisma/migrations-postgres/20260913090100_phase13d_templates/migration.sql`, `prisma/migrations-postgres/20260913092100_phase13d_tags/migration.sql`

**Befund (verifiziert):** Letzte Migration SQLite `20260912090000_account_holder`, Postgres `20260912090100_account_holder` (SQLite `…9000 0`, Postgres `…90100` — dieselbe Migration, versetzte Zeitstempel). Das Schema kennt **keine** Prisma-Enums, kein `Json`, kein `Decimal` (Schemakopf Z. 1–8). `DocumentAttachment` (`schema.prisma:1036`) ist das Vorbild für eine polymorphe Belegtabelle: `docType`/`docId` als Strings, `org Organization @relation`, `@@unique([orgId, sha256, docType, docId])`, `@@index([orgId, docType, docId])`; die FK-Syntax der beiden Dialekte steht in `prisma/migrations{,-postgres}/2026090318474*_phase4b_editor/migration.sql`. `scripts/test-postgres-migrations.sh` endet mit **Fall 21** (Z. 817–850) und prüft an acht Stellen `= "45"`.

- [ ] **Step 1: Prisma-Modelle (beide Schemadateien, identisch)**

```prisma
/// Belegvorlage (Phase 13d) — STAMMDATEN, kein GoBD-Beleg: `payloadJson` ist ein per
/// `documentTemplatePayloadSchema` validierter Draft-Ausschnitt (Positionen, Texte,
/// Steuerschema, Waehrung, Rabatt/Skonto) OHNE Nummer, Daten, Snapshots, Zahlungen und
/// OHNE internalNotes (§48). Kein Json-Typ (Portabilitaet, Schemakopf).
model DocumentTemplate {
  id          String       @id @default(cuid())
  orgId       String
  org         Organization @relation(fields: [orgId], references: [id])
  name        String
  docType     String // INVOICE | QUOTE | DELIVERY_NOTE
  kind        String? // nur QUOTE: ANGEBOT | AUFTRAGSBESTAETIGUNG | PROFORMA
  customerId  String? // optionale Vorbelegung; kein FK (Kunde darf archiviert/geloescht sein)
  payloadJson String
  usageCount  Int          @default(0)
  lastUsedAt  DateTime?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  @@unique([orgId, name])
  @@index([orgId, docType])
}

/// Tag (Phase 13d) — Ordnungsmerkmal ueber einem Beleg, KEINE Belegdaten: auch an
/// festgeschriebenen Belegen setz-/entfernbar (kein Invoice-Schreibvorgang, Guard in
/// src/lib/db.ts unberuehrt), im ActivityLog statt im ChangeLog protokolliert (K5).
/// `color` ist eine Zod-Aufzaehlung, kein freier Hexwert.
model Tag {
  id        String        @id @default(cuid())
  orgId     String
  org       Organization  @relation(fields: [orgId], references: [id])
  name      String
  color     String        @default("slate")
  createdAt DateTime      @default(now())
  updatedAt DateTime      @updatedAt
  documents DocumentTag[]

  @@unique([orgId, name])
}

/// Zuordnung Tag -> Beleg, polymorph wie DocumentAttachment/ActivityLog (docType+docId,
/// bewusst OHNE Relation auf Invoice/Quote/DeliveryNote — sonst drei Nullable-FKs je Beleg).
/// `orgId` ohne Relationsfeld (ActivityLog-Muster), Loeschen ueber die Kaskade an tagId.
model DocumentTag {
  id        String   @id @default(cuid())
  orgId     String
  tagId     String
  tag       Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)
  docType   String // INVOICE | QUOTE | DELIVERY_NOTE
  docId     String
  createdAt DateTime @default(now())

  @@unique([orgId, tagId, docType, docId])
  @@index([orgId, docType, docId])
  @@index([orgId, tagId])
}
```
`model Organization` bekommt zwei Rückrelationen (`documentTemplates DocumentTemplate[]`, `tags Tag[]`) — `DocumentTag` trägt `orgId` ohne Relation und braucht keine.

- [ ] **Step 2: Migrationen SQLite**

```sql
-- prisma/migrations/20260913090000_phase13d_templates/migration.sql
-- Phase 13d — Belegvorlagen. Eine neue Tabelle, rein additiv, kein Bestandsdatensatz
-- wird angefasst. Stammdaten, kein GoBD-Beleg (kein ChangeLog-Bezug).
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "kind" TEXT,
    "customerId" TEXT,
    "payloadJson" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DocumentTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DocumentTemplate_orgId_name_key" ON "DocumentTemplate"("orgId", "name");
CREATE INDEX "DocumentTemplate_orgId_docType_idx" ON "DocumentTemplate"("orgId", "docType");

-- ────────────────────────────────────────────────────────────────────────────
-- prisma/migrations/20260913092000_phase13d_tags/migration.sql  (zweite SQLite-Migration)
-- Phase 13d — Tags. Zwei neue Tabellen, rein additiv. DocumentTag haengt per
-- ON DELETE CASCADE am Tag: das Loeschen eines Tags entfernt seine Zuordnungen,
-- ruehrt aber keinen Beleg an (Tags sind Metadaten, kein Belegdatum).
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tag_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "DocumentTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Tag_orgId_name_key" ON "Tag"("orgId", "name");
CREATE UNIQUE INDEX "DocumentTag_orgId_tagId_docType_docId_key" ON "DocumentTag"("orgId", "tagId", "docType", "docId");
CREATE INDEX "DocumentTag_orgId_docType_docId_idx" ON "DocumentTag"("orgId", "docType", "docId");
CREATE INDEX "DocumentTag_orgId_tagId_idx" ON "DocumentTag"("orgId", "tagId");
```

- [ ] **Step 3: Migrationen Postgres (handgeschrieben)** — `prisma/migrations-postgres/20260913090100_phase13d_templates/migration.sql` und `…/20260913092100_phase13d_tags/migration.sql`. Spaltenlisten **wörtlich** wie in den beiden SQLite-Dateien oben, mit genau vier Dialektunterschieden (Muster: `prisma/migrations-postgres/20260903184810_phase4b_editor/migration.sql`): (a) `"id" TEXT NOT NULL` ohne `PRIMARY KEY`, stattdessen nach einer Leerzeile `CONSTRAINT "<Tabelle>_pkey" PRIMARY KEY ("id")` als letzter Eintrag; (b) `TIMESTAMP(3)` statt `DATETIME`; (c) kein `CONSTRAINT … FOREIGN KEY` **in** der Tabelle, sondern eigene `ALTER TABLE`-Anweisungen am Dateiende; (d) über jeder Index-/FK-Zeile ein `-- CreateIndex` bzw. `-- AddForeignKey`. Die abweichenden Zeilen wörtlich:

```sql
-- 20260913090100_phase13d_templates
    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_orgId_name_key" ON "DocumentTemplate"("orgId", "name");
-- CreateIndex
CREATE INDEX "DocumentTemplate_orgId_docType_idx" ON "DocumentTemplate"("orgId", "docType");
-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 20260913092100_phase13d_tags
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
    CONSTRAINT "DocumentTag_pkey" PRIMARY KEY ("id")
-- CreateIndex
CREATE UNIQUE INDEX "Tag_orgId_name_key" ON "Tag"("orgId", "name");
-- CreateIndex
CREATE UNIQUE INDEX "DocumentTag_orgId_tagId_docType_docId_key" ON "DocumentTag"("orgId", "tagId", "docType", "docId");
-- CreateIndex
CREATE INDEX "DocumentTag_orgId_docType_docId_idx" ON "DocumentTag"("orgId", "docType", "docId");
-- CreateIndex
CREATE INDEX "DocumentTag_orgId_tagId_idx" ON "DocumentTag"("orgId", "tagId");
-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "DocumentTag" ADD CONSTRAINT "DocumentTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Anwenden und Drift prüfen**

```bash
npx prisma migrate deploy && npx prisma generate
diff prisma/schema.prisma prisma/schema.postgres.prisma   # genau 1 Hunk: provider
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "file:./shadow.db" --exit-code   # muss 0 liefern (kein Drift)
```

- [ ] **Step 5: Postgres-Skript — Fälle 22/23, alle `45` → `48`**

Zuerst global: jede `[ "$COUNTxx" = "45" ]`-Zusicherung und jeder `45 Tabellen`-Text wird `48` (8 + 16 Fundstellen, `grep -n 45 scripts/test-postgres-migrations.sh` muss danach leer sein). Der Erklärtext in Z. 43 bekommt „; Phase 13d: DocumentTemplate, Tag, DocumentTag". Dann zwei neue Fälle am Dateiende, **vor** `echo "ALLE TESTS BESTANDEN"`. Präambel je Fall wörtlich wie Fall 21 (Z. 823–834): Schema droppen, `0_init` einspielen und `migrate resolve`, alle Migrationen **außer der eigenen** per `grep -v -E` überspringen, Bestandszeile anlegen, dann `npx prisma migrate deploy` — hier mit `20260913090100_phase13d_templates` bzw. `20260913092100_phase13d_tags` im Ausschlussmuster.

```bash
echo "==> Fall 22 (Phase 13d): Belegvorlagen — Tabelle, Unique auf (orgId,name), Default usageCount"
# Praeambel woertlich wie Fall 21, Ausschluss '20260913090100_phase13d_templates', Bestandszeile org22.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "DocumentTemplate" ("id","orgId","name","docType","payloadJson","updatedAt")
  VALUES ('tpl22','org22','Wartung monatlich','INVOICE','{"lines":[]}',NOW());
SQL
USAGE=$(psql_tA "select \"usageCount\", coalesce(\"lastUsedAt\"::text,'<null>') from \"DocumentTemplate\" where id='tpl22'")
[ "$USAGE" = "0|<null>" ] || fail "DocumentTemplate-Defaults abweichend ('$USAGE'), erwartet 0|<null>"
DUP=$(psql_tA "insert into \"DocumentTemplate\" (\"id\",\"orgId\",\"name\",\"docType\",\"payloadJson\",\"updatedAt\") values ('tpl22b','org22','Wartung monatlich','QUOTE','{}',NOW())" 2>&1 || true)
echo "$DUP" | grep -q "duplicate key" || fail "Unique (orgId,name) auf DocumentTemplate greift nicht"
COUNT22=$(psql_tA "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT22" = "48" ] || fail "erwartet 48 Tabellen nach Phase 13d/Vorlagen, gefunden $COUNT22"
echo "    ok — DocumentTemplate mit Unique (orgId,name) und usageCount-Default 0, 48 Tabellen"

echo "==> Fall 23 (Phase 13d): Tags — Doppelzuordnung verboten, Cascade beim Tag-Loeschen"
# Praeambel woertlich wie Fall 21, Ausschluss '20260913092100_phase13d_tags', Bestandszeile org23.
docker exec -i "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Tag" ("id","orgId","name","updatedAt") VALUES ('tag23','org23','Wartung',NOW());
INSERT INTO "DocumentTag" ("id","orgId","tagId","docType","docId") VALUES ('dt23','org23','tag23','INVOICE','inv23');
SQL
[ "$(psql_tA "select color from \"Tag\" where id='tag23'")" = "slate" ] || fail "Tag.color-Default ist nicht slate"
DUP2=$(psql_tA "insert into \"DocumentTag\" (\"id\",\"orgId\",\"tagId\",\"docType\",\"docId\") values ('dt23b','org23','tag23','INVOICE','inv23')" 2>&1 || true)
echo "$DUP2" | grep -q "duplicate key" || fail "Unique (orgId,tagId,docType,docId) greift nicht — Doppelzuordnung moeglich"
docker exec "$CONTAINER" psql -U oig -d openinvoice -q -c "DELETE FROM \"Tag\" WHERE id='tag23'" >/dev/null
LEFT=$(psql_tA "select count(*) from \"DocumentTag\" where \"tagId\"='tag23'")
[ "$LEFT" = "0" ] || fail "Cascade fehlt: nach dem Tag-Loeschen bleiben $LEFT Zuordnungen"
COUNT23=$(psql_tA "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT23" = "48" ] || fail "erwartet 48 Tabellen nach Phase 13d/Tags, gefunden $COUNT23"
echo "    ok — Tag/DocumentTag mit Unique und ON DELETE CASCADE, 48 Tabellen"
```
> `psql_tA "<sql>"` steht hier für das im Skript durchgehend verwendete `docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "<sql>"` — beim Einfügen ausschreiben, **keine** neue Hilfsfunktion einführen.

- [ ] **Step 6: Gate + Commit** — `scripts/test-postgres-migrations.sh` läuft **> 15 min** und wird vom Werkzeug automatisch in den Hintergrund verschoben (CLAUDE.md): starten, auf die Notification warten, Ergebnis prüfen. Docker-Daemon vorher starten.

```bash
npm run typecheck && npm run lint && TZ=UTC npm test
bash scripts/test-postgres-migrations.sh   # -> Hintergrund, auf Notification warten
git add -A && git commit -s -m "feat(db): Belegvorlagen und Tags — Datenmodell und Migrationen

Phase 13d, Task 1. DocumentTemplate, Tag und DocumentTag in beiden Schemadateien, je
ein handgeschriebenes Migrationspaar (SQLite + Postgres), rein additiv; PG-Skript mit
Faellen 22/23 und Tabellenzahl 45 -> 48."
```

---

### Task 2: Zod-Schemas und Tag-Domain

**Files:**
- Create: `src/schemas/tag.ts`, `src/domain/tag/{manage,assign,list}.ts`, `test/unit/tag-schemas.test.ts`, `test/integration/tags.test.ts` · Modify: `src/domain/activity/log.ts`, `src/schemas/index.ts` (Re-Export)

**Befund (verifiziert):** `logActivity` (`src/domain/activity/log.ts:60 ff.`) wirft nie und nimmt `tx` **oder** `dbInternal`; `ActivityEntityType` kennt bereits `INVOICE | QUOTE | DELIVERY_NOTE | CUSTOMER | RECURRING | API_KEY` — für Tags genügen **neue `type`-Werte**, kein neuer `entityType`. Der Guard in `src/lib/db.ts` schützt ausschließlich `invoice`, `invoiceLine` und `finalInvoiceDeduction`; Schreibvorgänge auf `documentTag` über den geschützten `prisma`-Client sind also unbedenklich und trotzdem mandantengeprüft.

**Interfaces:**
```ts
// src/schemas/tag.ts
export const TagColor = z.enum(["slate", "rose", "amber", "emerald", "sky", "indigo", "violet", "stone"]);
export const TagDocType = z.enum(["INVOICE", "QUOTE", "DELIVERY_NOTE"]);
export const tagInputSchema = z.object({ name: z.string().trim().min(1).max(40), color: TagColor.default("slate") });
export const tagAssignSchema = z.object({ docType: TagDocType, docId: z.string().min(1) });

// src/domain/tag/manage.ts — listTags liefert je Tag die Zuordnungszahl mit
export class TagNameConflictError extends Error {}
export async function listTags(orgId: string): Promise<TagRow[]>;
export async function saveTag(orgId: string, id: string | null, raw: unknown): Promise<Tag>;
export async function deleteTag(orgId: string, id: string): Promise<{ removedAssignments: number }>;
// src/domain/tag/assign.ts — idempotent, ActivityLog, NIE ChangeLog
export async function tagDocument(orgId: string, tagId: string, raw: unknown, actor?: string): Promise<{ created: boolean }>;
export async function untagDocument(orgId: string, tagId: string, raw: unknown, actor?: string): Promise<{ removed: boolean }>;
// src/domain/tag/list.ts
export async function tagsForDocuments(orgId: string, docType: TagDocType, docIds: string[]): Promise<Map<string, TagRow[]>>;
export async function docIdsForTag(orgId: string, tagId: string, docType: TagDocType): Promise<string[]>; // take: TAG_FILTER_LIMIT
export const TAG_FILTER_LIMIT = 10_000;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/tags.test.ts (Auszug — der Kern, an dem die Phase haengt)
it("Tag an einer FESTGESCHRIEBENEN Rechnung setzen und entfernen ist erlaubt", async () => {
  const inv = await finalizeInvoice(/* Helfer wie in test/integration/invoice-route.test.ts */);
  const before = await dbInternal.changeLog.count({ where: { orgId } });
  const stamp = (await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { updatedAt: true } })).updatedAt;
  await tagDocument(orgId, tag.id, { docType: "INVOICE", docId: inv.id });
  await untagDocument(orgId, tag.id, { docType: "INVOICE", docId: inv.id });
  expect(await dbInternal.changeLog.count({ where: { orgId } })).toBe(before);        // kein ChangeLog
  const acts = await dbInternal.activityLog.findMany({ where: { orgId, entityId: inv.id, type: { in: ["TAG_ADDED", "TAG_REMOVED"] } } });
  expect(acts).toHaveLength(2);                                                        // ActivityLog +2
  const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { updatedAt: true } });
  expect(after.updatedAt.getTime()).toBe(stamp.getTime());                             // Beleg unberuehrt
});

it("tag_document ist idempotent, Tag-Loeschen entfernt die Zuordnungen", async () => {
  expect((await tagDocument(orgId, tag.id, ref)).created).toBe(true);
  expect((await tagDocument(orgId, tag.id, ref)).created).toBe(false);
  expect((await deleteTag(orgId, tag.id)).removedAssignments).toBe(1);
  expect(await dbInternal.documentTag.count({ where: { orgId } })).toBe(0);
});

it("gleicher Name in zwei Organisationen ok, doppelt in einer nicht", async () => {
  await saveTag(orgB, null, { name: "Wartung" });                                      // ok
  await expect(saveTag(orgId, null, { name: "Wartung" })).rejects.toBeInstanceOf(TagNameConflictError);
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/tags.test.ts test/unit/tag-schemas.test.ts`.

- [ ] **Step 3: `ACTIVITY_TYPES` erweitern** — vier Einträge (Reihenfolge egal, Anzeigetexte deutsch): `TAG_ADDED: "Tag gesetzt"`, `TAG_REMOVED: "Tag entfernt"`, `TEMPLATE_SAVED: "Als Belegvorlage gespeichert"`, `TEMPLATE_APPLIED: "Aus Belegvorlage erzeugt"`. `buildTimeline` (`src/domain/timeline/build.ts`) liest die Tabelle und braucht keine weitere Änderung — prüfen, dass dort kein `switch` mit erschöpfender Aufzählung steht; falls doch, die vier Fälle ergänzen.

- [ ] **Step 4: Domain schreiben** — `saveTag`/`deleteTag` nach dem Muster `src/domain/payment-method/manage.ts` (eigene Fehlerklasse statt rohem P2002-Text, `dbInternal.$transaction`). `tagDocument` prüft zuerst `tag.findFirst({ where: { id, orgId } })` (Mandantenschutz) **und** die Existenz des Belegs im jeweiligen Modell, dann `createMany`-frei per `upsert` auf dem Unique — Rückgabe `created: false`, wenn die Zeile schon existierte (idempotent, kein Fehler, kein zweiter ActivityLog-Eintrag). `logActivity` mit `entityType = docType`, `entityId = docId`, `data = { tagId, name }`. `docIdsForTag` mit `take: TAG_FILTER_LIMIT` und `select: { docId: true }`.

- [ ] **Step 5: Gate + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test
git add -A && git commit -s -m "feat(tags): Zod-Schemas und Tag-Domain (setzen, entfernen, verwalten)

Phase 13d, Task 2. Tags sind Metadaten: auch an festgeschriebenen Belegen setzbar, kein
Invoice-Schreibvorgang, kein ChangeLog (ActivityLog, K5); tag_document idempotent,
Tag-Loeschen entfernt die Zuordnungen per Kaskade."
```

---

### Task 3: Vorlagen-Domain (speichern, anwenden, auflisten)

**Files:**
- Create: `src/schemas/template.ts`, `src/domain/template/{save,apply,list}.ts`, `test/unit/template-schemas.test.ts`, `test/integration/templates.test.ts` (keine weiteren Dateien)

**Befund (verifiziert):** Die öffentlichen Erzeugungseinstiege heißen `createDraftInvoice(orgId, input, opts)` (`src/domain/invoice/create.ts:238`), `createBusinessDocument(orgId, rawInput, opts)` (`src/domain/document/create.ts:213` — **nicht** „createDocument", die Spec-Kurzform meint diese Funktion) und `createDeliveryNote(orgId, …)` (`src/domain/delivery-note/create.ts:214`); alle drei rufen intern `assertAllowedTaxRates` und wickeln ihre eigene Transaktion. Die Eingabeformen sind `createInvoiceSchema` (`src/schemas/index.ts:373`, Kopffelder ab Z. 335), `createDocumentSchema` (Z. 482) und `createDeliveryNoteSchema` (Z. 681, Zeilen ohne `discount*`/`taxCategory`). `duplicate.ts` zeigt, welche Felder eine Kopie übernimmt und welche nicht (Nummer, Snapshots, Zahlungen bleiben weg) — dieselbe Auswahl gilt hier, **zusätzlich** entfällt `internalNotes` (§48).

**Interfaces:**
```ts
// src/schemas/template.ts
export const documentTemplatePayloadSchema = z.object({
  customerId: z.string().min(1).optional(),
  currency: z.string().length(3).optional(),
  taxScheme: TaxScheme.optional(),
  subject: z.string().max(200).optional(),
  headerText: z.string().max(5000).optional(),
  footerText: z.string().max(5000).optional(),
  notes: z.string().optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  paymentMethodId: z.string().optional(),
  // Rabatt/Aufschlag/Skonto: dieselben Grenzen wie documentAdjustmentFields/skontoFields
  // in src/schemas/index.ts (Phase 4a) — hier ausnahmslos optional.
  documentDiscountPermille: PERMILLE, documentDiscountCents: CENTS,
  documentChargePermille: PERMILLE, documentChargeCents: CENTS,
  documentChargeReason: z.string().max(500).optional(),
  skonto1Permille: PERMILLE_MIN1, skonto1Days: DAYS, skonto2Permille: PERMILLE_MIN1, skonto2Days: DAYS,
  lines: z.array(invoiceLineInputSchema).min(1),
}).strict();   // internalNotes, number, issueDate, Snapshots sind hier NICHT zulaessig (§48)
// PERMILLE = int 0..1000 optional; CENTS = int >=0 optional; PERMILLE_MIN1 = int 1..1000 optional; DAYS = int 1..365 optional

export const documentTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  docType: TagDocType,                       // INVOICE | QUOTE | DELIVERY_NOTE
  kind: z.enum(["ANGEBOT", "AUFTRAGSBESTAETIGUNG", "PROFORMA"]).optional(),
  customerId: z.string().min(1).nullable().optional(),
  payload: documentTemplatePayloadSchema,
});
export const saveTemplateFromDocumentSchema = z.object({ docType: TagDocType, docId: z.string().min(1), name: z.string().trim().min(1).max(80) });
export const applyTemplateSchema = z.object({ customerId: z.string().min(1).optional() });

// src/domain/template/{save,apply,list}.ts
export class TemplateNameConflictError extends Error {}
export class TemplateCustomerRequiredError extends Error {}
export async function saveTemplateFromDocument(orgId: string, raw: unknown, actor?: string): Promise<DocumentTemplate>;
export async function applyTemplate(orgId: string, templateId: string, raw: unknown, actor?: string): Promise<{ docType: TagDocType; id: string }>;
export async function listTemplates(orgId: string, docType?: TagDocType): Promise<TemplateRow[]>;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/templates.test.ts (Auszug)
it("speichert den GESPEICHERTEN Beleg ohne Nummer, Daten, Snapshots und ohne internalNotes", async () => {
  const inv = await createDraftInvoice(orgId, { ...base, internalNotes: "NIE IN DIE VORLAGE", subject: "Wartung" });
  const tpl = await saveTemplateFromDocument(orgId, { docType: "INVOICE", docId: inv.id, name: "Wartung" });
  expect(tpl.payloadJson).not.toContain("NIE IN DIE VORLAGE");
  const p = documentTemplatePayloadSchema.parse(JSON.parse(tpl.payloadJson));
  expect(p.subject).toBe("Wartung");
  expect(p.lines).toHaveLength(inv.lines.length);
  expect(Object.keys(p)).not.toContain("number");
});

it("erzeugt daraus einen Entwurf mit denselben Positionen und Summen", async () => {
  const res = await applyTemplate(orgId, tpl.id, { customerId: kunde.id });
  const neu = await dbInternal.invoice.findUniqueOrThrow({ where: { id: res.id }, include: { lines: true } });
  expect(neu).toMatchObject({ status: "DRAFT", number: null, internalNotes: null, grossTotalCents: inv.grossTotalCents });
  expect(await dbInternal.activityLog.count({ where: { orgId, entityId: neu.id, type: "TEMPLATE_APPLIED" } })).toBe(1);
});

it("laeuft durch assertAllowedTaxRates — gesperrter Steuersatz wird NICHT still uebernommen", async () => {
  await saveDocumentSettings(orgId, { taxRatesJson: "[19,0]" });   // 7 % gesperrt
  await expect(applyTemplate(orgId, tplMit7.id, { customerId: kunde.id })).rejects.toThrow(/Steuersatz/i);
});

it("zaehlt Nutzung fort und weist unbekannte Payload-Felder ab", () => {
  expect(documentTemplatePayloadSchema.safeParse({ lines: [line], internalNotes: "x" }).success).toBe(false);
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/templates.test.ts test/unit/template-schemas.test.ts`.

- [ ] **Step 3: `save.ts`** — liest den **gespeicherten** Beleg (`dbInternal.invoice|quote|deliveryNote.findFirst({ where: { id, orgId }, include: { lines: … } })`, nie einen Client-Draft), baut den Payload nach der Feldauswahl von `duplicate.ts` **minus** `internalNotes`, `number`, `issueDate`/`dueDate`/`validUntil`, `*SnapshotJson`, `payments`, `dunning*`, validiert ihn mit `documentTemplatePayloadSchema` (zweite Verteidigungslinie) und schreibt ihn als `JSON.stringify` in `payloadJson`. P2002 auf `(orgId, name)` → `TemplateNameConflictError`. `logActivity({ entityType: docType, entityId: docId, type: "TEMPLATE_SAVED" })`.

- [ ] **Step 4: `apply.ts`** — `documentTemplatePayloadSchema.parse(JSON.parse(tpl.payloadJson))`, Kunde aus `raw.customerId ?? tpl.customerId ?? payload.customerId`; fehlt er, `TemplateCustomerRequiredError` (kein Beleg ohne Empfänger). Dann **genau ein** Aufruf je `docType`:
  - `INVOICE` → `createDraftInvoice(orgId, { ...payload, customerId })`; `QUOTE` → `createBusinessDocument(orgId, { ...payload, customerId, kind: tpl.kind ?? "ANGEBOT" })`.
  - `DELIVERY_NOTE` → `createDeliveryNote(orgId, { customerId, headerText, footerText, notes, lines: payload.lines.map(toDeliveryNoteLine) })` — `toDeliveryNoteLine` bildet auf `deliveryNoteLineInputSchema` ab (description, articleNumber, quantityMilli, unit, unitNetPriceCents, taxRate; `discount*`/`taxCategory` kennt der Lieferschein nicht).
  - `usageCount`/`lastUsedAt` danach in einem **eigenen** `update` (die Erzeugung wickelt ihre eigene Transaktion; ein fehlgeschlagener Zähler darf den erzeugten Beleg nicht zurückrollen, ein fehlgeschlagener Beleg zählt nie hoch). `logActivity({ entityType: docType, entityId: neu.id, type: "TEMPLATE_APPLIED", data: { templateId } })`.

- [ ] **Step 5: Gate + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test
git add -A && git commit -s -m "feat(vorlagen): Belegvorlagen speichern, anwenden, auflisten

Phase 13d, Task 3. saveTemplateFromDocument entfernt Nummer, Daten, Snapshots und
internalNotes (§48); applyTemplate erzeugt Entwuerfe ausschliesslich ueber
createDraftInvoice/createBusinessDocument/createDeliveryNote (kein Steuersatz-Bypass)."
```

---

### Task 4: Oberfläche — /vorlagen, /einstellungen/tags, Chips, Tag-Filter

**Files:**
- Create: `src/app/vorlagen/page.tsx`, `src/app/einstellungen/tags/page.tsx`, `src/components/tags/{TagChips,TagPicker,TagManager}.tsx`, `src/components/templates/SaveTemplateDialog.tsx`, `src/app/actions/tags.ts`, `src/app/actions/templates-doc.ts`
- Modify: `src/lib/nav.ts`, `src/schemas/index.ts` (`invoiceListFilterSchema` + `tag`), `src/domain/document/list.ts` (`quoteListFilterSchema`/`deliveryNoteListFilterSchema` + `tag`), `src/domain/invoice/list.ts`, `src/domain/document/neighbors.ts` (`ALLOWED_KEYS` += `tag`), die drei Listenseiten, die drei Detailseiten

**Befund (verifiziert):** `SETTINGS_KEYS`/`SETTINGS_ITEMS` (`src/lib/nav.ts:34/98`) sind die einzige Quelle der Einstellungsreiter (`SettingsTabs` leitet daraus ab) — ein neuer Schlüssel `"tags"` zwischen `"kundenfelder"` und `"benachrichtigungen"` genügt. `NAV_GROUPS.verkauf` (Z. 60) nimmt `/vorlagen` auf. `listInvoices` baut sein `where` als `and`-Array (`src/domain/invoice/list.ts:103 ff.`), `listQuotes`/`listDeliveryNotes` genauso — der Tag-Filter ist dort **eine** zusätzliche Bedingung `and.push({ id: { in: await docIdsForTag(...) } })`. `ALLOWED_KEYS` (`src/domain/document/neighbors.ts:22`) begrenzt, welche Filter „Zurück zur Liste" überlebt.

- [ ] **Step 1: Failing test schreiben** — `test/integration/tag-filter.test.ts`:

```ts
it("?tag=<id> liefert genau die zugeordneten Belege, fremde Organisation nie", async () => {
  await tagDocument(orgId, tag.id, { docType: "INVOICE", docId: a.id });
  expect((await listInvoices(orgId, { tag: tag.id })).rows.map((r) => r.id)).toEqual([a.id]);
  expect((await listInvoices(orgB, { tag: tag.id })).rows).toHaveLength(0);
  // ohne Zuordnung leer statt ungefiltert:
  expect((await listInvoices(orgId, { tag: leererTag.id })).rows).toHaveLength(0);
});
it("tag ueberlebt den Sprung Detailseite -> Zurueck zur Liste", () => {
  expect(ALLOWED_KEYS).toContain("tag");
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/tag-filter.test.ts`.

- [ ] **Step 3: Filter verdrahten** — `tag: z.string().min(1).optional()` in alle drei Filterschemas; in den drei `list*`-Funktionen **vor** dem `count`/`findMany`: `if (filter.tag) and.push({ id: { in: await docIdsForTag(orgId, filter.tag, "<DOCTYPE>") } })` — eine leere Menge ergibt bewusst `id: { in: [] }` (leere Liste), niemals „Filter ignoriert". `ALLOWED_KEYS` um `tag` erweitern. In den drei Listenseiten das `FilterBar`-Feld `{ type: "select", name: "tag", label: "Tag", options: … }` aus `listTags(org.id)` ergänzen (13a-Feldliste, reine Konfiguration).

- [ ] **Step 4: Seiten und Komponenten**
  - `/einstellungen/tags`: `SettingsTabs active="tags"`, `TagManager` (Client) mit Anlegen (Name + Farbe aus `TagColor`), Umbenennen, Löschen mit Bestätigung („entfernt den Tag von N Belegen") über Server-Actions in `src/app/actions/tags.ts` (`revalidatePath`). `/vorlagen`: Tabelle Art/Name/Kunde/zuletzt genutzt/Nutzungen mit „Beleg erzeugen" (ruft `applyTemplate`, leitet auf den Entwurf weiter), Umbenennen, Löschen.
  - `TagChips` (Server): farbige Chips; `TagPicker` (Client): Auswahlfeld + „Tag hinzufügen" über dieselben Server-Actions. Eingebaut in die Belegkarte „Details" (13c) und — nur `TagChips` — unter der Belegnummer in den drei Listenzeilen (Batch über `tagsForDocuments` für die ganze Seite, **kein N+1**).
  - `SaveTemplateDialog`: `<dialog>` (`w-full max-w-*`) mit Namensfeld, im „Mehr"-Menü von Beleg **und** Listenzeile, sichtbar genau dann, wenn `availableActions(...)` `TEMPLATE_SAVE` enthält (13a).

- [ ] **Step 5: Gate + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test
git add -A && git commit -s -m "feat(ui): /vorlagen, /einstellungen/tags, Tag-Chips und Tag-Filter

Phase 13d, Task 4. Tag-Filter als eine zusaetzliche where-Bedingung in allen drei Listen
(leere Zuordnung = leere Liste, nie ungefiltert), Chips ueber einen Batch-Query je Seite,
'Als Vorlage speichern' ueber availableActions."
```

---

### Task 5: REST-Ressourcen v1 und OpenAPI

**Files:**
- Create: `src/api/serializers/{document-template,tag}.ts`, `src/app/api/v1/DocumentTemplate/{route.ts,[id]/route.ts,[id]/apply/route.ts}`, `src/app/api/v1/Tag/{route.ts,[id]/route.ts,[id]/assign/route.ts,[id]/unassign/route.ts}`, `test/integration/template-tag-resources.test.ts` · Modify: `src/api/spec.ts`, `src/api/openapi.ts`, `openapi/openapi.json`

**Befund (verifiziert):** `RouteSpec.method` (`src/api/spec.ts:31`) kennt heute nur `"GET" | "POST" | "PATCH"`, und `openapi.ts:440` castet auf `"get" | "post" | "patch"` — für `DELETE /api/v1/Tag/{id}` muss **beides** um `"delete"` wachsen. `withApi` parst einen Body nur für `POST|PATCH|PUT` (`src/api/auth.ts:60`, `BODY_METHODS`). **Ruling:** das Entfernen einer Zuordnung wird deshalb `POST /api/v1/Tag/{id}/unassign` (Body `{docType, docId}`) statt „DELETE mit Body" — die Spec-Schreibweise `POST/DELETE …/assign` meint diese beiden Wege; `DELETE` bleibt dem bodylosen Löschen des Tags selbst vorbehalten. `discoverRouteSpecs` wirft bei jeder `route.ts` ohne `spec`-Export; `test/unit/withapi-coverage.test.ts` verlangt für **jede** exportierte HTTP-Methode den `withApi`-Marker.

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/template-tag-resources.test.ts (Auszug, Muster: api-resources.test.ts)
it("Tag: Round-Trip anlegen -> zuordnen -> lesen -> entfernen -> loeschen", async () => {
  const created = await call(POST_Tag, { body: { name: "Wartung", color: "emerald" } });
  expect(created.status).toBe(201);
  const id = created.json.data.id;
  const ref = { docType: "INVOICE", docId: inv.id };
  expect((await call(POST_Assign, { params: { id }, body: ref })).status).toBe(200);
  expect((await call(GET_Tag, { params: { id } })).json.data.objectName).toBe("Tag");
  expect((await call(POST_Unassign, { params: { id }, body: ref })).json.data.removed).toBe(true);
  expect((await call(DELETE_Tag, { params: { id } })).status).toBe(200);
});

it("Vorlage anwenden liefert den neuen Entwurf; read darf nicht schreiben", async () => {
  const res = await call(POST_Apply, { params: { id: tpl.id }, body: { customerId: kunde.id } });
  expect(res.status).toBe(201);
  expect(res.json.data).toMatchObject({ objectName: "DocumentTemplateApplication", docType: "INVOICE" });
  expect((await call(POST_Tag, { scope: "read", body: { name: "X" } })).status).toBe(403);
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/template-tag-resources.test.ts`.

- [ ] **Step 3: `RouteSpec` um `DELETE` erweitern** — `method: "GET" | "POST" | "PATCH" | "DELETE"` in `src/api/spec.ts`; in `openapi.ts` den Cast auf `"get" | "post" | "patch" | "delete"` erweitern. Die `successStatus`-Ableitung (`openapi.ts:406`) bleibt unverändert: `DELETE` liefert `200` mit `{ data: { deleted: true } }`.

- [ ] **Step 4: Serialisierer und sieben Routen** — `serializeTag`/`tagSchema` und `serializeDocumentTemplate`/`documentTemplateSchema` nach dem Muster `src/api/serializers/text-template.ts` (`objectName`-Literal, `iso()` für Datumsfelder; `payloadJson` wird **nicht** roh ausgeliefert, sondern als geparstes `payload`-Objekt). `RESOURCE_SCHEMAS` in `openapi.ts` um `DocumentTemplate` und `Tag` ergänzen. Routen exakt wie `TextTemplate/route.ts` gebaut (`withApi(..., { scope })`, `apiData`/`apiList`, `spec`-Export mit `summary`, `errors`), Domainfehler auf `InvalidOperationError`/`NotFoundError` abbilden:

| Route | Methoden | Scope |
|---|---|---|
| `/api/v1/DocumentTemplate` | GET (Liste, Filter `docType`), POST (`documentTemplateInputSchema`) | read / write |
| `/api/v1/DocumentTemplate/{id}` | GET, PATCH (Name/Kunde/Payload), DELETE | read / write |
| `/api/v1/DocumentTemplate/{id}/apply` | POST (`applyTemplateSchema`) → 201 | write |
| `/api/v1/Tag` | GET, POST (`tagInputSchema`) | read / write |
| `/api/v1/Tag/{id}` | GET, PATCH, DELETE | read / write |
| `/api/v1/Tag/{id}/assign`, `/unassign` | POST (`tagAssignSchema`) | write |

- [ ] **Step 5: OpenAPI regenerieren + Gate + Commit**

```bash
npm run api:check     # regeneriert openapi/openapi.json, muss driftfrei enden
npm run typecheck && npm run lint && TZ=UTC npm test
git add -A && git commit -s -m "feat(api): REST-Ressourcen fuer Belegvorlagen und Tags

Phase 13d, Task 5. Sieben Routen unter /api/v1 mit spec-Export, Serialisierern und
Scopes; RouteSpec kennt jetzt DELETE. Zuordnen/Entfernen als POST assign/unassign, weil
withApi nur bei POST/PATCH/PUT einen Body parst. openapi.json regeneriert."
```

---

### Task 6: MCP-Werkzeuge, Doku, Smoke, Gesamtprüfung

**Files:**
- Create: `src/mcp/tools/{templates,tags}.ts`, `test/integration/mcp-templates-tags.test.ts` · Modify: `src/mcp/server.ts`, `docs/{API,MCP,ANLEITUNG,LIMITATIONEN,ARCHITEKTUR}.md`

**Befund (verifiziert):** `src/mcp/server.ts` registriert 14 `register*Tools(server, mcpContext)`-Module (Z. 54–67); Tests greifen über `server["_registeredTools"][name].handler` zu. `McpToolsContext` (`src/mcp/tools/context.ts:286`) liefert `requireOrg`, `ok`/`fail`/`failUnknown`, `ToolError` und `resolveDocForAttachment(orgId, docType, ref)` — genau die Auflösung „Belegnummer **oder** Id", die `tag_document` braucht (`DocRefType` ist dort weiter gefasst als `TagDocType`; der Tag-Pfad prüft zusätzlich auf die drei erlaubten Typen).

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/mcp-templates-tags.test.ts (Auszug)
const tool = (n: string) => (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<Result> }> })._registeredTools[n];

const NAMES = ["list_templates", "create_template_from_document", "apply_template", "list_tags", "create_tag", "delete_tag", "tag_document", "untag_document"];
it("acht Werkzeuge sind registriert", () => NAMES.forEach((n) => expect(tool(n)).toBeDefined()));

it("tag_document akzeptiert die Belegnummer und ist idempotent", async () => {
  const ref = { tag: "Wartung", docType: "INVOICE", docId: "RE-1001" };
  expect((await tool("tag_document").handler(ref)).isError).toBeFalsy();
  expect((await tool("tag_document").handler(ref)).isError).toBeFalsy();   // idempotent, kein Fehler
  expect(await dbInternal.documentTag.count({ where: { orgId } })).toBe(1);
});

it("apply_template erzeugt einen Entwurf und nennt seine Id", async () => {
  expect((await tool("apply_template").handler({ template: "Wartung monatlich", customer: "Mustermann GmbH" })).isError).toBeFalsy();
  expect(await dbInternal.invoice.count({ where: { orgId, status: "DRAFT" } })).toBe(1);
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/mcp-templates-tags.test.ts`.

- [ ] **Step 3: Werkzeuge schreiben** — Muster `src/mcp/tools/attachments.ts`: `server.registerTool(name, { title, description, inputSchema }, handler)`, im Handler `ctx.requireOrg()`, Auflösung über `ctx.resolveDocForAttachment` bzw. eine Namensauflösung Tag/Vorlage (Name **oder** Id, bei Mehrdeutigkeit `ToolError` mit lesbarem deutschem Text), Aufruf **derselben** Domainfunktion wie REST und UI, `ctx.ok(...)`/`ctx.fail(...)`, `catch (e) { if (e instanceof ToolError) …; return ctx.failUnknown(e); }`. Registrierung in `server.ts` nach `registerWebhookTools`.

- [ ] **Step 4: Doku**
  - `docs/API.md`: die sieben Routen mit Scopes und Beispiel-Body, ausdrücklich mit dem Hinweis, dass `assign`/`unassign` beide `POST` sind. `docs/MCP.md`: die acht Werkzeuge in der Tabelle. `docs/ARCHITEKTUR.md`: drei Tabellen + zwei Domain-Ordner in der Übersicht.
  - `docs/ANLEITUNG.md`: „Belegvorlagen" und „Tags" (Anlegen, Beleg daraus erzeugen, Filtern) — mit dem Satz, dass Tags rein intern sind und nie beim Kunden ankommen.
  - `docs/LIMITATIONEN.md`: **Obergrenze 10 000 zugeordnete Belege je Tag-Filter** (`TAG_FILTER_LIMIT`, darüber ist die Liste unvollständig) — zusammen mit dem bestehenden `statusCounts`-Punkt; Vorlagen speichern **keine** Anhänge, keine internen Notizen und keinen Kundenbezug außer der optionalen Vorbelegung; eine Vorlage ist ein Schnappschuss und ändert sich nicht mit dem Ursprungsbeleg.

- [ ] **Step 5: Playwright-Smoke** (Skill `webapp-testing`; `npm run dev` im Vordergrund, Seed-Login `admin@example.com` / `demo1234`; Screenshots einzeln nach `<scratchpad>/ui-previews/13d-*.png`):
  1. Rechnung → „Mehr" → „Als Vorlage speichern" → `/vorlagen` zeigt sie → „Beleg erzeugen" → Entwurf mit denselben Positionen.
  2. `/einstellungen/tags`: Tag anlegen → auf einer **festgeschriebenen** Rechnung setzen → Chip in Belegkarte und Listenzeile → `?tag=` filtert → PDF derselben Rechnung öffnen: Tagname taucht **nicht** auf → Tag löschen → Chip weg, Rechnung unverändert.

- [ ] **Step 6: Gesamtprüfung + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check
git add -A && git commit -s -m "feat(mcp): Werkzeuge fuer Belegvorlagen und Tags, Doku, Smoke

Phase 13d, Task 6. Acht MCP-Werkzeuge auf denselben Domainfunktionen und Zod-Schemas wie
REST und UI. API/MCP/ANLEITUNG/LIMITATIONEN/ARCHITEKTUR fortgeschrieben (Obergrenze
10 000 Belege je Tag-Filter)."
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. **GoBD:** `git diff main -- src/lib/db.ts` leer; kein Schreibpfad der Phase fasst eine `Invoice`-Spalte an; Integrationstest belegt ChangeLog unverändert, `Invoice.updatedAt` unverändert, `ActivityLog` +2.
2. **§48/Tags nach außen:** je ein Test, dass Tagname und Vorlagenname **nicht** in PDF, XRechnung, CII, Mailtext und öffentlichem Angebotslink erscheinen; `saveTemplateFromDocument` entfernt `internalNotes` aktiv (Payload-Schema ist `.strict()`).
3. **Kein zweiter Erzeugungspfad:** `applyTemplate` ruft ausschließlich `createDraftInvoice`/`createBusinessDocument`/`createDeliveryNote`; `git grep -n "prisma.invoice.create\|quote.create(" src/domain/template` ist leer. Gesperrter Steuersatz ⇒ Fehler statt stillem Bypass.
4. **Migrationen:** vier Dateien, rein additiv; `diff prisma/schema.prisma prisma/schema.postgres.prisma` zeigt nur die `provider`-Zeile; `prisma migrate diff --exit-code` driftfrei; `scripts/test-postgres-migrations.sh` grün mit den Fällen 22/23 und **48** Tabellen (`grep -n 45 scripts/…` leer).
5. **Schnittstellen:** `npm run api:check` driftfrei; `test/unit/openapi.test.ts` und `test/unit/withapi-coverage.test.ts` grün (jede der sieben Routen mit `spec`-Export und `withApi`-Marker); MCP-Werkzeuge nutzen dieselben Zod-Schemas wie REST.
6. **Keine Attrappe / Querschnitt:** Tag-Filter mit leerer Zuordnung liefert eine leere Liste (nie „ungefiltert"), `TEMPLATE_SAVE` ist verdrahtet, Tag-Chips kommen aus **einem** Batch-Query je Seite (kein N+1). Zuletzt: `typecheck`, `lint`, `TZ=UTC npm test`, `build`, `validate:erechnung`, `api:check` grün; Bestandstests unverändert.
