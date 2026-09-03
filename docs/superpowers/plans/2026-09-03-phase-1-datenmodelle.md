# Phase 1 — Datenmodell-Fundament · Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHES SUB-SKILL: `superpowers:subagent-driven-development`. Schritte nutzen Checkbox-Syntax (`- [ ]`).

**Ziel:** Neun Modelle (DocumentRelation, DeliveryNote+Line, TextTemplate, EmailTemplate, EmailLog, CustomerAddress, ContactPerson, PaymentMethod, DunningStage) additiv im Schema, für SQLite und Postgres migriert, mit Backfill; Dual-Write der Verknüpfungen; Nummernkreis-Parser erweitert; Zahlungsmethoden und Mahnstufen als Stammdaten mit Systemsatz.

**Architektur:** Additive DDL-Migration + handgeschriebene Backfill-Migration je Provider. Reine Domainfunktionen (`relations.ts`, `numbering.ts`, `masterdata/*`) plus ein Service `createDeliveryNote`. Bestehende Verknüpfungsfelder bleiben; `linkDocuments` schreibt zusätzlich `DocumentRelation`. Keine UI (Phasen 2–7).

**Tech-Stack:** Prisma 6.19.3 (SQLite + Postgres, zwei Migrationsverzeichnisse), Zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-phase-1-datenmodelle-design.md` (Branch `specs`; Kopie im Scratchpad `plan/`)

## Globale Randbedingungen

- Branch `phase-1/foundation` aus `main` (Head `9da0f14` oder neuer)
- `git commit -s`; Messages ohne Umlaute; keine Co-Authored-By-/Claude-Session-Zeilen; Kommentare deutsch; TypeScript strict, kein `any`
- Beide Schemadateien identisch halten: nach jeder Änderung `sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma > prisma/schema.postgres.prisma`
- Migrationen für beide Provider: SQLite `npx prisma migrate dev --name <n> --skip-generate` (bzw. `--create-only`), Postgres per Wegwerf-Container wie in CONTRIBUTING.md (`npm run db:migrate:pg -- --name <n>` bzw. `npx prisma migrate dev --config prisma.postgres.config.ts --name <n> --create-only --skip-generate`, danach `npx prisma generate`)
- Geld Integer-Cent, Mengen Integer-Milliunits, keine Prisma-Enums, kein Json-Typ
- GoBD-Guard (`src/lib/db.ts`), `finalizeWithinTx`, `mandatory.ts`, Phase-0-Snapshots unverändert
- Vor jedem Commit grün: `npm run typecheck && npm run lint && npm test`; vor dem letzten zusätzlich `npm run build && npm run validate:erechnung && ./scripts/test-postgres-migrations.sh`
- Bestehende 68 Tests dürfen nicht brechen

## Verifizierte Fakten

1. Booleans liegen in SQLite als `BOOLEAN` mit `0/1`, in Postgres als `BOOLEAN` `true/false`. DateTime: SQLite INTEGER-Millisekunden (`CAST(strftime('%s','now') AS INTEGER) * 1000`), Postgres `NOW()`.
2. `recordPaymentSchema.method` ist `PaymentMethod.default("TRANSFER")`; `PaymentForm.tsx` sendet hart `method: "TRANSFER"` (kein Select) — keine UI-Änderung nötig.
3. Org-Anlage an genau zwei Stellen: `src/app/actions/masterdata.ts:69` (`saveOrganization`, `organization.create`) und `src/mcp/server.ts:202` (`setup_company`).
4. `convert.ts` setzt `convertedToInvoiceId` in `tx.quote.update` und schreibt danach `appendChangeLog`; `cancel.ts` setzt `reversedByInvoiceId` am Original und `correctsInvoiceId` an der Gutschrift; `credit.ts` setzt `correctsInvoiceId`; `recurring/run.ts` setzt `recurringInvoiceId` im `tx.invoice.create` (Z. 75).
5. `DOC_TYPE_DEFAULT_PREFIX` (`numbering.ts:19–27`) hat INVOICE/CREDIT_NOTE/QUOTE/ANGEBOT/AUFTRAGSBESTAETIGUNG/PROFORMA/DUNNING. `formatDocumentNumber` ersetzt per Regex-`replace`.
6. `DUNNING_LEVEL_TITLE` = {0: Zahlungserinnerung, 1: 1. Mahnung, 2: 2. Mahnung, 3: 3. Mahnung}. `createDunning` leitet `level = inv.dunnings.length` ab.
7. Testhelfer: `test/integration/snapshot.test.ts` hat `setup()` (Org + Kunde); `gobd.test.ts` nutzt `createDraftInvoice`, `finalizeInvoice`, `cancelInvoice`, `createPartialCreditNote`, `recordPayment`, `createDunning`, `createRecurring`, `emitRecurringNow`, `createBusinessDocument`, `convertDocumentToInvoice`.
8. Backfill-Migrationen werden im Integrationstest wortgleich aus der Migrationsdatei gelesen und ausgeführt (Muster Phase 0: Kommentarzeilen zeilenweise strippen, dann an `;` splitten).

---

### Task 1: Schema, Zod, Parser, Migrationen

**Dateien:**
- Ändern: `prisma/schema.prisma`, `prisma/schema.postgres.prisma` (abgeleitet)
- Ändern: `src/schemas/index.ts`
- Ändern: `src/domain/numbering.ts`
- Erstellen: `prisma/migrations/<ts>_phase1_foundation_models/` (generiert), `prisma/migrations/<ts>_phase1_backfill/` (handgeschrieben); analog `prisma/migrations-postgres/`
- Test: `test/unit/numbering.test.ts` (erweitern), `test/unit/masterdata.test.ts` (neu)

**Schnittstellen:**
- Erzeugt: alle Modelle; Zod `RelationType`, `DocRefType`, `DeliveryNoteStatus`, `TextTemplatePosition`, `EmailLogStatus`, `AddressType`, angepasstes `DocType`, `PaymentMethod = z.string().min(1)`; `SYSTEM_PAYMENT_METHODS`, `DEFAULT_DUNNING_STAGES` (Konstanten in `src/domain/masterdata/defaults.ts`); `formatDocumentNumber` mit `{SEQ:n}`/`{DD}`.

- [ ] **Schritt 1: Failing Tests**

`test/unit/numbering.test.ts` — im `describe` ergänzen:

```ts
  it("unterstuetzt {SEQ:n} mit expliziter Stellenzahl und {DD}", () => {
    expect(
      formatDocumentNumber("{PREFIX}{YYYY}-{SEQ:5}", { prefix: "LS-", seq: 7, padding: 4, year: 2026, month: 9, day: 3 }),
    ).toBe("LS-2026-00007");
    expect(
      formatDocumentNumber("{YYYY}{MM}{DD}-{SEQ:2}", { prefix: "", seq: 3, padding: 4, year: 2026, month: 9, day: 3 }),
    ).toBe("20260903-03");
  });

  it("{SEQ} ohne Stellenangabe nutzt weiterhin padding", () => {
    expect(formatDocumentNumber("{SEQ}", { prefix: "", seq: 7, padding: 4, year: 2026, month: 1 })).toBe("0007");
  });

  it("kennt Praefixe fuer Lieferschein, Kunde, Produkt", () => {
    expect(defaultPrefix("DELIVERY_NOTE")).toBe("LS-");
    expect(defaultPrefix("CUSTOMER")).toBe("K-");
    expect(defaultPrefix("PRODUCT")).toBe("P-");
  });
