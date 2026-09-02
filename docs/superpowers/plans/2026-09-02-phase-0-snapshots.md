# Phase 0 — Beleg-Snapshots und interne Notizen · Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHES SUB-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`. Schritte nutzen Checkbox-Syntax (`- [ ]`).

**Ziel:** Festgeschriebene Rechnungen und nummerierte Geschäftsdokumente rendern dauerhaft mit den Käufer-/Verkäuferdaten ihres Entstehungszeitpunkts; Bestandsbelege werden per Migration eingefroren; ein internes Notizfeld erreicht nie PDF/XML; `docs/ARCHITEKTUR.md` stimmt mit dem Code überein.

**Architektur:** Je ein serialisierter JSON-String pro Partei (`sellerSnapshotJson`, `buyerSnapshotJson`) plus Herkunft und Zeitpunkt auf `Invoice` und `Quote`. Geschrieben in `finalizeWithinTx` (Rechnung) und `createBusinessDocument` (Dokument). `buildEInvoiceData`/`buildDocEInvoiceData` lesen den Snapshot per Zod mit Fallback auf die Relation. Backfill als SQL in einer eigenen Migration je Provider. `internalNotes` als neues Feld, das strukturell nicht in `EInvoiceData` gelangt.

**Tech-Stack:** Prisma 6.19.3 (SQLite + PostgreSQL, zwei Migrationsverzeichnisse), Zod 4, Next.js 16, Vitest, pdfkit.

**Spec:** `docs/superpowers/specs/2026-09-02-phase-0-snapshots-design.md` (Branch `specs`; Kopie im Scratchpad `plan/`)

## Globale Randbedingungen

- Branch `phase-0/snapshots` aus dem Integrationsbranch `main` des Forks (nach Merge von `fix/postgres-migrations`)
- Jeder Commit mit DCO-Signoff: `git commit -s`; Commit-Messages ohne Umlaute; keine Co-Authored-By-/Claude-Session-Zeilen
- Code-Kommentare und Doku **deutsch**; TypeScript strict, kein `any`
- **Beide** Schemadateien identisch pflegen: `prisma/schema.postgres.prisma` wird nach jeder Änderung an `prisma/schema.prisma` per `sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma > prisma/schema.postgres.prisma` abgeleitet
- Jede Schemaänderung: SQLite-Migration (`npm run db:migrate -- --name …`) **und** Postgres-Migration (`npm run db:migrate:pg -- --name …`, braucht Wegwerf-Postgres, siehe CONTRIBUTING.md)
- Geld Integer-Cent, kein Float; Zod an jeder Boundary; GoBD-Guard in `src/lib/db.ts` nicht umgehen
- `Invoice.notes` und `validateMandatoryFields` bleiben unverändert
- Vor jedem Commit grün: `npm run typecheck`, `npm run lint`, `npm test`; vor dem letzten Commit zusätzlich `npm run build`, `npm run validate:erechnung`, `./scripts/test-postgres-migrations.sh`
- Bestehende Tests dürfen nicht brechen (Lastenheft 1.7)

## Verifizierte Fakten

1. `finalizeWithinTx(tx, invoiceId, opts)` in `src/domain/invoice/finalize.ts` ist der einzige Festschreibungspfad; `cancel.ts`, `credit.ts`, `recurring/run.ts` rufen ihn. Er lädt `org: true, customer: true`. Der atomare Status-Claim ist ein `tx.invoice.updateMany({ where: { id, status: "DRAFT" }, data: {...} })`.
2. `createBusinessDocument(orgId, input, opts)` in `src/domain/document/create.ts` lädt den Kunden nur mit `select: { id: true }` und die Organisation gar nicht.
3. `MapInput.org` (mapper.ts) hat exakt: legalName, addressLine1, addressLine2, postalCode, city, country, vatId, taxNumber, email, phone, electronicAddress, iban, bic, bankName. `MapInput.customer`: name, contactName, addressLine1, addressLine2, postalCode, city, countryCode, vatId, email, leitwegId.
4. `DocInput` (pdf-data.ts) ist eine Teilmenge davon (org ohne electronicAddress, customer ohne leitwegId).
5. `test/global-setup.ts` löscht `prisma/test.db` und führt `npx prisma migrate deploy` (SQLite) aus — neue SQLite-Migrationen laufen automatisch in den Tests.
6. `scripts/test-postgres-migrations.sh` Fall 2 simuliert die Bestands-DB per `prisma db push` mit dem **aktuellen** Schema, Fall 3 erwartet `No pending migrations`. Beides wird durch Phase 0 falsch (siehe Task 5).
7. Formulare: `NewInvoiceForm.tsx` hält `notes` als `useState` (Z. 47), baut das Payload mit `notes: finalNotes` (Z. 81), rendert die Textarea Z. 190. `NewDocumentForm.tsx`: State Z. 34, Payload Z. 62, Textarea Z. 158. Detailseiten rendern `notes` in `rechnungen/[id]/page.tsx:199` und `dokumente/[id]/page.tsx:109`.
8. SQLite-Migrationen sind handgeschriebenes SQL mit `"Tabelle"`/`"spalte"`-Quoting; DateTime-Spalten heißen `DATETIME` und nutzen `CURRENT_TIMESTAMP`.

---

### Task 1: Schema, Zod, Snapshot-Builder, Migrationen

**Dateien:**
- Ändern: `prisma/schema.prisma` (Invoice, Quote)
- Ändern: `prisma/schema.postgres.prisma` (abgeleitet)
- Ändern: `src/schemas/index.ts`
- Erstellen: `src/domain/snapshot.ts`
- Erstellen: `prisma/migrations/<ts>_phase0_snapshots_internal_notes/migration.sql` (generiert)
- Erstellen: `prisma/migrations/<ts>_phase0_backfill_snapshots/migration.sql` (handgeschrieben)
- Erstellen: `prisma/migrations-postgres/<ts>_phase0_snapshots_internal_notes/migration.sql` (generiert)
- Erstellen: `prisma/migrations-postgres/<ts>_phase0_backfill_snapshots/migration.sql` (handgeschrieben)
- Test: `test/unit/snapshot.test.ts`