```

`test/unit/masterdata.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SYSTEM_PAYMENT_METHODS, DEFAULT_DUNNING_STAGES } from "@/domain/masterdata/defaults";
import { PaymentMethod, RelationType, DocType } from "@/schemas";

describe("Stammdaten-Defaults", () => {
  it("acht Systemzahlungsmethoden mit eindeutigen Codes und UNTDID-4461-Codes", () => {
    expect(SYSTEM_PAYMENT_METHODS).toHaveLength(8);
    expect(new Set(SYSTEM_PAYMENT_METHODS.map((m) => m.code)).size).toBe(8);
    for (const code of ["TRANSFER", "CASH", "CARD", "SEPA"]) {
      expect(SYSTEM_PAYMENT_METHODS.some((m) => m.code === code)).toBe(true); // Altcodes bleiben aufloesbar
    }
    expect(SYSTEM_PAYMENT_METHODS.find((m) => m.code === "TRANSFER")!.untdidCode).toBe("58");
    expect(SYSTEM_PAYMENT_METHODS.find((m) => m.code === "SEPA")!.untdidCode).toBe("59");
  });

  it("vier Standard-Mahnstufen, Zins und B2B-Pauschale ab Stufe 1", () => {
    expect(DEFAULT_DUNNING_STAGES.map((s) => s.order)).toEqual([0, 1, 2, 3]);
    expect(DEFAULT_DUNNING_STAGES[0].calculateInterest).toBe(false);
    expect(DEFAULT_DUNNING_STAGES[1].calculateInterest).toBe(true);
    expect(DEFAULT_DUNNING_STAGES[1].includeB2BFlatFee).toBe(true);
    expect(DEFAULT_DUNNING_STAGES[0].name).toBe("Zahlungserinnerung");
  });

  it("Zod: PaymentMethod ist ein String, DocType kennt die realen Belegarten", () => {
    expect(PaymentMethod.safeParse("PAYPAL").success).toBe(true);
    expect(PaymentMethod.safeParse("").success).toBe(false);
    expect(DocType.safeParse("DELIVERY_NOTE").success).toBe(true);
    expect(DocType.safeParse("ANGEBOT").success).toBe(true);
    expect(DocType.safeParse("QUOTE").success).toBe(false);
    expect(RelationType.safeParse("CONVERTED_TO").success).toBe(true);
  });
});
```

- [ ] **Schritt 2: Tests ausführen, Fehlschlag bestätigen**

`npx vitest run test/unit/numbering.test.ts test/unit/masterdata.test.ts` → FAIL.

- [ ] **Schritt 3: `numbering.ts` erweitern**

`NumberPatternContext` um `day?: number` ergänzen. `DOC_TYPE_DEFAULT_PREFIX` um `DELIVERY_NOTE: "LS-"`, `CUSTOMER: "K-"`, `PRODUCT: "P-"` ergänzen (bestehende Einträge inkl. `QUOTE` behalten). In `formatDocumentNumber` **vor** der `{SEQ}`-Ersetzung:

```ts
    .replace(/\{DD\}/g, String(ctx.day ?? 1).padStart(2, "0"))
    // {SEQ:n} — explizite Stellenzahl hat Vorrang vor padding
    .replace(/\{SEQ:(\d+)\}/g, (_m, n: string) => String(ctx.seq).padStart(Number(n), "0"))
```

Alle Aufrufer von `formatDocumentNumber` (`finalize.ts`, `document/create.ts`, `dunning/create.ts`, `recurring/run.ts` — per `grep -rn formatDocumentNumber src`) übergeben zusätzlich `day: now.getDate()`.

- [ ] **Schritt 4: Konstanten anlegen**

`src/domain/masterdata/defaults.ts`:

```ts
/**
 * Systemstammdaten, die jede Organisation bekommt — beim Anlegen (ensure*) und per
 * Backfill-Migration fuer Bestandsorganisationen. Die Codes TRANSFER/CASH/CARD/SEPA
 * entsprechen der frueheren Zod-Enum, damit Bestandszahlungen aufloesbar bleiben.
 * untdidCode: UNTDID 4461 (EN 16931 BT-81).
 */
export const SYSTEM_PAYMENT_METHODS = [
  { code: "TRANSFER", name: "Ueberweisung", untdidCode: "58", sortOrder: 1 },
  { code: "CASH", name: "Barzahlung", untdidCode: "10", sortOrder: 2 },
  { code: "CARD", name: "EC-/Debitkarte", untdidCode: "48", sortOrder: 3 },
  { code: "CREDIT_CARD", name: "Kreditkarte", untdidCode: "54", sortOrder: 4 },
  { code: "PAYPAL", name: "PayPal", untdidCode: "68", sortOrder: 5 },
  { code: "SEPA", name: "SEPA-Lastschrift", untdidCode: "59", sortOrder: 6 },
  { code: "PREPAID", name: "Bereits bezahlt", untdidCode: "ZZZ", sortOrder: 7 },
  { code: "OTHER", name: "Sonstige", untdidCode: "ZZZ", sortOrder: 8 },
] as const;

/** Standard-Mahnstufen (Fristen aus dem Lastenheft, Titel wie DUNNING_LEVEL_TITLE). */
export const DEFAULT_DUNNING_STAGES = [
  { order: 0, name: "Zahlungserinnerung", daysAfterDue: 3, newDueDays: 14, feeCents: 0, calculateInterest: false, includeB2BFlatFee: false },
  { order: 1, name: "1. Mahnung", daysAfterDue: 10, newDueDays: 14, feeCents: 0, calculateInterest: true, includeB2BFlatFee: true },
  { order: 2, name: "2. Mahnung", daysAfterDue: 10, newDueDays: 14, feeCents: 0, calculateInterest: true, includeB2BFlatFee: true },
  { order: 3, name: "3. Mahnung", daysAfterDue: 7, newDueDays: 14, feeCents: 0, calculateInterest: true, includeB2BFlatFee: true },
] as const;
```

(Umlaute in Namen sind erlaubt — "Ueberweisung" hier bewusst ASCII, weil die Migrations-SQL denselben Text einfügt und byte-gleich bleiben soll; im UI wird in Phase 4 lokalisiert.)

- [ ] **Schritt 5: Zod anpassen**

In `src/schemas/index.ts`: `DocType` → `z.enum(["ANGEBOT","AUFTRAGSBESTAETIGUNG","PROFORMA","INVOICE","CREDIT_NOTE","DUNNING","DELIVERY_NOTE","CUSTOMER","PRODUCT"])`. `PaymentMethod` → `z.string().min(1).max(40)` (Kommentar: Codes kommen aus der Tabelle PaymentMethod, Pruefung in recordPayment). Neue Enums und Eingabeschemas:

```ts
// ── Phase 1: Dokumentketten, Lieferschein, Vorlagen, Stammdaten ──────────────
export const DocRefType = z.enum(["QUOTE", "INVOICE", "RECURRING", "DELIVERY_NOTE", "DUNNING"]);
export const RelationType = z.enum(["CONVERTED_TO", "CORRECTS", "REVERSES", "GENERATED_BY", "PARTIAL_OF", "DOWNPAYMENT_OF", "FINAL_FOR", "DELIVERED_BY"]);
export const DeliveryNoteStatus = z.enum(["DRAFT", "CREATED", "SENT", "DELIVERED", "INVOICED", "CANCELLED"]);
export const TextTemplatePosition = z.enum(["HEAD", "FOOT", "TERMS_DELIVERY", "TERMS_PAYMENT"]);
export const EmailLogStatus = z.enum(["QUEUED", "SENT", "DELIVERED", "BOUNCED", "FAILED"]);
export const AddressType = z.enum(["BILLING", "SHIPPING", "OTHER"]);

export const deliveryNoteLineInputSchema = z.object({
  description: z.string().min(1),
  articleNumber: z.string().optional(),
  quantityMilli: z.number().int().positive(),
  unit: z.string().min(1).default("C62"),
  sourceType: DocRefType.optional(),
  sourceId: z.string().optional(),
});
export const createDeliveryNoteSchema = z.object({
  customerId: z.string().min(1),
  deliveryDate: z.coerce.date().optional(),
  shippingDate: z.coerce.date().optional(),
  showPrices: z.boolean().default(false),
  showTax: z.boolean().default(false),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
  lines: z.array(deliveryNoteLineInputSchema).min(1),
});
export type CreateDeliveryNoteInput = z.infer<typeof createDeliveryNoteSchema>;

export const customerAddressSchema = z.object({
  type: AddressType, label: z.string().optional(), addressLine1: z.string().min(1), addressLine2: z.string().optional(),
  postalCode: z.string().min(1), city: z.string().min(1), countryCode: z.string().length(2).default("DE"), isDefault: z.boolean().default(false),
});
export const contactPersonSchema = z.object({
  firstName: z.string().min(1), lastName: z.string().min(1), role: z.string().optional(), phone: z.string().optional(),
  mobile: z.string().optional(), email: z.email().optional(), isDefault: z.boolean().default(false),
});
export const paymentMethodSchema = z.object({
  code: z.string().min(1).max(40).regex(/^[A-Z0-9_]+$/), name: z.string().min(1), description: z.string().optional(),
  paymentTermsDays: z.number().int().min(0).optional(), invoiceText: z.string().optional(), bankAccountRef: z.string().optional(),
  untdidCode: z.string().min(1).default("ZZZ"), isActive: z.boolean().default(true), sortOrder: z.number().int().default(0),
});
export const dunningStageSchema = z.object({
  order: z.number().int().min(0), name: z.string().min(1), daysAfterDue: z.number().int().min(0), newDueDays: z.number().int().min(0).default(14),
  feeCents: z.number().int().min(0).default(0), calculateInterest: z.boolean(), includeB2BFlatFee: z.boolean(),
  emailTemplateId: z.string().optional(), documentTemplateId: z.string().optional(), enabled: z.boolean().default(true),
});
export const textTemplateSchema = z.object({ name: z.string().min(1), docType: DocType, position: TextTemplatePosition, body: z.string(), isDefault: z.boolean().default(false) });
export const emailTemplateSchema = z.object({ name: z.string().min(1), docType: DocType, subject: z.string().min(1), body: z.string(), signature: z.string().optional(), isDefault: z.boolean().default(false) });
```

- [ ] **Schritt 6: Prisma-Schema erweitern**

An `prisma/schema.prisma` anhängen (vor `model User`, Stil der Datei) und die Rückrelationen in `Organization` (`documentRelations DocumentRelation[]`, `deliveryNotes DeliveryNote[]`, `textTemplates TextTemplate[]`, `emailTemplates EmailTemplate[]`, `emailLogs EmailLog[]`, `customerAddresses CustomerAddress[]`, `contactPersons ContactPerson[]`, `paymentMethods PaymentMethod[]`, `dunningStages DunningStage[]`), in `Customer` (`addresses CustomerAddress[]`, `contacts ContactPerson[]`, `deliveryNotes DeliveryNote[]`, `defaultPaymentMethodId String?`, `defaultPaymentMethod PaymentMethod? @relation(fields: [defaultPaymentMethodId], references: [id])`) und in `Dunning` (`stageId String?`, `stage DunningStage? @relation(fields: [stageId], references: [id])`) ergänzen:

```prisma
/// Generische Verknuepfung zwischen Belegen (Phase 1). Polymorph ueber Typ+ID, daher ohne
/// Fremdschluessel; Existenz prueft die Domain (linkDocuments). Die Altfelder
/// (convertedToInvoiceId, correctsInvoiceId, reversedByInvoiceId, recurringInvoiceId)
/// bleiben und werden parallel gepflegt.
model DocumentRelation {
  id           String   @id @default(cuid())
  orgId        String
  org          Organization @relation(fields: [orgId], references: [id])
  fromType     String   // QUOTE | INVOICE | RECURRING | DELIVERY_NOTE | DUNNING
  fromId       String
  toType       String
  toId         String
  relationType String   // CONVERTED_TO | CORRECTS | REVERSES | GENERATED_BY | PARTIAL_OF | DOWNPAYMENT_OF | FINAL_FOR | DELIVERED_BY
  createdAt    DateTime @default(now())

  @@unique([fromType, fromId, toType, toId, relationType])
  @@index([orgId])
  @@index([fromType, fromId])
  @@index([toType, toId])
}