**Schnittstellen:**
- Erzeugt: `buildSellerSnapshot(org)`, `buildBuyerSnapshot(customer)`, `parseSellerSnapshot(json, fallback, ctx)`, `parseBuyerSnapshot(json, fallback, ctx)` aus `src/domain/snapshot.ts`; Zod `sellerSnapshotSchema`, `buyerSnapshotSchema`, `SnapshotSource` aus `src/schemas/index.ts`. Task 2 und 3 konsumieren sie.

- [ ] **Schritt 1: Failing Unit-Test schreiben**

`test/unit/snapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sellerSnapshotSchema, buyerSnapshotSchema } from "@/schemas";
import { buildSellerSnapshot, buildBuyerSnapshot, parseSellerSnapshot, parseBuyerSnapshot } from "@/domain/snapshot";

const org = {
  legalName: "Muster GmbH", addressLine1: "Weg 1", addressLine2: null, postalCode: "12345", city: "Ort",
  country: "DE", vatId: "DE123456789", taxNumber: null, email: "a@b.de", phone: null,
  electronicAddress: null, iban: "DE00", bic: null, bankName: null,
};
const customer = {
  name: "Kunde AG", contactName: "Frau X", addressLine1: "Str. 2", addressLine2: null, postalCode: "54321",
  city: "Stadt", countryCode: "DE", vatId: null, email: "k@x.de", leitwegId: null,
};

describe("Snapshot-Builder und -Schemas", () => {
  it("Builder-Ausgabe besteht das Zod-Schema", () => {
    expect(sellerSnapshotSchema.safeParse(buildSellerSnapshot(org)).success).toBe(true);
    expect(buyerSnapshotSchema.safeParse(buildBuyerSnapshot(customer)).success).toBe(true);
  });

  it("Schluesselmengen entsprechen exakt den Mapper-Eingaben", () => {
    expect(Object.keys(buildSellerSnapshot(org)).sort()).toEqual(Object.keys(org).sort());
    expect(Object.keys(buildBuyerSnapshot(customer)).sort()).toEqual(Object.keys(customer).sort());
  });

  it("parse bevorzugt einen gueltigen Snapshot", () => {
    const json = JSON.stringify({ ...buildSellerSnapshot(org), legalName: "Alt GmbH" });
    expect(parseSellerSnapshot(json, org, "inv-1").legalName).toBe("Alt GmbH");
  });

  it("parse faellt bei ungueltigem Snapshot auf die Relation zurueck", () => {
    expect(parseSellerSnapshot("{nicht json", org, "inv-1")).toEqual(org);
    expect(parseBuyerSnapshot(JSON.stringify({ name: 1 }), customer, "inv-1")).toEqual(customer);
    expect(parseBuyerSnapshot(null, customer, "inv-1")).toEqual(customer);
  });
});
```

- [ ] **Schritt 2: Test ausführen, Fehlschlag bestätigen**

Ausführen: `npx vitest run test/unit/snapshot.test.ts`
Erwartet: FAIL — Modul `@/domain/snapshot` und Schemas existieren nicht.

- [ ] **Schritt 3: Zod-Schemas ergänzen**

In `src/schemas/index.ts` nach der Zeile `export const PaymentMethod = z.enum([...]);` einfügen:

```ts
// ── Beleg-Snapshots (Phase 0) ────────────────────────────────────────────────
// Feldgenau identisch mit MapInput.org / MapInput.customer in src/lib/einvoice/mapper.ts.
// Ein Unit-Test prueft die Schluesselmengen gegeneinander.
export const SnapshotSource = z.enum(["FINALIZE", "CREATE", "MIGRATION"]);
export type SnapshotSource = z.infer<typeof SnapshotSource>;

export const sellerSnapshotSchema = z.object({
  legalName: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  country: z.string(),
  vatId: z.string().nullable(),
  taxNumber: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  electronicAddress: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  bankName: z.string().nullable(),
});
export type SellerSnapshot = z.infer<typeof sellerSnapshotSchema>;

export const buyerSnapshotSchema = z.object({
  name: z.string(),
  contactName: z.string().nullable(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  countryCode: z.string(),
  vatId: z.string().nullable(),
  email: z.string().nullable(),
  leitwegId: z.string().nullable(),
});
export type BuyerSnapshot = z.infer<typeof buyerSnapshotSchema>;
```

- [ ] **Schritt 4: Snapshot-Builder anlegen**

`src/domain/snapshot.ts`:

```ts
/**
 * Beleg-Snapshots: Kaeufer- und Verkaeuferdaten zum Zeitpunkt der Festschreibung
 * (Rechnung) bzw. Erstellung (Geschaeftsdokument). Ohne Snapshot wuerde eine
 * spaetere Stammdatenaenderung PDF und XRechnung festgeschriebener Belege
 * rueckwirkend veraendern (GoBD, Lastenheft 29/50).
 *
 * Reine Funktionen — kein DB-Zugriff. Die Objekte entsprechen feldgenau den
 * Eingaben von buildEInvoiceData (src/lib/einvoice/mapper.ts).
 */
import { sellerSnapshotSchema, buyerSnapshotSchema, type SellerSnapshot, type BuyerSnapshot } from "@/schemas";

export function buildSellerSnapshot(org: SellerSnapshot): SellerSnapshot {
  return {
    legalName: org.legalName,
    addressLine1: org.addressLine1,
    addressLine2: org.addressLine2,
    postalCode: org.postalCode,
    city: org.city,
    country: org.country,
    vatId: org.vatId,
    taxNumber: org.taxNumber,
    email: org.email,
    phone: org.phone,
    electronicAddress: org.electronicAddress,
    iban: org.iban,
    bic: org.bic,
    bankName: org.bankName,
  };
}

export function buildBuyerSnapshot(customer: BuyerSnapshot): BuyerSnapshot {
  return {
    name: customer.name,
    contactName: customer.contactName,
    addressLine1: customer.addressLine1,
    addressLine2: customer.addressLine2,
    postalCode: customer.postalCode,
    city: customer.city,
    countryCode: customer.countryCode,
    vatId: customer.vatId,
    email: customer.email,
    leitwegId: customer.leitwegId,
  };
}

function tryParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * Liefert den Snapshot, wenn vorhanden und gueltig — sonst den Fallback (Live-Relation).
 * Ein defekter Snapshot bricht die Ausgabe nicht, wird aber protokolliert, damit er
 * nicht stumm bleibt.
 */
export function parseSellerSnapshot(json: string | null | undefined, fallback: SellerSnapshot, ctx: string): SellerSnapshot {
  if (!json) return fallback;
  const parsed = sellerSnapshotSchema.safeParse(tryParse(json));
  if (parsed.success) return parsed.data;
  console.warn(`snapshot: Verkaeufer-Snapshot von ${ctx} ungueltig, nutze Live-Daten`);
  return fallback;
}

export function parseBuyerSnapshot(json: string | null | undefined, fallback: BuyerSnapshot, ctx: string): BuyerSnapshot {
  if (!json) return fallback;
  const parsed = buyerSnapshotSchema.safeParse(tryParse(json));
  if (parsed.success) return parsed.data;
  console.warn(`snapshot: Kaeufer-Snapshot von ${ctx} ungueltig, nutze Live-Daten`);
  return fallback;
}
```

- [ ] **Schritt 5: Test ausführen, Erfolg bestätigen**

Ausführen: `npx vitest run test/unit/snapshot.test.ts`
Erwartet: 4 Tests PASS.

- [ ] **Schritt 6: Prisma-Schema erweitern**

In `prisma/schema.prisma` im Modell `Invoice` direkt nach der Zeile `paymentTerms          String?  // Skonto-/Zahlungsbedingungen (Freitext, §14 Abs.4 Nr.7)` einfügen:

```prisma
  internalNotes         String?  // Nur intern sichtbar — nie in PDF, XRechnung, ZUGFeRD oder Mails
  // Snapshot der Parteien zum Festschreibungszeitpunkt (Phase 0). JSON-String, per Zod
  // gelesen (sellerSnapshotSchema/buyerSnapshotSchema). NULL bei Entwuerfen.
  sellerSnapshotJson    String?
  buyerSnapshotJson     String?
  snapshotSource        String?  // FINALIZE | CREATE | MIGRATION
  snapshotAt            DateTime?
```

Im Modell `Quote` direkt nach der Zeile `notes                String?` (die Zeile mit `notes` im Quote-Modell) einfügen:

```prisma
  internalNotes        String?  // Nur intern sichtbar — nie in PDF oder Mails
  sellerSnapshotJson   String?  // Snapshot zum Erstellungszeitpunkt (Phase 0), siehe Invoice
  buyerSnapshotJson    String?
  snapshotSource       String?  // CREATE | MIGRATION
  snapshotAt           DateTime?
```

Postgres-Schema ableiten und Gleichheit prüfen:

```bash
sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma > prisma/schema.postgres.prisma
diff <(sed 's/provider = "sqlite"/PROVIDER/' prisma/schema.prisma) <(sed 's/provider = "postgresql"/PROVIDER/' prisma/schema.postgres.prisma) && echo identisch
```

- [ ] **Schritt 7: SQLite-Migrationen erzeugen**

DDL generieren lassen (nicht-interaktiv, Name vorgegeben):

```bash
npx prisma migrate dev --name phase0_snapshots_internal_notes --skip-generate
```

Erwartet: neues Verzeichnis `prisma/migrations/<ts>_phase0_snapshots_internal_notes/` mit zehn `ALTER TABLE … ADD COLUMN`-Zeilen (5 je Tabelle). Prüfen: `grep -c "ADD COLUMN" prisma/migrations/*_phase0_snapshots_internal_notes/migration.sql` → `10`.

Backfill-Migration leer anlegen und füllen:

```bash
npx prisma migrate dev --name phase0_backfill_snapshots --create-only --skip-generate
```

Inhalt von `prisma/migrations/<ts>_phase0_backfill_snapshots/migration.sql` vollständig ersetzen durch:

```sql
-- Phase 0: Bestandsbelege einfrieren. Snapshot aus dem HEUTIGEN Stamm, Herkunft MIGRATION
-- (Betreiberentscheidung). Nur Belege ohne Snapshot; Entwuerfe bleiben live.
-- Diese Datei wird vom Integrationstest wortgleich ausgefuehrt — Schluesselnamen muessen
-- exakt sellerSnapshotSchema/buyerSnapshotSchema (src/schemas/index.ts) entsprechen.
UPDATE "Invoice" SET
  "sellerSnapshotJson" = (SELECT json_object(
      'legalName', o."legalName", 'addressLine1', o."addressLine1", 'addressLine2', o."addressLine2",
      'postalCode', o."postalCode", 'city', o."city", 'country', o."country", 'vatId', o."vatId",
      'taxNumber', o."taxNumber", 'email', o."email", 'phone', o."phone",
      'electronicAddress', o."electronicAddress", 'iban', o."iban", 'bic', o."bic", 'bankName', o."bankName")
    FROM "Organization" o WHERE o."id" = "Invoice"."orgId"),
  "buyerSnapshotJson" = (SELECT json_object(
      'name', c."name", 'contactName', c."contactName", 'addressLine1', c."addressLine1",
      'addressLine2', c."addressLine2", 'postalCode', c."postalCode", 'city', c."city",
      'countryCode', c."countryCode", 'vatId', c."vatId", 'email', c."email", 'leitwegId', c."leitwegId")
    FROM "Customer" c WHERE c."id" = "Invoice"."customerId"),
  "snapshotSource" = 'MIGRATION',
  "snapshotAt" = CURRENT_TIMESTAMP
WHERE "status" <> 'DRAFT' AND "snapshotSource" IS NULL;

UPDATE "Quote" SET
  "sellerSnapshotJson" = (SELECT json_object(
      'legalName', o."legalName", 'addressLine1', o."addressLine1", 'addressLine2', o."addressLine2",
      'postalCode', o."postalCode", 'city', o."city", 'country', o."country", 'vatId', o."vatId",
      'taxNumber', o."taxNumber", 'email', o."email", 'phone', o."phone",
      'electronicAddress', o."electronicAddress", 'iban', o."iban", 'bic', o."bic", 'bankName', o."bankName")
    FROM "Organization" o WHERE o."id" = "Quote"."orgId"),
  "buyerSnapshotJson" = (SELECT json_object(
      'name', c."name", 'contactName', c."contactName", 'addressLine1', c."addressLine1",
      'addressLine2', c."addressLine2", 'postalCode', c."postalCode", 'city', c."city",
      'countryCode', c."countryCode", 'vatId', c."vatId", 'email', c."email", 'leitwegId', c."leitwegId")
    FROM "Customer" c WHERE c."id" = "Quote"."customerId"),
  "snapshotSource" = 'MIGRATION',
  "snapshotAt" = CURRENT_TIMESTAMP
WHERE "number" IS NOT NULL AND "snapshotSource" IS NULL;
```