/// Lieferschein — mengenfuehrend, kein GoBD-Beleg, belegt den Leistungszeitpunkt.
model DeliveryNote {
  id                 String   @id @default(cuid())
  orgId              String
  org                Organization @relation(fields: [orgId], references: [id])
  customerId         String
  customer           Customer @relation(fields: [customerId], references: [id])
  number             String?
  status             String   @default("DRAFT") // DRAFT | CREATED | SENT | DELIVERED | INVOICED | CANCELLED
  issueDate          DateTime @default(now())
  deliveryDate       DateTime?
  shippingDate       DateTime?
  showPrices         Boolean  @default(false)
  showTax            Boolean  @default(false)
  notes              String?
  internalNotes      String?
  sellerSnapshotJson String?
  buyerSnapshotJson  String?
  snapshotSource     String?
  snapshotAt         DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  lines DeliveryNoteLine[]

  @@index([orgId])
  @@index([customerId])
}

model DeliveryNoteLine {
  id             String @id @default(cuid())
  deliveryNoteId String
  deliveryNote   DeliveryNote @relation(fields: [deliveryNoteId], references: [id], onDelete: Cascade)
  position       Int
  sourceType     String? // QUOTE | INVOICE (Quellposition fuer Teil-Lieferungen)
  sourceId       String?
  description    String
  articleNumber  String?
  quantityMilli  Int
  unit           String @default("C62")

  @@index([deliveryNoteId])
}

/// Textvorlagen fuer Belege (Kopf-/Fusstext, Bedingungen). Stammdaten — der gerenderte
/// Text wird beim Erzeugen des Belegs als Snapshot in den Beleg geschrieben.
model TextTemplate {
  id        String   @id @default(cuid())
  orgId     String
  org       Organization @relation(fields: [orgId], references: [id])
  name      String
  docType   String
  position  String   // HEAD | FOOT | TERMS_DELIVERY | TERMS_PAYMENT
  body      String
  isDefault Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([orgId, docType])
}

model EmailTemplate {
  id        String   @id @default(cuid())
  orgId     String
  org       Organization @relation(fields: [orgId], references: [id])
  name      String
  docType   String
  subject   String
  body      String
  signature String?
  isDefault Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  dunningStages DunningStage[]

  @@index([orgId, docType])
}

/// Versandprotokoll. Text vollstaendig, Anhaenge nur als SHA-256 (Betreiberentscheidung).
model EmailLog {
  id              String   @id @default(cuid())
  orgId           String
  org             Organization @relation(fields: [orgId], references: [id])
  docType         String
  docId           String
  templateId      String?
  toJson          String   @default("[]")
  ccJson          String   @default("[]")
  bccJson         String   @default("[]")
  subject         String
  bodySnapshot    String
  attachmentsJson String   @default("[]") // [{name, sha256, bytes}]
  status          String   @default("QUEUED") // QUEUED | SENT | DELIVERED | BOUNCED | FAILED
  providerId      String?
  error           String?
  sentAt          DateTime?
  createdAt       DateTime @default(now())

  @@index([orgId])
  @@index([docType, docId])
}

/// Zusatzadressen eines Kunden. Die Hauptadresse bleibt in Customer.
model CustomerAddress {
  id           String   @id @default(cuid())
  orgId        String
  org          Organization @relation(fields: [orgId], references: [id])
  customerId   String
  customer     Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  type         String   // BILLING | SHIPPING | OTHER
  label        String?
  addressLine1 String
  addressLine2 String?
  postalCode   String
  city         String
  countryCode  String   @default("DE")
  isDefault    Boolean  @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([orgId])
  @@index([customerId])
}

model ContactPerson {
  id         String   @id @default(cuid())
  orgId      String
  org        Organization @relation(fields: [orgId], references: [id])
  customerId String
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  firstName  String
  lastName   String
  role       String?
  phone      String?
  mobile     String?
  email      String?
  isDefault  Boolean  @default(false)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([orgId])
  @@index([customerId])
}

/// Zahlungsmethoden als Stammdaten. Systemeintraege (isSystem) entstehen je Organisation.
model PaymentMethod {
  id               String   @id @default(cuid())
  orgId            String
  org              Organization @relation(fields: [orgId], references: [id])
  code             String
  name             String
  description      String?
  paymentTermsDays Int?
  invoiceText      String?
  bankAccountRef   String?
  untdidCode       String   @default("ZZZ") // UNTDID 4461 (BT-81)
  isSystem         Boolean  @default(false)
  isActive         Boolean  @default(true)
  sortOrder        Int      @default(0)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  customers Customer[]

  @@unique([orgId, code])
  @@index([orgId])
}