Anwenden: `npx prisma migrate deploy` → Erwartet: beide Migrationen angewendet. Danach `npx prisma generate`.

- [ ] **Schritt 8: Postgres-Migrationen erzeugen**

Wegwerf-Postgres wie in CONTRIBUTING.md (Container `oig-migrate`, Port 55432, `DATABASE_URL` exportieren, `npx prisma migrate deploy --config prisma.postgres.config.ts` für die Baseline). Dann:

```bash
npm run db:migrate:pg -- --name phase0_snapshots_internal_notes
npx prisma migrate dev --config prisma.postgres.config.ts --name phase0_backfill_snapshots --create-only --skip-generate
```

Erwartet: zwei neue Verzeichnisse unter `prisma/migrations-postgres/`. Prüfen: `grep -c "ADD COLUMN" prisma/migrations-postgres/*_phase0_snapshots_internal_notes/migration.sql` → `10`.

Inhalt der Postgres-Backfill-Migration vollständig ersetzen durch dieselben zwei UPDATEs wie in Schritt 7, mit genau diesen drei Unterschieden: `json_object(` → `json_build_object(`, jeder Subselect endet mit `)::text` statt `)`, und `CURRENT_TIMESTAMP` → `NOW()`. Konkret lautet der erste Subselect dann:

```sql
  "sellerSnapshotJson" = (SELECT json_build_object(
      'legalName', o."legalName", 'addressLine1', o."addressLine1", 'addressLine2', o."addressLine2",
      'postalCode', o."postalCode", 'city', o."city", 'country', o."country", 'vatId', o."vatId",
      'taxNumber', o."taxNumber", 'email', o."email", 'phone', o."phone",
      'electronicAddress', o."electronicAddress", 'iban', o."iban", 'bic', o."bic", 'bankName', o."bankName")::text
    FROM "Organization" o WHERE o."id" = "Invoice"."orgId"),
```

Anwenden und prüfen: `npx prisma migrate deploy --config prisma.postgres.config.ts` → beide angewendet. Container entfernen, `npx prisma generate` (SQLite-Client wiederherstellen — `db:migrate:pg` tut das per Trap, `migrate dev --config` mit `--create-only` nicht).

- [ ] **Schritt 9: Gesamtsuite und Commit**

```bash
npm run typecheck && npm run lint && npm test
git add prisma src/schemas/index.ts src/domain/snapshot.ts test/unit/snapshot.test.ts
git commit -s -m "feat(db): Snapshot-Felder und internalNotes auf Invoice/Quote

Zwei Migrationen je Provider: DDL (additiv) und Backfill aus dem heutigen
Stamm mit Herkunft MIGRATION. Snapshot-Builder als reine Domainfunktionen,
Zod-Schemas feldgenau zu den Mapper-Eingaben."
```

---

### Task 2: Snapshot schreiben und lesen

**Dateien:**
- Ändern: `src/domain/invoice/finalize.ts` (Status-Claim, Schritt 3)
- Ändern: `src/domain/document/create.ts`
- Ändern: `src/lib/einvoice/mapper.ts`
- Ändern: `src/domain/document/pdf-data.ts`
- Test: `test/integration/snapshot.test.ts`

**Schnittstellen:**
- Konsumiert: `buildSellerSnapshot`, `buildBuyerSnapshot`, `parseSellerSnapshot`, `parseBuyerSnapshot` (Task 1).
- Erzeugt: `MapInput`/`DocInput` mit optionalen `sellerSnapshotJson`/`buyerSnapshotJson`; Aufrufer (`load.ts`, Dokument-PDF-Route) übergeben das Prisma-Objekt unverändert und brauchen keine Änderung.

- [ ] **Schritt 1: Failing Integrationstest schreiben**

`test/integration/snapshot.test.ts` — Aufbau wie `test/integration/gobd.test.ts` (dieselben Helfer für Organisation/Kunde/Rechnung nutzen; falls dort keine exportierten Helfer existieren, die Anlage-Aufrufe aus `gobd.test.ts` in eine lokale `setup()`-Funktion dieser Datei übernehmen):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dbInternal } from "@/lib/db";
import { createInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createBusinessDocument } from "@/domain/document/create";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildEInvoiceData } from "@/lib/einvoice/mapper";
import { buyerSnapshotSchema, sellerSnapshotSchema } from "@/schemas";

// Organisation + Kunde anlegen; Rueckgabe der IDs. Aufrufe an gobd.test.ts angleichen.
async function setup() { /* wie in gobd.test.ts */ }

const line = { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };

describe("Phase 0 — Snapshots", () => {
  let orgId = ""; let customerId = "";
  beforeAll(async () => { ({ orgId, customerId } = await setup()); });

  it("festgeschriebene Rechnung behaelt alte Kunden- und Firmendaten", async () => {
    const inv = await createInvoice(orgId, { customerId, lines: [line], deliveryDate: new Date() });
    await finalizeInvoice(inv.id);
    await dbInternal.customer.update({ where: { id: customerId }, data: { name: "GEAENDERT AG", city: "Neustadt" } });
    await dbInternal.organization.update({ where: { id: orgId }, data: { legalName: "GEAENDERT GmbH" } });
    const loaded = await loadEInvoiceData(inv.id);
    expect(loaded!.data.buyer.name).not.toBe("GEAENDERT AG");
    expect(loaded!.data.buyer.city).not.toBe("Neustadt");
    expect(loaded!.data.seller.name).not.toBe("GEAENDERT GmbH");
    expect(loaded!.invoice.snapshotSource).toBe("FINALIZE");
  });

  it("Entwurf spiegelt Stammdatenaenderung weiterhin live", async () => {
    const inv = await createInvoice(orgId, { customerId, lines: [line], deliveryDate: new Date() });
    const loaded = await loadEInvoiceData(inv.id);
    expect(loaded!.data.buyer.name).toBe("GEAENDERT AG");
    expect(loaded!.invoice.snapshotSource).toBeNull();
  });

  it("Ausgabegleichheit: Snapshot-Pfad und Live-Pfad liefern dasselbe EInvoiceData", async () => {
    const inv = await createInvoice(orgId, { customerId, lines: [line], deliveryDate: new Date() });
    const fin = await finalizeInvoice(inv.id);
    const withSnapshot = buildEInvoiceData(fin);
    const live = buildEInvoiceData({ ...fin, sellerSnapshotJson: null, buyerSnapshotJson: null });
    expect(withSnapshot).toEqual(live);
  });

  it("Storno-Gutschrift traegt eigenen Snapshot", async () => {
    const inv = await createInvoice(orgId, { customerId, lines: [line], deliveryDate: new Date() });
    await finalizeInvoice(inv.id);
    const { creditNote } = await cancelInvoice(inv.id);
    const credit = await dbInternal.invoice.findUniqueOrThrow({ where: { id: creditNote.id } });
    expect(credit.snapshotSource).toBe("FINALIZE");
    expect(buyerSnapshotSchema.safeParse(JSON.parse(credit.buyerSnapshotJson!)).success).toBe(true);
  });

  it("Geschaeftsdokument bekommt Snapshot bei Erstellung", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, lines: [line] });
    expect(q.snapshotSource).toBe("CREATE");
    expect(sellerSnapshotSchema.safeParse(JSON.parse(q.sellerSnapshotJson!)).success).toBe(true);
  });

  it("Backfill-Migration friert Belege ohne Snapshot mit Herkunft MIGRATION ein", async () => {
    const inv = await createInvoice(orgId, { customerId, lines: [line], deliveryDate: new Date() });
    await finalizeInvoice(inv.id);
    await dbInternal.$executeRawUnsafe(
      `UPDATE "Invoice" SET "sellerSnapshotJson" = NULL, "buyerSnapshotJson" = NULL, "snapshotSource" = NULL, "snapshotAt" = NULL WHERE "id" = '${inv.id}'`,
    );
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_phase0_backfill_snapshots"))!;
    const sql = readFileSync(join("prisma/migrations", dir, "migration.sql"), "utf8");
    for (const stmt of sql.split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith("--"))) {
      await dbInternal.$executeRawUnsafe(stmt);
    }
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.snapshotSource).toBe("MIGRATION");
    const parsed = buyerSnapshotSchema.safeParse(JSON.parse(after.buyerSnapshotJson!));
    expect(parsed.success).toBe(true);
    const live = await dbInternal.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(parsed.data!.name).toBe(live.name);
  });
});
```

Hinweis zum Splitten: Kommentarzeilen innerhalb der SQL-Datei stehen vor dem ersten `UPDATE`; `split(";")` liefert den Kommentarblock als Teil des ersten Statements — SQLite ignoriert `--`-Zeilen, das ist unschädlich. Der Filter `!s.startsWith("--")` greift nur, wenn ein Segment ausschließlich aus Kommentar besteht.

- [ ] **Schritt 2: Test ausführen, Fehlschlag bestätigen**

Ausführen: `npx vitest run test/integration/snapshot.test.ts`
Erwartet: FAIL — `snapshotSource` ist nach Festschreibung `null`, Kundenänderung schlägt durch.

- [ ] **Schritt 3: Snapshot in `finalizeWithinTx` schreiben**

In `src/domain/invoice/finalize.ts` den Import ergänzen:

```ts
import { buildSellerSnapshot, buildBuyerSnapshot } from "@/domain/snapshot";
```

Im Status-Claim (Kommentar `// 3) Atomarer Status-Claim`) das `data`-Objekt erweitern — nach `taxBreakdownJson: JSON.stringify(totals.breakdown),` einfügen:

```ts
      // Parteien-Snapshot (Phase 0): ab jetzt rendern PDF/XML aus diesem Stand.
      sellerSnapshotJson: JSON.stringify(buildSellerSnapshot(invoice.org)),
      buyerSnapshotJson: JSON.stringify(buildBuyerSnapshot(invoice.customer)),
      snapshotSource: "FINALIZE",
      snapshotAt: now,
```

Im `appendChangeLog`-Aufruf den `diff` erweitern zu:

```ts
    diff: { number, status: "FINALIZED", grossTotalCents: totals.grossTotalCents, snapshotSource: "FINALIZE" },
```

- [ ] **Schritt 4: Snapshot in `createBusinessDocument` schreiben**

In `src/domain/document/create.ts` Import ergänzen:

```ts
import { buildSellerSnapshot, buildBuyerSnapshot } from "@/domain/snapshot";
```

Die Kundenabfrage von `select: { id: true }` auf die volle Zeile umstellen und die Organisation laden — die Zeilen

```ts
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, orgId }, select: { id: true } });
    if (!customer) throw new Error("Kunde nicht gefunden.");
```

ersetzen durch:

```ts
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, orgId } });
    if (!customer) throw new Error("Kunde nicht gefunden.");
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });
```

Im `tx.quote.create` nach `notes: input.notes,` einfügen:

```ts
        internalNotes: input.internalNotes,
        sellerSnapshotJson: JSON.stringify(buildSellerSnapshot(org)),
        buyerSnapshotJson: JSON.stringify(buildBuyerSnapshot(customer)),
        snapshotSource: "CREATE",
        snapshotAt: now,
```