/// Konfigurierbare Mahnstufen. Dunning.level bleibt als historischer Wert bestehen.
model DunningStage {
  id                 String   @id @default(cuid())
  orgId              String
  org                Organization @relation(fields: [orgId], references: [id])
  order              Int
  name               String
  daysAfterDue       Int
  newDueDays         Int      @default(14)
  feeCents           Int      @default(0)
  calculateInterest  Boolean
  includeB2BFlatFee  Boolean
  emailTemplateId    String?
  emailTemplate      EmailTemplate? @relation(fields: [emailTemplateId], references: [id])
  documentTemplateId String?
  enabled            Boolean  @default(true)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  dunnings Dunning[]

  @@unique([orgId, order])
  @@index([orgId])
}
```

Danach Postgres-Schema ableiten und Gleichheit prüfen (siehe Randbedingungen).

- [ ] **Schritt 7: SQLite-Migrationen**

```bash
npx prisma migrate dev --name phase1_foundation_models --skip-generate
npx prisma migrate dev --name phase1_backfill --create-only --skip-generate
```

Inhalt von `prisma/migrations/<ts>_phase1_backfill/migration.sql` vollständig:

```sql
-- Phase 1 Backfill (SQLite). Idempotent: jede Anweisung prueft Existenz.
-- 1) Vorhandene Verknuepfungen in DocumentRelation spiegeln (Altfelder bleiben).
INSERT INTO "DocumentRelation" ("id","orgId","fromType","fromId","toType","toId","relationType","createdAt")
SELECT 'rel_conv_' || q."id", q."orgId", 'QUOTE', q."id", 'INVOICE', q."convertedToInvoiceId", 'CONVERTED_TO', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM "Quote" q WHERE q."convertedToInvoiceId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "DocumentRelation" r WHERE r."fromType"='QUOTE' AND r."fromId"=q."id" AND r."relationType"='CONVERTED_TO');
INSERT INTO "DocumentRelation" ("id","orgId","fromType","fromId","toType","toId","relationType","createdAt")
SELECT 'rel_corr_' || i."id", i."orgId", 'INVOICE', i."id", 'INVOICE', i."correctsInvoiceId", 'CORRECTS', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM "Invoice" i WHERE i."correctsInvoiceId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "DocumentRelation" r WHERE r."fromType"='INVOICE' AND r."fromId"=i."id" AND r."relationType"='CORRECTS');
INSERT INTO "DocumentRelation" ("id","orgId","fromType","fromId","toType","toId","relationType","createdAt")
SELECT 'rel_rev_' || i."id", i."orgId", 'INVOICE', i."reversedByInvoiceId", 'INVOICE', i."id", 'REVERSES', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM "Invoice" i WHERE i."reversedByInvoiceId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "DocumentRelation" r WHERE r."fromType"='INVOICE' AND r."fromId"=i."reversedByInvoiceId" AND r."toId"=i."id" AND r."relationType"='REVERSES');
INSERT INTO "DocumentRelation" ("id","orgId","fromType","fromId","toType","toId","relationType","createdAt")
SELECT 'rel_gen_' || i."id", i."orgId", 'INVOICE', i."id", 'RECURRING', i."recurringInvoiceId", 'GENERATED_BY', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM "Invoice" i WHERE i."recurringInvoiceId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "DocumentRelation" r WHERE r."fromType"='INVOICE' AND r."fromId"=i."id" AND r."relationType"='GENERATED_BY');

-- 2) Systemzahlungsmethoden je Organisation (Codes/Namen = src/domain/masterdata/defaults.ts).
INSERT INTO "PaymentMethod" ("id","orgId","code","name","untdidCode","isSystem","isActive","sortOrder","createdAt","updatedAt")
SELECT 'pm_' || o."id" || '_' || m.code, o."id", m.code, m.name, m.untdid, 1, 1, m.sort,
       CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM "Organization" o,
  (SELECT 'TRANSFER' AS code, 'Ueberweisung' AS name, '58' AS untdid, 1 AS sort
   UNION ALL SELECT 'CASH','Barzahlung','10',2
   UNION ALL SELECT 'CARD','EC-/Debitkarte','48',3
   UNION ALL SELECT 'CREDIT_CARD','Kreditkarte','54',4
   UNION ALL SELECT 'PAYPAL','PayPal','68',5
   UNION ALL SELECT 'SEPA','SEPA-Lastschrift','59',6
   UNION ALL SELECT 'PREPAID','Bereits bezahlt','ZZZ',7
   UNION ALL SELECT 'OTHER','Sonstige','ZZZ',8) m
WHERE NOT EXISTS (SELECT 1 FROM "PaymentMethod" p WHERE p."orgId"=o."id" AND p."code"=m.code);

-- 3) Standard-Mahnstufen je Organisation (Werte = DEFAULT_DUNNING_STAGES).
INSERT INTO "DunningStage" ("id","orgId","order","name","daysAfterDue","newDueDays","feeCents","calculateInterest","includeB2BFlatFee","enabled","createdAt","updatedAt")
SELECT 'ds_' || o."id" || '_' || s.ord, o."id", s.ord, s.name, s.days, 14, 0, s.interest, s.flat, 1,
       CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM "Organization" o,
  (SELECT 0 AS ord, 'Zahlungserinnerung' AS name, 3 AS days, 0 AS interest, 0 AS flat
   UNION ALL SELECT 1,'1. Mahnung',10,1,1
   UNION ALL SELECT 2,'2. Mahnung',10,1,1
   UNION ALL SELECT 3,'3. Mahnung',7,1,1) s
WHERE NOT EXISTS (SELECT 1 FROM "DunningStage" d WHERE d."orgId"=o."id" AND d."order"=s.ord);

-- 4) Bestandsmahnungen der passenden Stufe zuordnen (level -> order derselben Organisation).
UPDATE "Dunning" SET "stageId" = 'ds_' || (SELECT i."orgId" FROM "Invoice" i WHERE i."id"="Dunning"."invoiceId") || '_' || "level"
WHERE "stageId" IS NULL AND "level" BETWEEN 0 AND 3;
```

`npx prisma migrate deploy && npx prisma generate`.

- [ ] **Schritt 8: Postgres-Migrationen**

Wegwerf-Postgres (CONTRIBUTING.md), Baseline + Phase 0 per `migrate deploy --config`, dann:

```bash
npm run db:migrate:pg -- --name phase1_foundation_models
npx prisma migrate dev --config prisma.postgres.config.ts --name phase1_backfill --create-only --skip-generate
```

Inhalt der Postgres-Backfill-Migration: dieselben vier Blöcke mit genau diesen Unterschieden — `CAST(strftime('%s','now') AS INTEGER) * 1000` → `NOW()`; Boolean-Literale `1`/`0` → `TRUE`/`FALSE` (in den `SELECT`-Spalten **und** in den UNION-Zeilen: `s.interest`/`s.flat` als `TRUE`/`FALSE`, Spalten `isSystem`/`isActive`/`enabled` als `TRUE`); in Block 4 `|| "level"` → `|| "level"::text`; UNION-Spaltentypen einmal explizit casten (`'TRANSFER'::text AS code`, `1::int AS sort`, `0::int AS ord`, `FALSE::boolean AS interest`). Anwenden, Container abräumen, `npx prisma generate`.

- [ ] **Schritt 9: Tests grün, Commit**

`npm run typecheck && npm run lint && npm test` → grün (68 + neue). Commit:

```bash
git add prisma src/schemas/index.ts src/domain/numbering.ts src/domain/masterdata/defaults.ts test/unit/numbering.test.ts test/unit/masterdata.test.ts
git commit -s -m "feat(db): Phase-1-Datenmodelle mit Backfill, Parser {SEQ:n}/{DD}, DocType angepasst"
```

---

### Task 2: Dokumentverknüpfungen — `linkDocuments` und Dual-Write

**Dateien:**
- Erstellen: `src/domain/relations.ts`
- Ändern: `src/domain/document/convert.ts`, `src/domain/invoice/cancel.ts`, `src/domain/invoice/credit.ts`, `src/domain/recurring/run.ts`
- Test: `test/unit/relations.test.ts`, `test/integration/phase1.test.ts` (neu)

**Schnittstellen:**
- Erzeugt: `linkDocuments(tx, { orgId, fromType, fromId, toType, toId, relationType })`, `listRelations(docType, docId)`, `assertDocExists(tx, type, id)`.

- [ ] **Schritt 1: Failing Tests**

`test/unit/relations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tableForRefType } from "@/domain/relations";

describe("relations", () => {
  it("ordnet jeden DocRefType einer Tabelle zu", () => {
    expect(tableForRefType("QUOTE")).toBe("quote");
    expect(tableForRefType("INVOICE")).toBe("invoice");
    expect(tableForRefType("RECURRING")).toBe("recurringInvoice");
    expect(tableForRefType("DELIVERY_NOTE")).toBe("deliveryNote");
    expect(tableForRefType("DUNNING")).toBe("dunning");
  });
});
```

`test/integration/phase1.test.ts` (Setup wie `snapshot.test.ts`; Datumsfix in einem eigenen Jahr, z. B. 2028, wegen globaler Nummern-Eindeutigkeit):

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocumentToInvoice } from "@/domain/document/convert";
import { listRelations } from "@/domain/relations";

const FIX = new Date("2028-03-01T10:00:00.000Z");
const line = { description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };
async function setup() { /* Org + Kunde wie snapshot.test.ts */ }

describe("Phase 1 — Verknuepfungen", () => {
  let orgId = ""; let customerId = "";
  beforeAll(async () => { ({ orgId, customerId } = await setup()); });

  it("Angebot -> Rechnung schreibt Altfeld UND DocumentRelation", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, lines: [line] });
    const inv = await convertDocumentToInvoice(q.id, { now: FIX });
    const rel = await listRelations("QUOTE", q.id);
    expect(rel).toEqual([expect.objectContaining({ toType: "INVOICE", toId: inv.id, relationType: "CONVERTED_TO" })]);
    const q2 = await dbInternal.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(q2.convertedToInvoiceId).toBe(inv.id);
  });

  it("Storno schreibt REVERSES und CORRECTS", async () => {
    const inv = await createDraftInvoice(orgId, { customerId, lines: [line], deliveryDate: FIX });
    await finalizeInvoice(inv.id, { now: FIX });
    const { creditNote } = await cancelInvoice(inv.id, { now: FIX });
    const rels = await listRelations("INVOICE", creditNote.id);
    expect(rels.map((r) => r.relationType).sort()).toEqual(["CORRECTS", "REVERSES"]);
  });

  it("Backfill-Migration spiegelt Altfelder idempotent", async () => {
    const q = await createBusinessDocument(orgId, { kind: "ANGEBOT", customerId, lines: [line] });
    const inv = await convertDocumentToInvoice(q.id, { now: FIX });
    await dbInternal.documentRelation.deleteMany({ where: { fromId: q.id } });
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_phase1_backfill"))!;
    const sql = readFileSync(join("prisma/migrations", dir, "migration.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const run = async () => { for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) await dbInternal.$executeRawUnsafe(s); };
    await run(); await run(); // zweimal: idempotent
    const rel = await listRelations("QUOTE", q.id);
    expect(rel).toHaveLength(1);
    expect(rel[0].toId).toBe(inv.id);
    expect(await dbInternal.paymentMethod.count({ where: { orgId } })).toBe(8);
    expect(await dbInternal.dunningStage.count({ where: { orgId } })).toBe(4);
  });
});
```

- [ ] **Schritt 2: Fehlschlag bestätigen** — `npx vitest run test/unit/relations.test.ts test/integration/phase1.test.ts` → FAIL.

- [ ] **Schritt 3: `src/domain/relations.ts`**

```ts
/**
 * Generische Belegverknuepfungen (Phase 1). Polymorph ueber Typ+ID; Existenz wird hier
 * geprueft, weil das Schema keinen Fremdschluessel auf mehrere Tabellen kennt.
 * Die Altfelder an den Belegen bleiben und werden von den Services parallel gesetzt.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { DocRefType, RelationType } from "@/schemas";
import type { z } from "zod";

type RefType = z.infer<typeof DocRefType>;
type RelType = z.infer<typeof RelationType>;
type Tx = Prisma.TransactionClient;

const TABLE: Record<RefType, "quote" | "invoice" | "recurringInvoice" | "deliveryNote" | "dunning"> = {
  QUOTE: "quote", INVOICE: "invoice", RECURRING: "recurringInvoice", DELIVERY_NOTE: "deliveryNote", DUNNING: "dunning",
};
export function tableForRefType(t: RefType) { return TABLE[t]; }

export class RelationError extends Error { constructor(m: string) { super(m); this.name = "RelationError"; } }

export async function assertDocExists(tx: Tx, type: RefType, id: string): Promise<void> {
  const table = tableForRefType(type);
  // Prisma-Delegates sind strukturell gleich fuer findUnique({ where: { id } }).
  const found = await (tx[table] as unknown as { findUnique: (a: { where: { id: string }; select: { id: true } }) => Promise<{ id: string } | null> })
    .findUnique({ where: { id }, select: { id: true } });
  if (!found) throw new RelationError(`${type} ${id} existiert nicht.`);
}

export async function linkDocuments(
  tx: Tx,
  rel: { orgId: string; fromType: RefType; fromId: string; toType: RefType; toId: string; relationType: RelType },
) {
  await assertDocExists(tx, rel.fromType, rel.fromId);
  await assertDocExists(tx, rel.toType, rel.toId);
  return tx.documentRelation.upsert({
    where: { fromType_fromId_toType_toId_relationType: { fromType: rel.fromType, fromId: rel.fromId, toType: rel.toType, toId: rel.toId, relationType: rel.relationType } },
    create: rel,
    update: {},
  });
}

export function listRelations(docType: RefType, docId: string) {
  return dbInternal.documentRelation.findMany({
    where: { OR: [{ fromType: docType, fromId: docId }, { toType: docType, toId: docId }] },
    orderBy: { createdAt: "asc" },
  });
}
```