(`input.internalNotes` existiert erst nach Task 3, Schritt 3 — bis dahin die Zeile `internalNotes: input.internalNotes,` **weglassen**; Task 3 ergänzt sie. Alternativ Task 3 Schritt 3 vorziehen. Der Implementer entscheidet und vermerkt es im Bericht.)

- [ ] **Schritt 5: Mapper auf Snapshot-mit-Fallback umstellen**

In `src/lib/einvoice/mapper.ts` Import ergänzen:

```ts
import { parseSellerSnapshot, parseBuyerSnapshot } from "@/domain/snapshot";
```

`MapInput` erweitern — nach `taxBreakdownJson: string;` einfügen:

```ts
  // Phase 0: Snapshot der Parteien; bei Entwuerfen null -> Live-Relation.
  sellerSnapshotJson?: string | null;
  buyerSnapshotJson?: string | null;
  id?: string;
```

In `buildEInvoiceData` vor dem `return` einfügen:

```ts
  const ctx = invoice.id ?? invoice.number ?? "unbekannt";
  const org = parseSellerSnapshot(invoice.sellerSnapshotJson, invoice.org, ctx);
  const customer = parseBuyerSnapshot(invoice.buyerSnapshotJson, invoice.customer, ctx);
```

und im Rückgabeobjekt **jede** Referenz `invoice.org.` durch `org.` und `invoice.customer.` durch `customer.` ersetzen (betrifft `buyerReference`, den gesamten `seller`- und `buyer`-Block sowie `iban`, `bic`, `bankName`).

- [ ] **Schritt 6: `pdf-data.ts` analog umstellen**

In `src/domain/document/pdf-data.ts` Import ergänzen:

```ts
import { parseSellerSnapshot, parseBuyerSnapshot } from "@/domain/snapshot";
```

`DocInput` erweitern — nach `notes: string | null;` einfügen:

```ts
  id?: string;
  sellerSnapshotJson?: string | null;
  buyerSnapshotJson?: string | null;
```

Die `org`- und `customer`-Typen in `DocInput` auf die vollständigen Snapshot-Typen bringen (sie sind Teilmengen; `electronicAddress` bei `org` und `leitwegId` bei `customer` ergänzen, damit `parseSellerSnapshot`/`parseBuyerSnapshot` typkompatibel sind). Vor dem `return` in `buildDocEInvoiceData`:

```ts
  const ctx = q.id ?? q.number ?? "unbekannt";
  const org = parseSellerSnapshot(q.sellerSnapshotJson, q.org, ctx);
  const customer = parseBuyerSnapshot(q.buyerSnapshotJson, q.customer, ctx);
```

und alle `q.org.`/`q.customer.`-Referenzen im Rückgabeobjekt durch `org.`/`customer.` ersetzen. `electronicAddress` im `seller`-Block auf `org.electronicAddress` setzen (bisher hart `null` — der Wert ist bei Geschäftsdokumenten ebenso korrekt).

- [ ] **Schritt 7: Tests ausführen, Erfolg bestätigen**

Ausführen: `npm test`
Erwartet: alle bisherigen Tests grün, `test/integration/snapshot.test.ts` 6 PASS. Insbesondere `test/unit/einvoice.test.ts` unverändert grün (Ausgabegleichheit).

- [ ] **Schritt 8: Commit**

```bash
npm run typecheck && npm run lint
git add src/domain/invoice/finalize.ts src/domain/document/create.ts src/lib/einvoice/mapper.ts src/domain/document/pdf-data.ts test/integration/snapshot.test.ts
git commit -s -m "feat(gobd): Parteien-Snapshot bei Festschreibung und Dokumenterstellung

PDF und XRechnung lesen ab jetzt den Snapshot; Entwuerfe bleiben live.
Ausgabegleichheit zwischen Snapshot- und Live-Pfad ist Testfall."
```

---

### Task 3: Interne Notizen (Schema-Eingaben, Services, UI)

**Dateien:**
- Ändern: `src/schemas/index.ts` (`createInvoiceSchema`, `createDocumentSchema`)
- Ändern: `src/domain/invoice/create.ts`
- Ändern: `src/domain/document/create.ts` (falls in Task 2 ausgelassen)
- Ändern: `src/components/NewInvoiceForm.tsx`, `src/components/NewDocumentForm.tsx`
- Ändern: `src/app/rechnungen/[id]/page.tsx`, `src/app/dokumente/[id]/page.tsx`
- Test: `test/unit/snapshot.test.ts` (ein Fall ergänzen)

- [ ] **Schritt 1: Failing Test ergänzen**

In `test/unit/snapshot.test.ts` einen weiteren Fall im `describe`-Block:

```ts
  it("internalNotes erreicht EInvoiceData strukturell nicht", async () => {
    const { buildEInvoiceData } = await import("@/lib/einvoice/mapper");
    const data = buildEInvoiceData({
      number: "RE-1", type: "INVOICE", issueDate: new Date(), dueDate: null, deliveryDate: null, currency: "EUR",
      buyerReference: null, paymentTerms: null, notes: "sichtbar", netTotalCents: 0, taxTotalCents: 0,
      grossTotalCents: 0, paidAmountCents: 0, taxBreakdownJson: "[]", org, customer, lines: [],
      // @ts-expect-error internalNotes ist bewusst kein Teil von MapInput
      internalNotes: "GEHEIM",
    });
    expect(JSON.stringify(data)).not.toContain("GEHEIM");
  });
```

Ausführen: `npx vitest run test/unit/snapshot.test.ts` → dieser Fall besteht bereits (strukturell), die `@ts-expect-error`-Zeile schlägt beim Typecheck fehl, falls `internalNotes` jemals in `MapInput` auftaucht. Das ist der eigentliche Wächter.

- [ ] **Schritt 2: Zod-Eingaben erweitern**

In `src/schemas/index.ts` in `createInvoiceSchema` nach `paymentTerms: z.string().optional(),` einfügen:

```ts
  internalNotes: z.string().optional(), // nur intern, nie im Beleg
```

In `createDocumentSchema` nach `notes: z.string().optional(),` einfügen:

```ts
  internalNotes: z.string().optional(),
```

- [ ] **Schritt 3: Services übernehmen das Feld**

`src/domain/invoice/create.ts`: im `tx.invoice.create`-Datenblock nach `paymentTerms: input.paymentTerms,` einfügen:

```ts
        internalNotes: input.internalNotes,
```

`src/domain/document/create.ts`: die Zeile `internalNotes: input.internalNotes,` in `tx.quote.create` einfügen (siehe Task 2, Schritt 4), falls noch nicht geschehen.

- [ ] **Schritt 4: Formulare**

`src/components/NewInvoiceForm.tsx`: neben `const [notes, setNotes] = useState("");` ergänzen:

```tsx
  const [internalNotes, setInternalNotes] = useState("");
```

Im Payload neben `notes: finalNotes,`:

```tsx
      internalNotes: internalNotes || undefined,
```

Direkt nach der `notes`-Textarea (Z. ~190) — das umgebende Label-/Feld-Markup der `notes`-Textarea kopieren und anpassen:

```tsx
        <label className="block text-sm font-medium">
          Interne Notiz
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">nur intern sichtbar</span>
        </label>
        <textarea className={input} rows={2} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
```

`src/components/NewDocumentForm.tsx`: identisch (State neben Z. 34, Payload neben Z. 62, Feld nach Z. 158).

- [ ] **Schritt 5: Detailseiten**

`src/app/rechnungen/[id]/page.tsx` direkt nach Zeile 199 (`{invoice.notes && …}`):

```tsx
      {invoice.internalNotes && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <span className="mr-2 font-medium">Interne Notiz</span>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs">nur intern sichtbar</span>
          <p className="mt-1 whitespace-pre-line">{invoice.internalNotes}</p>
        </div>
      )}
```

`src/app/dokumente/[id]/page.tsx` nach Zeile 109 analog mit `q.internalNotes`.

- [ ] **Schritt 6: Prüfen und Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/schemas/index.ts src/domain/invoice/create.ts src/domain/document/create.ts src/components/NewInvoiceForm.tsx src/components/NewDocumentForm.tsx "src/app/rechnungen/[id]/page.tsx" "src/app/dokumente/[id]/page.tsx" test/unit/snapshot.test.ts
git commit -s -m "feat(ui): interne Notizen auf Rechnung und Geschaeftsdokument

Eigenes Feld internalNotes; erreicht EInvoiceData strukturell nicht
(Typ-Waechter im Test). Invoice.notes bleibt kundensichtbar."
```

---

### Task 4: Postgres-Testskript an Folgemigrationen anpassen + Backfill-Fall

**Dateien:**
- Ändern: `scripts/test-postgres-migrations.sh`

**Schnittstellen:**
- Konsumiert: Migrationen aus Task 1.

- [ ] **Schritt 1: Bestands-DB faithful simulieren**

In `scripts/test-postgres-migrations.sh` im Block „Datenbank leeren und Bestandslage herstellen" die zwei Zeilen

```bash
npx prisma db push --schema prisma/schema.postgres.prisma \
  --skip-generate --accept-data-loss >/dev/null
```

ersetzen durch:

```bash
# Bestands-DB = exakt der Baseline-Stand, ohne Migrationshistorie und ohne spaetere Spalten.
npx prisma db execute --url "$DATABASE_URL" \
  --file prisma/migrations-postgres/0_init/migration.sql >/dev/null
# Legacy-Belege fuer den Backfill-Test (Fall 4): Organisation, Kunde, festgeschriebene Rechnung.
docker exec "$CONTAINER" psql -U oig -d openinvoice -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO "Organization" ("id","legalName","addressLine1","postalCode","city","updatedAt")
  VALUES ('org1','Alt GmbH','Weg 1','12345','Altstadt',NOW());
INSERT INTO "Customer" ("id","orgId","name","addressLine1","postalCode","city","updatedAt")
  VALUES ('cust1','org1','Alt AG','Str. 2','54321','Altdorf',NOW());
INSERT INTO "Invoice" ("id","orgId","customerId","number","status","updatedAt")
  VALUES ('inv1','org1','cust1','RE-2026-00001','FINALIZED',NOW());
SQL
```

Hinweis: Fehlen in `Invoice`/`Customer`/`Organization` weitere NOT-NULL-Spalten ohne Default, die INSERTs entsprechend ergänzen — die Baseline-SQL (`0_init/migration.sql`) ist die Referenz. Im Bericht festhalten, welche Spalten nötig waren.

- [ ] **Schritt 2: Fall 3 an echte Folgemigrationen anpassen**

Die Zeilen

```bash
npx prisma migrate deploy --config prisma.postgres.config.ts 2>&1 \
  | grep -q "No pending migrations" || fail "deploy war nicht wirkungslos"
echo "    ok — Baseline verbucht, deploy wirkungslos"
```

ersetzen durch:

```bash
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null \
  || fail "deploy nach Baseline fehlgeschlagen"
npx prisma migrate deploy --config prisma.postgres.config.ts 2>&1 \
  | grep -q "No pending migrations" || fail "zweiter deploy war nicht wirkungslos"