(Der Name des zusammengesetzten Unique-Keys ergibt sich aus dem Schema: `fromType_fromId_toType_toId_relationType`.)

- [ ] **Schritt 4: Dual-Write**

`convert.ts`: nach `tx.quote.update(... convertedToInvoiceId ...)`:
```ts
    await linkDocuments(tx, { orgId: q.orgId, fromType: "QUOTE", fromId: documentId, toType: "INVOICE", toId: invoice.id, relationType: "CONVERTED_TO" });
```
`cancel.ts`: nach dem Setzen von `reversedByInvoiceId`/`correctsInvoiceId` (innerhalb derselben Transaktion, vor `appendChangeLog`):
```ts
    await linkDocuments(tx, { orgId: original.orgId, fromType: "INVOICE", fromId: credit.id, toType: "INVOICE", toId: original.id, relationType: "REVERSES" });
    await linkDocuments(tx, { orgId: original.orgId, fromType: "INVOICE", fromId: credit.id, toType: "INVOICE", toId: original.id, relationType: "CORRECTS" });
```
`credit.ts`: analog nur `CORRECTS`. `recurring/run.ts`: nach `tx.invoice.create` mit `recurringInvoiceId`:
```ts
      await linkDocuments(tx, { orgId: rec.orgId, fromType: "INVOICE", fromId: invoice.id, toType: "RECURRING", toId: rec.id, relationType: "GENERATED_BY" });
```
Variablennamen (`original`, `credit`, `rec`, `invoice`) an die jeweilige Datei anpassen; die Domain-Fehlerklasse der Datei bleibt.

- [ ] **Schritt 5: Tests grün, Commit**

`npm test` → grün. `git add src/domain/relations.ts src/domain/document/convert.ts src/domain/invoice/cancel.ts src/domain/invoice/credit.ts src/domain/recurring/run.ts test/unit/relations.test.ts test/integration/phase1.test.ts && git commit -s -m "feat(domain): DocumentRelation mit linkDocuments, Dual-Write in Konvertierung, Storno, Gutschrift, Abo"`

---

### Task 3: Lieferschein-Service

**Dateien:**
- Erstellen: `src/domain/delivery-note/create.ts`
- Test: `test/integration/phase1.test.ts` (erweitern)

- [ ] **Schritt 1: Failing Test** — im `describe` von `phase1.test.ts`:

```ts
  it("Lieferschein bekommt LS-Nummer, Snapshot CREATE und ChangeLog", async () => {
    const { createDeliveryNote } = await import("@/domain/delivery-note/create");
    const dn = await createDeliveryNote(orgId, { customerId, lines: [{ description: "Router", quantityMilli: 2000, unit: "C62" }] }, { now: FIX });
    expect(dn.number).toBe("LS-2028-0001");
    expect(dn.snapshotSource).toBe("CREATE");
    expect(dn.lines).toHaveLength(1);
    const log = await dbInternal.changeLog.findFirst({ where: { entity: "DELIVERY_NOTE", entityId: dn.id } });
    expect(log?.action).toBe("CREATE");
  });
```

- [ ] **Schritt 2: Fehlschlag bestätigen.**

- [ ] **Schritt 3: Service** — `src/domain/delivery-note/create.ts` nach dem Muster von `document/create.ts` (Kunde mit `orgId`-Scope laden, Organisation laden, `NumberRange` upsert mit `docType: "DELIVERY_NOTE"`, `formatDocumentNumber(... day: now.getDate())`, `status: "CREATED"`, Snapshots via `buildSellerSnapshot`/`buildBuyerSnapshot`, `snapshotSource: "CREATE" satisfies SnapshotSource`, `snapshotAt: now`, `lines: { create: ... }` mit `position: i + 1`), danach `appendChangeLog(tx, { entity: "DELIVERY_NOTE", action: "CREATE", diff: { number } })`. Eingabe per `createDeliveryNoteSchema` typisiert (`CreateDeliveryNoteInput`). Fehlerklasse `DeliveryNoteError`.

- [ ] **Schritt 4: Tests grün, Commit** — `git commit -s -m "feat(domain): Lieferschein anlegen (Nummernkreis LS-, Snapshot, ChangeLog)"`

---

### Task 4: Stammdaten sicherstellen und Zahlungsmethode prüfen

**Dateien:**
- Erstellen: `src/domain/masterdata/ensure.ts`
- Ändern: `src/app/actions/masterdata.ts` (`saveOrganization`), `src/mcp/server.ts` (`setup_company`), `src/domain/invoice/payment.ts`
- Test: `test/integration/phase1.test.ts` (erweitern)

- [ ] **Schritt 1: Failing Tests**

```ts
  it("neue Organisation bekommt Systemzahlungsmethoden und Mahnstufen", async () => {
    const { ensureOrgMasterdata } = await import("@/domain/masterdata/ensure");
    const org = await dbInternal.organization.create({ data: { legalName: "Neu GmbH", addressLine1: "A 1", postalCode: "1", city: "B" } });
    await ensureOrgMasterdata(dbInternal, org.id);
    await ensureOrgMasterdata(dbInternal, org.id); // idempotent
    expect(await dbInternal.paymentMethod.count({ where: { orgId: org.id, isSystem: true } })).toBe(8);
    expect(await dbInternal.dunningStage.count({ where: { orgId: org.id } })).toBe(4);
  });

  it("recordPayment lehnt unbekannte Zahlungsmethode ab und akzeptiert Systemcode", async () => {
    const { recordPayment } = await import("@/domain/invoice/payment");
    const { ensureOrgMasterdata } = await import("@/domain/masterdata/ensure");
    await ensureOrgMasterdata(dbInternal, orgId);
    const inv = await createDraftInvoice(orgId, { customerId, lines: [line], deliveryDate: FIX });
    await finalizeInvoice(inv.id, { now: FIX });
    await expect(recordPayment(inv.id, { amountCents: 100, method: "GIBTSNICHT", isSkonto: false })).rejects.toThrow(/Zahlungsmethode/);
    await expect(recordPayment(inv.id, { amountCents: 100, method: "PAYPAL", isSkonto: false })).resolves.toBeTruthy();
  });
```