echo "    ok — Baseline verbucht, Folgemigrationen angewendet, deploy idempotent"
```

- [ ] **Schritt 3: Fall 4 ergänzen**

Vor `echo "ALLE TESTS BESTANDEN"`:

```bash
echo "==> Fall 4: Backfill friert Legacy-Belege ein"
SRC=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"snapshotSource\" from \"Invoice\" where id='inv1'")
[ "$SRC" = "MIGRATION" ] || fail "snapshotSource ist '$SRC', erwartet MIGRATION"
NAME=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select (\"buyerSnapshotJson\"::jsonb)->>'name' from \"Invoice\" where id='inv1'")
[ "$NAME" = "Alt AG" ] || fail "Buyer-Snapshot enthaelt '$NAME', erwartet 'Alt AG'"
KEYS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from jsonb_object_keys((\"sellerSnapshotJson\"::jsonb)) where true" 2>/dev/null || echo 0)
[ "$KEYS" = "14" ] || fail "Seller-Snapshot hat $KEYS Schluessel, erwartet 14"
echo "    ok — Backfill mit Herkunft MIGRATION, JSON gueltig"
```

- [ ] **Schritt 4: Ausführen**

Ausführen: `./scripts/test-postgres-migrations.sh`
Erwartet: `ALLE TESTS BESTANDEN` mit Fällen 1–4. Fall 1 erwartet weiterhin 15 Tabellen (Phase 0 fügt nur Spalten hinzu).

- [ ] **Schritt 5: Commit**

```bash
git add scripts/test-postgres-migrations.sh
git commit -s -m "test(postgres): Bestands-DB per Baseline-SQL simulieren, Backfill pruefen

db push mit dem aktuellen Schema haette der Legacy-DB bereits die neuen
Spalten gegeben. Fall 3 erwartet jetzt angewendete Folgemigrationen und
idempotenten zweiten deploy; Fall 4 prueft den Snapshot-Backfill."
```

---

### Task 5: `docs/ARCHITEKTUR.md` an den Code angleichen, Prüfkette, Doku

**Dateien:**
- Ändern: `docs/ARCHITEKTUR.md`
- Ändern: `docs/LIMITATIONEN.md`

- [ ] **Schritt 1: ARCHITEKTUR.md korrigieren**

Direkt unter der Titelzeile einen Hinweisblock einfügen:

```markdown
> **Stand 2026-09-02.** Dieses Dokument beschreibt den **implementierten** Stand. Frühere
> Fassungen enthielten Entwurfsvorschläge (Decimal-Preise, Mustang-Sidecar, Dunning-Enum,
> EmailLog), die nie umgesetzt wurden — sie sind entfernt. Wo Code und Dokument abweichen,
> gilt der Code. Roadmap: `docs/superpowers/requirements/` (Branch `specs`).
```

Dann folgende Korrekturen (jeweils den bestehenden Wortlaut suchen und ersetzen):

- Jede Nennung von „Next.js 14" → „Next.js 16 (App Router)".
- In Abschnitt 1: Preise/Beträge werden als **Integer-Cent** (`…Cents`), Mengen als **Integer-Milliunits** (`quantityMilli`) geführt; kein Decimal. Steuersätze als Integer-Prozent (19/7/0). `Dunning.level` ist `Int` (0 = Zahlungserinnerung … 3 = letzte Mahnung), kein Enum; Titel in `src/lib/dunning.ts`. Ein `EmailLog`-Modell existiert **nicht** (geplant, Phase 1). Neu seit Phase 0: `sellerSnapshotJson`, `buyerSnapshotJson`, `snapshotSource`, `snapshotAt`, `internalNotes` auf `Invoice` und `Quote`.
- In Abschnitt 2: Die Empfehlung eines Mustang-Java-Sidecars wurde **nicht** umgesetzt. Umgesetzt ist ein eigener Generator: UBL (XRechnung 3.0 CIUS) in `src/lib/einvoice/xrechnung.ts`, CII (Factur-X) in `cii.ts`, ZUGFeRD-Einbettung per pdf-lib in `zugferd.ts` (kein striktes PDF/A-3), Kernregelprüfung in `en16931-core.ts`, Schematron-Validierung per SaxonJS in CI, KoSIT-Validator als Cross-Check.
- Abschnitt 4 (Ordnerstruktur): den Baum durch den tatsächlichen ersetzen — `src/app` (Routen + `api/`, `actions/`), `src/domain/{audit.ts,changelog.ts,numbering.ts,snapshot.ts,document/,dunning/,invoice/,recurring/}`, `src/lib/{db.ts,org.ts,money.ts,tax.ts,dunning.ts,recurring.ts,auth/,einvoice/,pdf/}`, `src/schemas/index.ts`, `src/mcp/`, `src/generated/prisma` (generiert), `prisma/{schema.prisma,schema.postgres.prisma,migrations/,migrations-postgres/}`, `scripts/`, `test/{unit,integration}`. Nicht existierende Einträge (`emails/`, `einvoice-service/`, `domain/numbering/allocate.ts`) entfernen.
- Abschnitt 5 umbenennen in „5. Roadmap (historisch)" und einen Satz voranstellen: „Die verbindliche Planung ist das Lastenheft; dieser Abschnitt bleibt als ursprüngliche Stufenidee erhalten."

- [ ] **Schritt 2: LIMITATIONEN.md**

Im Abschnitt „Daten & Recht" einen Punkt ergänzen:

```markdown
- **Beleg-Snapshots:** Seit Phase 0 speichern festgeschriebene Rechnungen und nummerierte Geschäftsdokumente Käufer-/Verkäuferdaten als Snapshot; Stammdatenänderungen wirken nicht mehr zurück. Belege aus der Zeit davor wurden per Migration aus dem damals aktuellen Stamm eingefroren (`snapshotSource = MIGRATION`) — ihr Snapshot entspricht dem Stand zum Migrationszeitpunkt, nicht zwingend dem Ausstellungszeitpunkt.
```

- [ ] **Schritt 3: Vollständige Prüfkette**

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run validate:erechnung && ./scripts/test-postgres-migrations.sh
```

Erwartet: alles grün; Tests ≥ 56 + 7 neue.

- [ ] **Schritt 4: Commit**

```bash
git add docs/ARCHITEKTUR.md docs/LIMITATIONEN.md
git commit -s -m "docs: ARCHITEKTUR.md auf den implementierten Stand bringen, Snapshots dokumentieren"
```

---

## Nach Abschluss

- [ ] Branch pushen: `git push -u origin phase-0/snapshots`
- [ ] Abschluss-Review über den ganzen Branch, dann Merge in `main` (Fork)
- [ ] Deployment auf `invoice.prepaid-host.com` **nur nach Ankündigung** — erste echte Folgemigration auf der Produktivinstanz, Backup läuft über `update.sh`