- [ ] **Schritt 2: Fehlschlag bestätigen.**

- [ ] **Schritt 3: `ensure.ts`**

```ts
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { SYSTEM_PAYMENT_METHODS, DEFAULT_DUNNING_STAGES } from "./defaults";

type Db = PrismaClient | Prisma.TransactionClient;

/** Legt Systemzahlungsmethoden und Standard-Mahnstufen fuer eine Organisation an (idempotent). */
export async function ensureOrgMasterdata(db: Db, orgId: string): Promise<void> {
  for (const m of SYSTEM_PAYMENT_METHODS) {
    await db.paymentMethod.upsert({
      where: { orgId_code: { orgId, code: m.code } },
      create: { orgId, code: m.code, name: m.name, untdidCode: m.untdidCode, isSystem: true, sortOrder: m.sortOrder },
      update: {},
    });
  }
  for (const s of DEFAULT_DUNNING_STAGES) {
    await db.dunningStage.upsert({
      where: { orgId_order: { orgId, order: s.order } },
      create: { orgId, ...s },
      update: {},
    });
  }
}
```

- [ ] **Schritt 4: Aufrufer** — in `saveOrganization` nach `organization.create` und in `setup_company` nach `organization.create`: `await ensureOrgMasterdata(dbInternal, created.id)` (Variablenname anpassen).

- [ ] **Schritt 5: `recordPayment`** — vor dem Anlegen des Payments:

```ts
    const method = await tx.paymentMethod.findFirst({ where: { orgId: invoice.orgId, code: input.method, isActive: true }, select: { id: true } });
    if (!method) throw new PaymentError(`Zahlungsmethode "${input.method}" ist nicht bekannt oder inaktiv.`);
```
(`invoice.orgId` liegt im geladenen Invoice vor; falls das Invoice nur per `select` geladen wird, `orgId` ergänzen. `PaymentError` ist die bestehende Fehlerklasse der Datei.) **Bestehende Tests** (`gobd.test.ts` nutzt `recordPayment` mit `TRANSFER`): Deren Setup legt Organisationen direkt per `dbInternal.organization.create` an — ohne Systemdaten. Damit sie grün bleiben, ruft `recordPayment` bei fehlendem Treffer **einmalig** `ensureOrgMasterdata(tx, invoice.orgId)` und prüft erneut, bevor es wirft (Selbstheilung für Bestandsinstanzen, deren Migration die Methoden angelegt hat, ist damit ebenfalls abgedeckt).

- [ ] **Schritt 6: Tests grün, Commit** — `git commit -s -m "feat(masterdata): Systemzahlungsmethoden und Mahnstufen je Organisation, Zahlungsmethode wird geprueft"`

---

### Task 5: Postgres-Test Fall 6, Doku, Prüfkette

**Dateien:**
- Ändern: `scripts/test-postgres-migrations.sh`, `docs/LIMITATIONEN.md`, `docs/ARCHITEKTUR.md` (Abschnitt 1: neue Modelle, ein Absatz)

- [ ] **Schritt 1: Legacy-Rows erweitern** — im Legacy-INSERT-Block zusätzlich eine konvertierte Quote, eine Zahlung und eine Mahnung (`level` 1) anlegen (NOT-NULL-Spalten gegen `0_init` prüfen):

```sql
INSERT INTO "Quote" ("id","orgId","customerId","kind","number","status","convertedToInvoiceId","updatedAt")
  VALUES ('q1','org1','cust1','ANGEBOT','AN-2026-0001','CONVERTED','inv1',NOW());
INSERT INTO "Payment" ("id","invoiceId","amountCents","method") VALUES ('pay1','inv1',100,'TRANSFER');
INSERT INTO "Dunning" ("id","invoiceId","level") VALUES ('dun1','inv1',1);
```

- [ ] **Schritt 2: Fall 6** vor `echo "ALLE TESTS BESTANDEN"`:

```bash
echo "==> Fall 6: Phase-1-Backfill (Relationen, Stammdaten, Mahnstufen)"
REL=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select \"relationType\" from \"DocumentRelation\" where \"fromId\"='q1'")
[ "$REL" = "CONVERTED_TO" ] || fail "Relation fuer q1 fehlt ('$REL')"
PM=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"PaymentMethod\" where \"orgId\"='org1'")
[ "$PM" = "8" ] || fail "erwartet 8 Zahlungsmethoden, gefunden $PM"
DS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from \"DunningStage\" where \"orgId\"='org1'")
[ "$DS" = "4" ] || fail "erwartet 4 Mahnstufen, gefunden $DS"
ST=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"stageId\" from \"Dunning\" where id='dun1'")
[ "$ST" = "ds_org1_1" ] || fail "Dunning dun1 hat stageId '$ST', erwartet ds_org1_1"
echo "    ok — Backfill vollstaendig"
```

Fall 1 erwartet jetzt **24** Tabellen (15 + 9 neue), Fall 2 **23** — Werte anpassen.

- [ ] **Schritt 3: Doku** — `docs/LIMITATIONEN.md`: Absatz „Daten & Recht" um „Phase 1: Verknüpfungen zusätzlich in `DocumentRelation`; Zahlungsmethoden und Mahnstufen sind Stammdaten (noch ohne UI, Phasen 4/6); Lieferscheine existieren als Datenmodell + Service, UI folgt in Phase 3". `docs/ARCHITEKTUR.md` Abschnitt 1: die neun Modelle in einem Absatz nennen.

- [ ] **Schritt 4: Prüfkette** — `npm run typecheck && npm run lint && npm test && npm run build && npm run validate:erechnung && ./scripts/test-postgres-migrations.sh` → alles grün, Fälle 1–6.

- [ ] **Schritt 5: Commit** — `git commit -s -m "test(postgres): Phase-1-Backfill pruefen; docs: Phase-1-Modelle"`

---

## Nach Abschluss

- [ ] Push `phase-1/foundation`, Abschluss-Review, Merge in `main`
- [ ] Deployment: `./update.sh` (Migration additiv, Backfill legt Stammdaten an) — vorher ankündigen
