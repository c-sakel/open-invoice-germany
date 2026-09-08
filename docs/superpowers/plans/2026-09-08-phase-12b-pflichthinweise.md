# Phase 12b — Pflichthinweise, Steuerschemata und E-Rechnungs-Konformität

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die steuerlichen Pflichthinweise (§ 14 Abs. 4 Nr. 8, § 14a UStG) korrekt und prüfbar machen und die drei verifizierten EN-16931-Lücken schließen, die heute erzeugbare Belege KoSIT-**ungültig** machen: Kategorie `S` bei 0 % für Differenzbesteuerung (BR-S-05), fehlendes BG-14 (BT-73/BT-74), fehlendes BT-80. Dazu: neues Schema `AUSFUHR`, BT-121 (VATEX), das tote Feld `consumerRetentionHint` (§ 14b) verdrahtet, „Gutschrift / Storno" im PDF-Titel entschärft (COMPLIANCE § 11), fünf neue KoSIT-Fixtures als CI-Gate.

**Architecture:** `src/domain/invoice/mandatory.ts` bleibt die **einzige** Quelle für Hinweistexte (`SCHEME_NOTICE`) und bekommt daneben `SCHEME_NOTICE_ACCEPTED` (zulässige Formulierungen als RegExp über normalisiertem Text); die heutige Erst-Wort-Heuristik entfällt. `src/lib/tax.ts` trägt Kategorie-Defaults, `ZERO_TAX_SCHEMES` (heute ein toter Export — wird hier zur wirksamen Prüfung) und die EU-Länderlisten. Die neue Datei `src/lib/einvoice/exemption.ts` ersetzt die wortgleiche `exemptionReason`-Dublette in `xrechnung.ts:56` und `cii.ts:42` und liefert zusätzlich BT-121. BG-14/BT-80 wandern additiv durch `types.ts` → `mapper.ts` → beide Builder.

**Tech Stack:** TypeScript strict, Zod, Prisma (SQLite + Postgres), `xmlbuilder2` über die bestehenden Builder, pdfkit, Vitest (Node), KoSIT-Validator über `npm run validate:erechnung`.

**Spec:** `docs/superpowers/specs/2026-09-08-phase-12-feinschliff-design.md` — Paket **B** (Abschnitt 2: „Neue Steuerschemata", „Pflichthinweis-Texte", „Pflichtangaben-Prüfung", „Aufbewahrungshinweis § 14b", „Wortlaut Gutschrift", „E-Rechnung-Lücken", „Schema-Auswahl in der UI"), Struktur Abschnitt 3 Block B, Migrationen Abschnitt 3 unten, Tests Abschnitt 4 B, Teilphase 2 in Abschnitt 5, DoD Abschnitt 6.

## Global Constraints

- Branch `phase-12b/pflichthinweise` aus Fork-`main`, **nachdem** `phase-12a/feinschliff` gemergt ist. Jeder Commit mit `git commit -s`. Keine neue Abhängigkeit.
- **GoBD (§51):** festgeschriebene Belege werden nicht angefasst. Der Pflichthinweis bleibt Teil des gespeicherten `notes`-Textes (Snapshot), er wird **nicht** zur Renderzeit erzeugt. Die Kategorie-Korrektur `DIFFERENZ: S → E` läuft nur auf Entwürfe (`Invoice.status='DRAFT'`, `Quote.status='DRAFT'`). `RecurringInvoiceLine` ist eine Vorlage ohne GoBD-Charakter (`RecurringInvoice.status` kennt nur ACTIVE/PAUSED/ENDED) und wird vollständig migriert — **Ruling**, weil die Spec dort ein `status='DRAFT'` verlangt, das es im Schema nicht gibt.
- **E-Rechnung (§52):** alle Mapper-Änderungen additiv. `npm run validate:erechnung` bleibt CI-Gate und muss für **alle** Fixtures ACCEPTABLE liefern. Einzige Verhaltensänderung an Bestandsbelegen: der `cac:Delivery`/`ram:ShipToTradeParty`-Block mit BT-80 erscheint ab jetzt auf jedem Beleg.
- **XML-Reihenfolge ist XSD-fatal.** Verbindlich:
  - UBL `Invoice`/`CreditNote`: `cbc:BuyerReference` → **`cac:InvoicePeriod`** → `cac:OrderReference` → `cac:BillingReference` → Parteien → **`cac:Delivery`** → `cac:PaymentMeans`.
  - UBL `cac:TaxCategory`: `cbc:ID` → `cbc:Percent` → **`cbc:TaxExemptionReasonCode`** → **`cbc:TaxExemptionReason`** → `cac:TaxScheme` (Code **vor** Text).
  - UBL `cac:Delivery`: `cbc:ActualDeliveryDate` → `cac:DeliveryLocation`.
  - CII `ram:ApplicableHeaderTradeDelivery`: **`ram:ShipToTradeParty`** → `ram:ActualDeliverySupplyChainEvent`.
  - CII `ram:ApplicableTradeTax`: `CalculatedAmount` → `TypeCode` → `ExemptionReason` → `BasisAmount` → `CategoryCode` → **`ExemptionReasonCode`** → `RateApplicablePercent`.
  - CII `ram:ApplicableHeaderTradeSettlement`: … `ram:ApplicableTradeTax` → **`ram:BillingSpecifiedPeriod`** → `ram:SpecifiedTradeAllowanceCharge` → `ram:SpecifiedTradePaymentTerms` → `…MonetarySummation`.
- **Zod an jeder Boundary (§50):** `TaxScheme`/`TaxCategory`/`consumerRetentionHint` in `src/schemas/index.ts`; API v1 und MCP nutzen dieselben Schemas. Diese heißen **`createInvoiceSchema`/`updateInvoiceSchema`** — nicht `create/updateInvoiceInputSchema` wie in der Spec und im Kommentar `HeadTextBlock.tsx:17`; der Kommentar wird mitkorrigiert („Code schlägt Doku").
- **Migration (§53):** ein Paar unter `prisma/migrations/` und `prisma/migrations-postgres/` — hier nur die Datenmigration `phase12b_differenz_category` (`taxScheme`/`taxCategory` sind Strings, `AUSFUHR`/`O` brauchen keine DDL). Beide Schemadateien bleiben deckungsgleich. Anwenden mit `npx prisma migrate deploy` (nicht `npm run db:migrate` — interaktiv).
- **Interne Notizen (§48)** bleiben aus PDF und XML. TypeScript strict, kein `any`, Dateien ≤ ~250 Zeilen, deutsche Texte mit echten Umlauten.
- Prüfkette **im Vordergrund**: `npm run typecheck && npm run lint && TZ=UTC npm test`; ab Task 3 zusätzlich `npm run validate:erechnung`.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/schemas/index.ts:10-22,327-355` | `TaxScheme` += `AUSFUHR`, `TaxCategory` += `O`, `consumerRetentionHint` in `invoiceHeaderFields` |
| `src/lib/tax.ts:11-18,123-145` | `TaxCategory` += `"O"`, `defaultCategoryForScheme` (DIFFERENZ→E, AUSFUHR→G), `ZERO_TAX_SCHEMES` += DIFFERENZ/AUSFUHR, `EU_COUNTRY_CODES`, `EU_VAT_PREFIXES` |
| `src/domain/invoice/mandatory.ts` | `SCHEME_NOTICE` (sechs Texte), `SCHEME_NOTICE_ACCEPTED`, `normalizeNotice`, `CONSUMER_RETENTION_HINT`, vier neue Blocker |
| `prisma/migrations{,-postgres}/…_phase12b_differenz_category/migration.sql` | Datenmigration S→E auf Entwürfen |
| `src/lib/einvoice/exemption.ts` | **neu** — `exemptionReasonText` (BT-120) + `exemptionReasonCode` (BT-121, VATEX) |
| `src/lib/einvoice/{types,mapper,xrechnung,cii,load}.ts` | BG-14, BT-80, BT-121, `consumerRetentionHint`, `creditNoteKind` |
| `src/lib/pdf/invoice-pdf.ts` | Titel/Nummernlabel Storno vs. Korrektur, § 14b-Block |
| `src/components/editor/blocks/{MetaBlock,MoreOptions,HeadTextBlock}.tsx` | sieben Schemata, „Pflichthinweis einfügen", § 14b-Schalter, Kommentarkorrektur |
| `src/lib/editor/draft.ts`, `src/domain/invoice/{create,update}.ts`, `src/mcp/tools/invoices.ts` | `consumerRetentionHint` end-to-end |
| `scripts/{generate-sample-xrechnung,validate-erechnung}.ts`, `scripts/test-postgres-migrations.sh` | fünf Fixtures, Postgres-Fall 17 |
| `COMPLIANCE.md`, `docs/{ANLEITUNG,LIMITATIONEN}.md` | Recht, Bedienung, Grenzen |
| `test/unit/{tax,mandatory,einvoice,einvoice-exemption}.test.ts`, `test/integration/pdf-theme.test.ts` | Tests |

---

### Task 1: Steuerschemata, Kategorien, Hinweistexte, Datenmigration

**Files:** Modify `src/schemas/index.ts`, `src/lib/tax.ts`, `src/domain/invoice/mandatory.ts:51-58`, `scripts/test-postgres-migrations.sh` (Fall 17) · Create beide `…_phase12b_differenz_category/migration.sql` · Test `test/unit/tax.test.ts`

**Interfaces:**
```ts
export type TaxCategory = "S" | "AE" | "K" | "G" | "E" | "Z" | "O";     // src/lib/tax.ts
export const ZERO_TAX_SCHEMES: ReadonlySet<string>;                      // + DIFFERENZ, AUSFUHR
export const EU_COUNTRY_CODES: ReadonlySet<string>;                      // 27 ISO-alpha-2
export const EU_VAT_PREFIXES: ReadonlySet<string>;                       // wie oben, EL statt GR, + XI
export const SCHEME_NOTICE: Record<string, string>;                      // src/domain/invoice/mandatory.ts
export const SCHEME_NOTICE_ACCEPTED: Record<string, RegExp[]>;
export function normalizeNotice(text: string): string;
```

- [ ] **Step 1: Failing tests schreiben** (an `test/unit/tax.test.ts` anhängen)

```ts
import { defaultCategoryForScheme, ZERO_TAX_SCHEMES, EU_COUNTRY_CODES, EU_VAT_PREFIXES } from "@/lib/tax";
import { SCHEME_NOTICE, SCHEME_NOTICE_ACCEPTED, normalizeNotice } from "@/domain/invoice/mandatory";

describe("Steuerkategorie, Listen und Hinweistexte (Phase 12b)", () => {
  it("DIFFERENZ ist E (BR-S-05: S verlangt Satz > 0), AUSFUHR ist G, Bestand unveraendert", () => {
    expect(["REGULAR", "KLEINUNTERNEHMER", "REVERSE_CHARGE", "IG_LIEFERUNG", "IG_LEISTUNG", "DIFFERENZ", "AUSFUHR"].map(defaultCategoryForScheme))
      .toEqual(["S", "E", "AE", "K", "AE", "E", "G"]);
  });
  it("ZERO_TAX_SCHEMES deckt alle sechs Nullsatz-Schemata ab, nicht REGULAR", () => {
    for (const s of ["KLEINUNTERNEHMER", "REVERSE_CHARGE", "IG_LIEFERUNG", "IG_LEISTUNG", "DIFFERENZ", "AUSFUHR"]) expect(ZERO_TAX_SCHEMES.has(s)).toBe(true);
    expect(ZERO_TAX_SCHEMES.has("REGULAR")).toBe(false);
  });
  it("EU-Listen: 27 Laender, CH draussen, EL/XI nur als VAT-Praefix", () => {
    expect([EU_COUNTRY_CODES.size, EU_COUNTRY_CODES.has("GR"), EU_COUNTRY_CODES.has("CH")]).toEqual([27, true, false]);
    expect([EU_VAT_PREFIXES.has("EL"), EU_VAT_PREFIXES.has("XI"), EU_VAT_PREFIXES.has("GR")]).toEqual([true, true, false]);
  });
  it("sechs Schemata tragen einen Text, REGULAR nicht", () => {
    expect(Object.keys(SCHEME_NOTICE).sort()).toEqual(["AUSFUHR", "DIFFERENZ", "IG_LEISTUNG", "IG_LIEFERUNG", "KLEINUNTERNEHMER", "REVERSE_CHARGE"]);
    expect(SCHEME_NOTICE.REGULAR).toBeUndefined();
  });
  it("normalizeNotice faltet Umlaute, ss und Mehrfach-Whitespace", () => {
    expect(normalizeNotice("Steuerfreie   Ausfuhrlieferung")).toBe("steuerfreie ausfuhrlieferung");
    expect(normalizeNotice("Gebrauchtgegenstände/Sonderregelung")).toBe("gebrauchtgegenstaende/sonderregelung");
    expect(normalizeNotice("gemäß Maß")).toBe("gemaess mass");
  });
  it("jeder eigene Text erfuellt sein SCHEME_NOTICE_ACCEPTED; § 25a alle drei Formulierungen (§ 14a Abs. 6)", () => {
    for (const [scheme, text] of Object.entries(SCHEME_NOTICE)) {
      expect(SCHEME_NOTICE_ACCEPTED[scheme].some((re) => re.test(normalizeNotice(text)))).toBe(true);
    }
    for (const t of ["Gebrauchtgegenstände/Sonderregelung", "Kunstgegenstände/Sonderregelung", "Sammlungsstücke und Antiquitäten/Sonderregelung"]) {
      expect(SCHEME_NOTICE_ACCEPTED.DIFFERENZ.some((re) => re.test(normalizeNotice(t)))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/tax.test.ts`.

- [ ] **Step 3: `src/schemas/index.ts`**

```ts
export const TaxScheme = z.enum([
  "REGULAR", "KLEINUNTERNEHMER", "DIFFERENZ", "REVERSE_CHARGE", "IG_LIEFERUNG", "IG_LEISTUNG",
  // Phase 12b — steuerfreie Ausfuhrlieferung ins Drittland
  // (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG), Kategorie G.
  "AUSFUHR",
]);
// UNTDID 5305. "O" (nicht steuerbar) ist in Phase 12b nur fuer den Mapper vorgesehen —
// kein Schema waehlt sie (siehe defaultCategoryForScheme).
export const TaxCategory = z.enum(["S", "AE", "K", "G", "E", "Z", "O"]);
```

- [ ] **Step 4: `src/lib/tax.ts`** — `TaxCategory`-Union um `| "O" // Nicht steuerbar` erweitern, dann:

```ts
/** Steuerschemata, die eine 0-%-/befreite Behandlung erzwingen. Phase 12b: bis hier ein
 *  toter Export — wird jetzt von validateMandatoryFields ausgewertet. */
export const ZERO_TAX_SCHEMES: ReadonlySet<string> = new Set([
  "KLEINUNTERNEHMER", "REVERSE_CHARGE", "IG_LIEFERUNG", "IG_LEISTUNG", "DIFFERENZ", "AUSFUHR",
]);

export function defaultCategoryForScheme(scheme: string): TaxCategory {
  switch (scheme) {
    case "KLEINUNTERNEHMER": return "E";
    case "REVERSE_CHARGE": return "AE";
    case "IG_LIEFERUNG": return "K";
    case "IG_LEISTUNG": return "AE";
    // Phase 12b: DIFFERENZ fiel bisher auf "S" durch — Kategorie S mit 0 % verletzt
    // EN 16931 BR-S-05 und machte jede § 25a-Rechnung als XRechnung ungueltig.
    case "DIFFERENZ": return "E";
    case "AUSFUHR": return "G";
    default: return "S";
  }
}

/** Die 27 EU-Mitgliedstaaten (ISO 3166-1 alpha-2) — Land der Rechnungsanschrift. */
export const EU_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE",
  "IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK",
]);

/** USt-IdNr.-Praefixe: wie EU_COUNTRY_CODES, aber "EL" statt "GR" und zusaetzlich "XI"
 *  (Nordirland, Windsor Framework). */
export const EU_VAT_PREFIXES: ReadonlySet<string> = new Set(
  [...EU_COUNTRY_CODES].filter((c) => c !== "GR").concat(["EL", "XI"]),
);
```
`SCHEME_CATEGORY` (`src/lib/editor/constants.ts:45`) leitet sich aus `TaxSchemeSchema.options.map(defaultCategoryForScheme)` ab und zieht die neuen Werte automatisch nach — nichts zu tun, im Review prüfen.

- [ ] **Step 5: Hinweistexte in `src/domain/invoice/mandatory.ts`** (ersetzt Z. 51–58)

```ts
/**
 * Pflichthinweis-Texte je Steuerschema (§ 14 Abs. 4 Nr. 8, § 14a UStG). EINZIGE Quelle
 * im Projekt — src/lib/editor/constants.ts und src/mcp/tools/invoices.ts importieren von
 * hier. Quellen: COMPLIANCE.md § 1 (§ 14a), § 3 (§ 34a UStDV), § 8 (§ 13b/§ 6a), § 9 (§ 25a).
 */
export const SCHEME_NOTICE: Record<string, string> = {
  // § 14a Abs. 5 UStG — wortgleich vorgeschrieben.
  REVERSE_CHARGE: "Steuerschuldnerschaft des Leistungsempfängers",
  // § 3a Abs. 2 UStG (Leistungsort beim Empfaenger) i. V. m. § 14a Abs. 1/5 UStG.
  IG_LEISTUNG: "Steuerschuldnerschaft des Leistungsempfängers",
  IG_LIEFERUNG: "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG)",
  AUSFUHR: "Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG)",
  // § 34a UStDV (Fassung ab 1.1.2025).
  KLEINUNTERNEHMER: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer",
  // § 14a Abs. 6 Satz 1 UStG — eine der drei zulaessigen Formulierungen.
  DIFFERENZ: "Gebrauchtgegenstände/Sonderregelung (§ 25a UStG)",
};

/** § 14b Abs. 1 Satz 5 UStG (§ 14 Abs. 4 Nr. 9) — Text fuer PDF UND beide XML-Formate. */
export const CONSUMER_RETENTION_HINT =
  "Sie sind verpflichtet, diese Rechnung zwei Jahre aufzubewahren (§ 14b Abs. 1 Satz 5 UStG).";

/** Vergleichsform: klein, Umlaute/ß gefaltet, Whitespace normalisiert. */
export function normalizeNotice(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Zulaessige Formulierungen je Schema (auf normalizeNotice-Text). Ersetzt die frühere
 * Heuristik "erstes Wort des Pflichttextes kommt irgendwo vor" — die liess z. B.
 * "Steuerfreie Lieferung nach Absprache" als ig. Lieferung durchgehen. § 14a Abs. 6 UStG
 * laesst fuer § 25a genau drei Wortlaute zu.
 */
export const SCHEME_NOTICE_ACCEPTED: Record<string, RegExp[]> = {
  REVERSE_CHARGE: [/steuerschuldnerschaft des leistungsempfaengers/],
  IG_LEISTUNG: [/steuerschuldnerschaft des leistungsempfaengers/],
  IG_LIEFERUNG: [/steuerfreie innergemeinschaftliche lieferung/],
  AUSFUHR: [/steuerfreie ausfuhrlieferung/],
  KLEINUNTERNEHMER: [/kleinunternehmer(?=[\s\S]*\b19\b)/],
  DIFFERENZ: [
    /gebrauchtgegenstaende\s*\/\s*sonderregelung/,
    /kunstgegenstaende\s*\/\s*sonderregelung/,
    /sammlungsstuecke und antiquitaeten\s*\/\s*sonderregelung/,
  ],
};
```
**Rückwärtskompatibel:** Bestandsentwürfe mit dem alten, kürzeren IG-Text (ohne Klammerzusatz) erfüllen die Regex weiterhin.

- [ ] **Step 6: Datenmigration (beide Dialekte, inhaltsgleich)**

`prisma/migrations/20260909090000_phase12b_differenz_category/migration.sql` und `prisma/migrations-postgres/20260909090100_phase12b_differenz_category/migration.sql`:
```sql
-- Phase 12b — Differenzbesteuerung (§ 25a UStG): Steuerkategorie S -> E.
-- Kategorie S mit Satz 0 verletzt EN 16931 BR-S-05 und macht die XRechnung ungueltig.
-- NUR Entwuerfe: festgeschriebene Belege bleiben unveraendert (GoBD, Lastenheft § 51).
UPDATE "InvoiceLine" SET "taxCategory" = 'E'
 WHERE "taxCategory" = 'S'
   AND "invoiceId" IN (SELECT "id" FROM "Invoice" WHERE "taxScheme" = 'DIFFERENZ' AND "status" = 'DRAFT');

UPDATE "QuoteLine" SET "taxCategory" = 'E'
 WHERE "taxCategory" = 'S'
   AND "quoteId" IN (SELECT "id" FROM "Quote" WHERE "taxScheme" = 'DIFFERENZ' AND "status" = 'DRAFT');

-- RecurringInvoice ist eine Vorlage ohne GoBD-Charakter (status: ACTIVE|PAUSED|ENDED,
-- kein DRAFT) -> alle Zeilen der betroffenen Abos.
UPDATE "RecurringInvoiceLine" SET "taxCategory" = 'E'
 WHERE "taxCategory" = 'S'
   AND "recurringInvoiceId" IN (SELECT "id" FROM "RecurringInvoice" WHERE "taxScheme" = 'DIFFERENZ');
```

- [ ] **Step 7: Postgres-Testfall 17** — in `scripts/test-postgres-migrations.sh` am Ende (vor `echo "ALLE TESTS BESTANDEN"`), Muster von Fall 15: alle Migrationen außer `20260909090100_phase12b_differenz_category` einzeln einspielen; dann Organisation `org17`, Kunde `cust17`, eine **festgeschriebene** DIFFERENZ-Rechnung mit Zeile `il17final` (`taxCategory='S'`), eine DIFFERENZ-Rechnung im Entwurf mit Zeile `il17draft` (`'S'`) und ein DIFFERENZ-Angebot im Entwurf mit Zeile `ql17` (`'S'`) anlegen; danach `npx prisma migrate deploy` und prüfen:
```sh
DRAFTCAT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"taxCategory\" from \"InvoiceLine\" where id='il17draft'")
[ "$DRAFTCAT" = "E" ] || fail "Entwurfszeile il17draft: taxCategory ist '$DRAFTCAT', erwartet E"
FINALCAT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"taxCategory\" from \"InvoiceLine\" where id='il17final'")
[ "$FINALCAT" = "S" ] || fail "festgeschriebene Zeile il17final wurde veraendert ('$FINALCAT') — GoBD-Verstoss"
QUOTECAT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"taxCategory\" from \"QuoteLine\" where id='ql17'")
[ "$QUOTECAT" = "E" ] || fail "Angebotszeile ql17: taxCategory ist '$QUOTECAT', erwartet E"
echo "    ok — DIFFERENZ-Entwuerfe auf E migriert, festgeschriebene Belege unveraendert"
```

- [ ] **Step 8: Gate + Commit** — `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/schemas/index.ts src/lib/tax.ts src/domain/invoice/mandatory.ts prisma scripts/test-postgres-migrations.sh test/unit/tax.test.ts
git commit -s -m "feat(steuer): Schema AUSFUHR, Kategorie O, Differenzbesteuerung als E (BR-S-05), Pflichthinweistexte mit Quelle (Phase 12b, Task 1)"
```

---

### Task 2: Geschärfte Pflichtangaben-Prüfung

**Files:** Modify `src/domain/invoice/mandatory.ts:9-49,60-131` · Test `test/unit/mandatory.test.ts`

**Interfaces:** `MandatoryCustomer` += `countryCode?: string | null` (Prisma-`Customer` liefert das Feld; `finalize.ts:131` übergibt `invoice.customer` komplett — keine Aufruferänderung).

- [ ] **Step 1: Failing tests schreiben** (anhängen; `customer` in Z. 5 um `countryCode: "DE"` ergänzen)

```ts
const euCustomer = { name: "EU AG", addressLine1: "Rue 1", postalCode: "1000", city: "Bruessel", countryCode: "BE", vatId: "BE0123456789" };
const chCustomer = { name: "CH AG", addressLine1: "Weg 1", postalCode: "8000", city: "Zuerich", countryCode: "CH" };
const zeroLine = { description: "Leistung", quantityMilli: 1000, taxRate: 0, taxCategory: "E" };
const igNotes = "Steuerfreie innergemeinschaftliche Lieferung";

describe("Exakte Hinweispruefung (Phase 12b)", () => {
  it("aehnlicher, aber falscher Text wird abgelehnt; korrekter (auch mit Mehrfach-Whitespace) ist gruen", () => {
    const falsch = validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: euCustomer, notes: "Steuerfreie Lieferung nach Absprache", lines: [{ ...zeroLine, taxCategory: "K" }] }));
    expect(falsch.join(" ")).toMatch(/Pflichthinweis für Schema IG_LIEFERUNG/); // Erst-Wort-Heuristik liess das durch
    expect(validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: euCustomer, notes: "steuerfreie   innergemeinschaftliche lieferung", lines: [{ ...zeroLine, taxCategory: "K" }] }))).toEqual([]);
  });
  it("alle drei § 25a-Formulierungen sind gruen", () => {
    for (const t of ["Gebrauchtgegenstände/Sonderregelung", "Kunstgegenstände/Sonderregelung", "Sammlungsstücke und Antiquitäten/Sonderregelung"]) {
      expect(validateMandatoryFields(inv({ taxScheme: "DIFFERENZ", notes: t, lines: [zeroLine] }))).toEqual([]);
    }
  });
});

describe("Neue Blocker (Phase 12b)", () => {
  it("IG_LIEFERUNG ohne Datum und ohne Zeitraum blockt (BR-IC-11), mit Zeitraum ist ok", () => {
    const ohne = validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: euCustomer, notes: igNotes, deliveryDate: null, lines: [{ ...zeroLine, taxCategory: "K" }] }));
    expect(ohne.join(" ")).toMatch(/Leistungsdatum oder Leistungszeitraum/);
    const mit = validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: euCustomer, notes: igNotes, deliveryDate: null, deliveryStart: new Date("2026-06-01"), deliveryEnd: new Date("2026-06-30"), lines: [{ ...zeroLine, taxCategory: "K" }] }));
    expect(mit).toEqual([]);
  });
  it("IG_LIEFERUNG mit deutscher Empfaenger-USt-IdNr. blockt (§ 6a Abs. 1 Nr. 4)", () => {
    const p = validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: { ...euCustomer, vatId: "DE987654321" }, notes: igNotes, lines: [{ ...zeroLine, taxCategory: "K" }] }));
    expect(p.join(" ")).toMatch(/aus einem anderen EU-Mitgliedstaat/);
  });
  it("REVERSE_CHARGE ohne Empfaenger-USt-IdNr. blockt (BR-AE-3)", () => {
    const p = validateMandatoryFields(inv({ taxScheme: "REVERSE_CHARGE", notes: "Steuerschuldnerschaft des Leistungsempfängers", lines: [{ ...zeroLine, taxCategory: "AE" }] }));
    expect(p.join(" ")).toMatch(/USt-IdNr. des Empfängers erforderlich/);
  });
  it("AUSFUHR mit EU-Empfaenger blockt, mit Drittland ist ok, mit Satz > 0 blockt", () => {
    const notes = "Steuerfreie Ausfuhrlieferung";
    expect(validateMandatoryFields(inv({ taxScheme: "AUSFUHR", customer: euCustomer, notes, lines: [{ ...zeroLine, taxCategory: "G" }] })).join(" "))
      .toMatch(/außerhalb der EU/);
    expect(validateMandatoryFields(inv({ taxScheme: "AUSFUHR", customer: chCustomer, notes, lines: [{ ...zeroLine, taxCategory: "G" }] }))).toEqual([]);
    expect(validateMandatoryFields(inv({ taxScheme: "AUSFUHR", customer: chCustomer, notes, lines: [{ description: "L", quantityMilli: 1000, taxRate: 19, taxCategory: "G" }] })).join(" "))
      .toMatch(/USt-Satz > 0/);
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/mandatory.test.ts`.

- [ ] **Step 3: Implementieren** — Import `import { ZERO_TAX_SCHEMES, EU_COUNTRY_CODES, EU_VAT_PREFIXES } from "@/lib/tax";`, `MandatoryCustomer` um `countryCode?: string | null;`, zwei Helfer neben `hasDeliveryInfo` (das für § 14 Abs. 4 Nr. 6 unverändert bleibt):

```ts
/** BR-IC-11: bei ig. Lieferung genuegt der Freitext NICHT — es braucht BT-72 oder BG-14. */
function hasDeliveryDateOrPeriod(inv: MandatoryInvoice): boolean {
  return Boolean(inv.deliveryDate || (inv.deliveryStart && inv.deliveryEnd));
}
/** Zweistelliges USt-IdNr.-Praefix, gross, ohne Leerzeichen. */
function vatPrefix(vatId: string | null | undefined): string {
  return (vatId ?? "").replace(/\s/g, "").slice(0, 2).toUpperCase();
}
```
Der Block ab Z. 109 wird ersetzt:
```ts
  // § 14 Abs. 4 Nr. 8 / § 14a — Steuerausweis oder Befreiungshinweis
  const scheme = inv.taxScheme;
  const noticeRequired = SCHEME_NOTICE[scheme];
  if (noticeRequired) {
    const accepted = SCHEME_NOTICE_ACCEPTED[scheme] ?? [];
    const normalized = normalizeNotice(inv.notes ?? "");
    if (!accepted.some((re) => re.test(normalized))) {
      problems.push(`Pflichthinweis für Schema ${scheme} fehlt im Hinweistext: "${noticeRequired}" (§ 14a UStG / § 14 Abs. 4 Nr. 8).`);
    }
  }
  // Bei steuerbefreiten Schemata darf KEIN USt-Satz > 0 ausgewiesen sein (§ 14c-Risiko).
  if (ZERO_TAX_SCHEMES.has(scheme) && inv.lines.some((l) => l.taxRate > 0)) {
    problems.push(`Schema ${scheme}: Positionen dürfen keinen USt-Satz > 0 ausweisen (§ 14c-Risiko).`);
  }

  // ig. Lieferung/Leistung: USt-IdNr. beider Parteien (§ 14a Abs. 1/3)
  if (scheme === "IG_LIEFERUNG" || scheme === "IG_LEISTUNG") {
    if (!org.vatId?.trim()) problems.push("USt-IdNr. des Ausstellers erforderlich (§ 14a Abs. 1/3).");
    if (!customer.vatId?.trim()) problems.push("USt-IdNr. des Empfängers erforderlich (§ 14a Abs. 1/3).");
  }

  // Phase 12b — materielle Zusatzvoraussetzungen:
  if (scheme === "IG_LIEFERUNG") {
    if (!hasDeliveryDateOrPeriod(inv)) {
      problems.push("Innergemeinschaftliche Lieferung: Leistungsdatum oder Leistungszeitraum erforderlich (§ 14 Abs. 4 Nr. 6; EN 16931 BR-IC-11) — ein Hinweistext genügt hier nicht.");
    }
    const prefix = vatPrefix(customer.vatId);
    if (customer.vatId?.trim() && (prefix === "DE" || !EU_VAT_PREFIXES.has(prefix))) {
      problems.push("USt-IdNr. des Empfängers muss aus einem anderen EU-Mitgliedstaat stammen (§ 6a Abs. 1 Nr. 4 UStG).");
    }
  }
  if (scheme === "REVERSE_CHARGE" && !customer.vatId?.trim()) {
    // BR-AE-3 verlangt BT-48 oder BT-47; BT-47 bildet diese Software nicht ab.
    problems.push("USt-IdNr. des Empfängers erforderlich (§ 13b UStG; EN 16931 BR-AE-3).");
  }
  if (scheme === "AUSFUHR") {
    const country = (customer.countryCode ?? "").toUpperCase();
    if (!country || EU_COUNTRY_CODES.has(country)) {
      problems.push("Ausfuhrlieferung setzt einen Empfänger außerhalb der EU voraus (§ 6 Abs. 1 UStG) — Länderkennzeichen des Kunden prüfen.");
    }
  }

  return problems;
```
Alle bestehenden Meldungstexte bleiben wortgleich (Bestandstests).

- [ ] **Step 4: Gate + Commit** — `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/domain/invoice/mandatory.ts test/unit/mandatory.test.ts
git commit -s -m "feat(pflichtangaben): exakte Hinweispruefung statt Erst-Wort-Heuristik, Blocker fuer IG/RC/Ausfuhr (Phase 12b, Task 2)"
```

---

### Task 3: `exemption.ts` — BT-120 und BT-121, Dublette entfernt

**Files:** Create `src/lib/einvoice/exemption.ts`, `test/unit/einvoice-exemption.test.ts` · Modify `src/lib/einvoice/xrechnung.ts:56-69,290-296`, `src/lib/einvoice/cii.ts:42-57,260-268`

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/einvoice-exemption.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { exemptionReasonText, exemptionReasonCode } from "@/lib/einvoice/exemption";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import type { EInvoiceData } from "@/lib/einvoice/types";

/** Minimalbeleg mit Nullsatz in der gewuenschten Steuerkategorie. */
function zeroRated(category: string): EInvoiceData {
  const netCents = 20000;
  return {
    number: "RE-2041-9001", type: "INVOICE",
    issueDate: new Date("2041-06-09"), dueDate: new Date("2041-06-23"), deliveryDate: new Date("2041-06-01"),
    currency: "EUR", buyerReference: "04011000-12345-86", notes: "Testbeleg",
    seller: { name: "Test GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", countryCode: "DE", vatId: "DE123456789", email: "info@test.de", phone: "+49 4131 100", contactName: "Max Mustermann" },
    buyer: { name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", vatId: "DE987654321", email: "einkauf@kunde.de" },
    lines: [{ id: "1", description: "Leistung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, lineNetCents: netCents, taxRate: 0, taxCategory: category, lineType: "ITEM" }],
    taxSubtotals: [{ taxCategory: category, taxRate: 0, netCents, taxCents: 0 }],
    netTotalCents: netCents, taxTotalCents: 0, grossTotalCents: netCents, payableCents: netCents,
    iban: "DE02120300000000202051",
  };
}

describe("BT-120 / BT-121 (Phase 12b)", () => {
  it("Text fuer alle befreiten Kategorien, nichts fuer S; VATEX-Code nur fuer AE/K/G/O", () => {
    expect(["AE", "K", "G", "E", "Z", "O"].map(exemptionReasonText)).toEqual([
      "Steuerschuldnerschaft des Leistungsempfängers", "Innergemeinschaftliche Lieferung",
      "Ausfuhrlieferung", "Steuerbefreit", "Nullsatz", "Nicht steuerbar",
    ]);
    expect(exemptionReasonText("S")).toBeNull();
    expect(["AE", "K", "G", "O"].map(exemptionReasonCode)).toEqual(["VATEX-EU-AE", "VATEX-EU-IC", "VATEX-EU-G", "VATEX-EU-O"]);
    // § 19 (E) und Nullsatz (Z) haben keinen passenden EU-Code.
    for (const c of ["E", "Z", "S"]) expect(exemptionReasonCode(c)).toBeNull();
  });
  it("xrechnung.ts und cii.ts definieren exemptionReason nicht mehr selbst", () => {
    const dir = path.resolve(__dirname, "../../src/lib/einvoice");
    for (const f of ["xrechnung.ts", "cii.ts"]) {
      const text = readFileSync(path.join(dir, f), "utf8");
      expect(text).not.toMatch(/function exemptionReason\s*\(/);
      expect(text).toMatch(/from "\.\/exemption"/);
    }
  });
  it("UBL setzt ReasonCode VOR Reason, CII den Code nach CategoryCode und vor RateApplicablePercent", () => {
    const ubl = buildXRechnungUBL(zeroRated("AE"));
    expect(ubl).toContain("<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>");
    expect(ubl.indexOf("TaxExemptionReasonCode")).toBeLessThan(ubl.indexOf("<cbc:TaxExemptionReason>"));
    const cii = buildFacturXCII(zeroRated("AE"));
    expect(cii).toContain("<ram:ExemptionReasonCode>VATEX-EU-AE</ram:ExemptionReasonCode>");
    expect(cii.indexOf("<ram:CategoryCode>")).toBeLessThan(cii.indexOf("<ram:ExemptionReasonCode>"));
    expect(cii.indexOf("<ram:ExemptionReasonCode>")).toBeLessThan(cii.indexOf("<ram:RateApplicablePercent>"));
  });
  it("Kategorie E bekommt Text, aber KEINEN Code", () => {
    const ubl = buildXRechnungUBL(zeroRated("E"));
    expect(ubl).toContain("<cbc:TaxExemptionReason>Steuerbefreit</cbc:TaxExemptionReason>");
    expect(ubl).not.toContain("TaxExemptionReasonCode");
  });
});
```


- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/einvoice-exemption.test.ts`.

- [ ] **Step 3: `src/lib/einvoice/exemption.ts` schreiben**

```ts
/**
 * BT-120 (TaxExemptionReason, Klartext) und BT-121 (TaxExemptionReasonCode, VATEX)
 * je UNTDID-5305-Steuerkategorie — EINZIGE Quelle fuer beide E-Rechnungs-Builder
 * (Phase 12b; vorher stand `exemptionReason` wortgleich in xrechnung.ts und cii.ts).
 *
 * BT-121 nur, wo die amtliche VATEX-Codeliste einen passenden Code kennt. Fuer § 19
 * (Kleinunternehmer, Kategorie E) und den Nullsatz (Z) gibt es keinen; dort erfuellt
 * BT-120 allein BR-E-10/BR-Z-10. Fuer § 25a (Differenzbesteuerung, ebenfalls E)
 * existiert kein EU-Code fuer die Margenbesteuerung von VERKAEUFEN — die VATEX-Codes
 * D/F/I/J betreffen innergemeinschaftliche ERWERBE und passen hier nicht.
 */
const REASON_TEXT: Record<string, string> = {
  AE: "Steuerschuldnerschaft des Leistungsempfängers",
  K: "Innergemeinschaftliche Lieferung",
  G: "Ausfuhrlieferung",
  E: "Steuerbefreit",
  Z: "Nullsatz",
  O: "Nicht steuerbar",
};

const REASON_CODE: Record<string, string> = {
  AE: "VATEX-EU-AE",
  K: "VATEX-EU-IC",
  G: "VATEX-EU-G",
  O: "VATEX-EU-O",
};

export function exemptionReasonText(category: string): string | null {
  return REASON_TEXT[category] ?? null;
}

export function exemptionReasonCode(category: string): string | null {
  return REASON_CODE[category] ?? null;
}
```

- [ ] **Step 4: Builder umstellen** — in beiden Dateien die lokale `exemptionReason`-Funktion löschen und `import { exemptionReasonText, exemptionReasonCode } from "./exemption";` ergänzen.

`xrechnung.ts` Z. 290–296:
```ts
    const cat = st.ele("cac:TaxCategory");
    cat.ele("cbc:ID").txt(sub.taxCategory).up();
    cat.ele("cbc:Percent").txt(String(sub.taxRate)).up();
    // UBL-XSD (TaxCategoryType): ReasonCode steht VOR Reason.
    const reasonCode = exemptionReasonCode(sub.taxCategory);
    if (reasonCode) cat.ele("cbc:TaxExemptionReasonCode").txt(reasonCode).up();
    const reason = exemptionReasonText(sub.taxCategory);
    if (reason) cat.ele("cbc:TaxExemptionReason").txt(reason).up();
    cat.ele("cac:TaxScheme").ele("cbc:ID").txt("VAT").up().up();
```
`cii.ts` Z. 260–268:
```ts
    const t = set.ele("ram:ApplicableTradeTax");
    t.ele("ram:CalculatedAmount").txt(amt(sub.taxCents)).up();
    t.ele("ram:TypeCode").txt("VAT").up();
    const reason = exemptionReasonText(sub.taxCategory);
    if (reason) t.ele("ram:ExemptionReason").txt(reason).up();
    t.ele("ram:BasisAmount").txt(amt(sub.netCents)).up();
    t.ele("ram:CategoryCode").txt(sub.taxCategory).up();
    // CII-XSD (TradeTaxType): ExemptionReasonCode NACH CategoryCode, VOR RateApplicablePercent.
    const reasonCode = exemptionReasonCode(sub.taxCategory);
    if (reasonCode) t.ele("ram:ExemptionReasonCode").txt(reasonCode).up();
    t.ele("ram:RateApplicablePercent").txt(String(sub.taxRate)).up();
    t.up();
```

- [ ] **Step 5: Gate + Commit** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run validate:erechnung`
```bash
git add src/lib/einvoice/exemption.ts src/lib/einvoice/xrechnung.ts src/lib/einvoice/cii.ts test/unit/einvoice-exemption.test.ts
git commit -s -m "feat(erechnung): BT-121 (VATEX) ergaenzt, BT-120 aus einer Quelle statt Dublette (Phase 12b, Task 3)"
```

---

### Task 4: BG-14 (Rechnungszeitraum) und BT-80 (Lieferland)

**Files:** Modify `src/lib/einvoice/types.ts`, `mapper.ts:36-60,273-312`, `xrechnung.ts:195-226`, `cii.ts:228-238,255-270` · Test `test/unit/einvoice.test.ts`

**Interfaces** (alle optional ⇒ `buildSample` in `scripts/generate-sample-xrechnung.ts` kompiliert unverändert weiter):
```ts
// EInvoiceData UND MapInput:
  deliveryStart?: Date | null;         // BT-73 (BG-14)
  deliveryEnd?: Date | null;           // BT-74 (BG-14)
  deliverToCountryCode?: string | null; // BT-80 (BG-15), Default: Land des Kaeufers
```

- [ ] **Step 1: Failing tests schreiben** (in `test/unit/einvoice.test.ts`)

```ts
describe("BG-14 / BT-80 (Phase 12b)", () => {
  const period = { deliveryStart: new Date("2026-05-01"), deliveryEnd: new Date("2026-05-31") };
  it("UBL: InvoicePeriod nur mit Zeitraum, nach BuyerReference und vor den Parteien", () => {
    const xml = buildXRechnungUBL({ ...data, ...period });
    expect(xml).toContain("<cbc:StartDate>2026-05-01</cbc:StartDate>");
    expect(xml).toContain("<cbc:EndDate>2026-05-31</cbc:EndDate>");
    expect(xml.indexOf("<cbc:BuyerReference>")).toBeLessThan(xml.indexOf("<cac:InvoicePeriod>"));
    expect(xml.indexOf("<cac:InvoicePeriod>")).toBeLessThan(xml.indexOf("<cac:AccountingSupplierParty>"));
    expect(buildXRechnungUBL(data)).not.toContain("<cac:InvoicePeriod>");
  });
  it("UBL: BT-80 aus dem Kaeuferland, nach ActualDeliveryDate; ueberschreibbar", () => {
    const xml = buildXRechnungUBL(data);
    expect(xml).toMatch(/<cac:DeliveryLocation>[\s\S]*<cac:Country><cbc:IdentificationCode>DE<\/cbc:IdentificationCode><\/cac:Country>/);
    expect(xml.indexOf("<cbc:ActualDeliveryDate>")).toBeLessThan(xml.indexOf("<cac:DeliveryLocation>"));
    expect(buildXRechnungUBL({ ...data, deliverToCountryCode: "AT" }))
      .toMatch(/<cac:DeliveryLocation>[\s\S]*<cbc:IdentificationCode>AT<\/cbc:IdentificationCode>/);
  });
  it("CII: ShipToTradeParty vor ActualDeliverySupplyChainEvent, BillingSpecifiedPeriod an der richtigen Stelle", () => {
    const xml = buildFacturXCII({ ...data, ...period });
    expect(xml.indexOf("<ram:ShipToTradeParty>")).toBeLessThan(xml.indexOf("<ram:ActualDeliverySupplyChainEvent>"));
    expect(xml).toMatch(/<ram:ShipToTradeParty>[\s\S]*<ram:CountryID>DE<\/ram:CountryID>/);
    expect(xml.indexOf("<ram:ApplicableTradeTax>")).toBeLessThan(xml.indexOf("<ram:BillingSpecifiedPeriod>"));
    expect(xml.indexOf("<ram:BillingSpecifiedPeriod>")).toBeLessThan(xml.indexOf("<ram:SpecifiedTradePaymentTerms>"));
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/einvoice.test.ts`.

- [ ] **Step 3: `types.ts` + `mapper.ts`** — die drei Felder in `EInvoiceData` und `MapInput` ergänzen (Kommentare wie oben); im Rückgabeobjekt von `buildEInvoiceData` nach `deliveryDate: invoice.deliveryDate,`:
```ts
    // BG-14 (BT-73/BT-74) — bisher erreichten diese Felder den Mapper gar nicht,
    // obwohl Invoice sie seit Phase 1 fuehrt.
    deliveryStart: invoice.deliveryStart ?? null,
    deliveryEnd: invoice.deliveryEnd ?? null,
    // BT-80 (BG-15) — Land der Rechnungsanschrift aus dem Kaeufer-Snapshot; eine
    // eigene Lieferanschrift bildet die E-Rechnung hier nicht ab.
    deliverToCountryCode: customer.countryCode,
```

- [ ] **Step 4: `xrechnung.ts`** — nach `root.ele("cbc:BuyerReference")…` und **vor** `if (data.orderNumber)`:
```ts
  // BG-14 (BT-73/BT-74). UBL-Reihenfolge: nach BuyerReference, vor OrderReference.
  if (data.deliveryStart && data.deliveryEnd) {
    const period = root.ele("cac:InvoicePeriod");
    period.ele("cbc:StartDate").txt(isoDate(data.deliveryStart)).up();
    period.ele("cbc:EndDate").txt(isoDate(data.deliveryEnd)).up();
    period.up();
  }
```
Den Delivery-Block (Z. 222–226) ersetzen:
```ts
  // BG-13/BG-15 — MUSS nach den Parteien und vor PaymentMeans stehen (sonst XSD-fatal).
  // DeliveryType-Reihenfolge: ActualDeliveryDate vor DeliveryLocation.
  const deliverToCountry = data.deliverToCountryCode ?? data.buyer.countryCode ?? null;
  if (data.deliveryDate || deliverToCountry) {
    const delivery = root.ele("cac:Delivery");
    if (data.deliveryDate) delivery.ele("cbc:ActualDeliveryDate").txt(isoDate(data.deliveryDate)).up();
    // BT-80 ist die einzige Pflichtangabe der BG-15 (BR-57).
    if (deliverToCountry) {
      delivery.ele("cac:DeliveryLocation").ele("cac:Address").ele("cac:Country")
        .ele("cbc:IdentificationCode").txt(deliverToCountry).up().up().up().up();
    }
    delivery.up();
  }
```

- [ ] **Step 5: `cii.ts`** — Delivery-Block (Z. 228–238) ersetzen:
```ts
  // Lieferung (BG-13/BG-15). CII-Reihenfolge: ShipToTradeParty VOR ActualDeliverySupplyChainEvent.
  const del = tx.ele("ram:ApplicableHeaderTradeDelivery");
  const deliverToCountry = data.deliverToCountryCode ?? data.buyer.countryCode ?? null;
  if (deliverToCountry) {
    del.ele("ram:ShipToTradeParty").ele("ram:PostalTradeAddress").ele("ram:CountryID").txt(deliverToCountry).up().up().up();
  }
  if (data.deliveryDate) {
    del.ele("ram:ActualDeliverySupplyChainEvent").ele("ram:OccurrenceDateTime")
      .ele("udt:DateTimeString", { format: "102" }).txt(ciiDate(data.deliveryDate)).up().up().up();
  }
  del.up();
```
Und in `ram:ApplicableHeaderTradeSettlement` **nach** der `ApplicableTradeTax`-Schleife, **vor** den `SpecifiedTradeAllowanceCharge`-Schleifen:
```ts
  // BG-14 (BT-73/BT-74). CII-XSD: nach ApplicableTradeTax, vor SpecifiedTradeAllowanceCharge.
  if (data.deliveryStart && data.deliveryEnd) {
    const period = set.ele("ram:BillingSpecifiedPeriod");
    period.ele("ram:StartDateTime").ele("udt:DateTimeString", { format: "102" }).txt(ciiDate(data.deliveryStart)).up().up();
    period.ele("ram:EndDateTime").ele("udt:DateTimeString", { format: "102" }).txt(ciiDate(data.deliveryEnd)).up().up();
    period.up();
  }
```

- [ ] **Step 6: Gate + Commit** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run validate:erechnung`. Erwartung: alle 15 Bestandsfixtures bleiben ACCEPTABLE (sie tragen jetzt zusätzlich BT-80). Schlägt eine fehl, wird der Befund im Commit-Text dokumentiert und **nicht** durch Abschalten von BT-80 umgangen.
```bash
git add src/lib/einvoice test/unit/einvoice.test.ts
git commit -s -m "feat(erechnung): BG-14 Rechnungszeitraum und BT-80 Lieferland in UBL und CII (Phase 12b, Task 4)"
```

---

### Task 5: § 14b-Hinweis, Storno-/Korrektur-Titel, Schema-Auswahl in der UI

**Files:** Modify `src/schemas/index.ts` (`invoiceHeaderFields`), `src/domain/invoice/{create.ts:180-200,update.ts:110-120}`, `src/lib/einvoice/{types,mapper,load,xrechnung,cii}.ts`, `src/lib/pdf/invoice-pdf.ts:33-62,504-515`, `src/lib/editor/draft.ts`, `src/components/editor/blocks/{MetaBlock,MoreOptions,HeadTextBlock}.tsx`, `src/mcp/tools/invoices.ts` · Test `test/unit/einvoice.test.ts`, `test/integration/pdf-theme.test.ts`

**Interfaces:**
```ts
// invoiceHeaderFields (src/schemas/index.ts):
  /** § 14 Abs. 4 Nr. 9 / § 14b Abs. 1 S. 5 UStG — Hinweis auf die zweijaehrige
   *  Aufbewahrungspflicht des privaten Empfaengers bei Bauleistungen am Grundstueck. */
  consumerRetentionHint: z.boolean().optional(),
// EInvoiceData / MapInput:
  consumerRetentionHint?: boolean;
  creditNoteKind?: "STORNO" | "KORREKTUR";
```

- [ ] **Step 1: Failing tests schreiben**

```ts
// test/unit/einvoice.test.ts
it("§ 14b-Hinweis erscheint als eigener Note in UBL und CII, sonst nicht", () => {
  const hint = "Sie sind verpflichtet, diese Rechnung zwei Jahre aufzubewahren (§ 14b Abs. 1 Satz 5 UStG).";
  expect(buildXRechnungUBL({ ...data, consumerRetentionHint: true })).toContain(hint);
  expect(buildFacturXCII({ ...data, consumerRetentionHint: true })).toContain(hint);
  expect(buildXRechnungUBL(data)).not.toContain("§ 14b Abs. 1 Satz 5");
});
```
```ts
// test/integration/pdf-theme.test.ts
it("§ 14b-Hinweis steht im PDF, wenn consumerRetentionHint gesetzt ist", async () => {
  const parsed = await parsePdf(await renderInvoicePdf(baseInvoiceData({ consumerRetentionHint: true }), testPdfTheme()));
  expect(parsed.text).toContain("zwei Jahre aufzubewahren");
});
it("Storno heisst Stornorechnung, Teilgutschrift heisst Rechnungskorrektur", async () => {
  const storno = await parsePdf(await renderInvoicePdf(baseInvoiceData({ type: "CREDIT_NOTE", creditNoteKind: "STORNO" }), testPdfTheme()));
  expect(storno.text).toContain("Stornorechnung");
  const korrektur = await parsePdf(await renderInvoicePdf(baseInvoiceData({ type: "CREDIT_NOTE", creditNoteKind: "KORREKTUR" }), testPdfTheme()));
  expect(korrektur.text).toContain("Rechnungskorrektur");
  expect(korrektur.text).not.toContain("Gutschrift / Storno");
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/einvoice.test.ts test/integration/pdf-theme.test.ts`.

- [ ] **Step 3: § 14b end-to-end** (kein Schemafeld nötig — `Invoice.consumerRetentionHint Boolean @default(false)` existiert seit Phase 1 und wurde in `src/` nirgends gelesen oder geschrieben; § 59 „keine Attrappen")
  - `src/schemas/index.ts`: Feld in `invoiceHeaderFields` ⇒ deckt API v1 (`createInvoiceSchema` in `src/app/api/v1/Invoice/route.ts:44,65`) **und** MCP ab.
  - `src/domain/invoice/create.ts`: im `data`-Objekt `consumerRetentionHint: input.consumerRetentionHint ?? false,`.
  - `src/domain/invoice/update.ts` im Stil der Nachbarzeilen: `if (input.consumerRetentionHint !== undefined) { data.consumerRetentionHint = input.consumerRetentionHint; changedFields.push("consumerRetentionHint"); }`.
  - `MapInput` + `EInvoiceData` += `consumerRetentionHint?: boolean;`; im Mapper `consumerRetentionHint: invoice.consumerRetentionHint ?? false,` (`load.ts` spreizt `...invoice`).
  - `src/lib/pdf/invoice-pdf.ts`, direkt nach dem `DOWNPAYMENT_TAX_HINT`-Block (Z. 506–510):
    ```ts
    // § 14 Abs. 4 Nr. 9 / § 14b Abs. 1 Satz 5 UStG — Aufbewahrungshinweis fuer den privaten
    // Leistungsempfaenger (Bauleistung am Grundstueck). Nur auf ausdruecklichen Schalter:
    // "Bauleistung" ist maschinell nicht erkennbar.
    if (data.consumerRetentionHint) {
      y = ensurePlainSpace(y, 30);
      doc.text(CONSUMER_RETENTION_HINT, left, y, { width: right - left });
      y = doc.y + 4;
    }
    ```
  - `xrechnung.ts`: nach dem bestehenden `if (data.deductions?.length) root.ele("cbc:Note")…` ein weiteres `cbc:Note` mit `CONSUMER_RETENTION_HINT` (UBL erlaubt Mehrfachvorkommen). `cii.ts`: analog ein weiteres `ram:IncludedNote/ram:Content` (Muster Z. 137/140).
  - **Eine** Textquelle: `CONSUMER_RETENTION_HINT` wird in Task 1 in `src/domain/invoice/mandatory.ts` angelegt (dort liegen bereits alle Rechtstexte) und von `invoice-pdf.ts`, `xrechnung.ts` und `cii.ts` importiert — keine Dublette.
  - `src/lib/editor/draft.ts`: `consumerRetentionHint: boolean` in `DraftState` (Default `false`), aus `initial` lesen (Bereich Z. 568/618), in `toInvoicePayload` ausgeben.
  - `src/components/editor/blocks/MoreOptions.tsx`, im INVOICE-Zweig über „Hinweis / Notiz":
    ```tsx
    {mode === "INVOICE" && (
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={draft.consumerRetentionHint} onChange={(e) => set(dispatch, "consumerRetentionHint", e.target.checked)} className="mt-1 h-4 w-4 rounded border-slate-300" />
        <span>
          <span className="font-medium text-slate-700">Hinweis auf Aufbewahrungspflicht (§ 14b)</span>
          <span className="block text-xs text-slate-400">Bauleistung an eine Privatperson: „Sie sind verpflichtet, diese Rechnung zwei Jahre aufzubewahren."</span>
        </span>
      </label>
    )}
    ```
  - `src/mcp/tools/invoices.ts`: `consumerRetentionHint: z.boolean().optional().describe("§ 14b Abs. 1 S. 5: Hinweis auf zweijaehrige Aufbewahrungspflicht (Bauleistung an Privatperson)")` in `inputSchema` von `create_invoice` und im `createInvoiceSchema.parse({…})`-Objekt durchreichen.

- [ ] **Step 4: Storno- vs. Korrektur-Titel (COMPLIANCE § 11)**

`src/lib/einvoice/load.ts`, bestehender `correctsInvoiceId`-Block:
```ts
    const original = await dbInternal.invoice.findUnique({
      where: { id: invoice.correctsInvoiceId },
      select: { number: true, issueDate: true, reversedByInvoiceId: true },
    });
    if (original) {
      data.precedingInvoiceNumber = original.number;
      data.precedingInvoiceDate = original.issueDate;
      // Phase 12b: ein CREDIT_NOTE entsteht auf zwei Wegen (cancel.ts = Vollstorno,
      // credit.ts = Teilgutschrift) — beide setzen correctsInvoiceId. Unterscheidbar
      // allein ueber den Rueckverweis: nur der Vollstorno setzt
      // Invoice.reversedByInvoiceId (cancel.ts:229).
      if (invoice.type === "CREDIT_NOTE") {
        data.creditNoteKind = original.reversedByInvoiceId === invoice.id ? "STORNO" : "KORREKTUR";
      }
    }
```
`src/lib/pdf/invoice-pdf.ts` — `TYPE_TITLE.CREDIT_NOTE`/`NUMBER_LABEL.CREDIT_NOTE` bleiben als Rückfall stehen, davor greifen:
```ts
/**
 * Phase 12b (COMPLIANCE.md § 11): "Gutschrift" ist umsatzsteuerlich die Selbstabrechnung
 * (§ 14 Abs. 2 S. 5 UStG, TypeCode 389) — diese Software erzeugt aber Storno bzw.
 * Korrektur. Der Titel benennt das korrekt; InvoiceTypeCode bleibt 381, der
 * Nummernkreis CREDIT_NOTE bleibt unveraendert. Ohne aufloesbares Original faellt der
 * Titel auf "Stornorechnung" zurueck (der weit haeufigere Fall).
 */
function documentTitle(data: EInvoiceData): string {
  if (data.type === "CREDIT_NOTE") return data.creditNoteKind === "KORREKTUR" ? "Rechnungskorrektur" : "Stornorechnung";
  return TYPE_TITLE[data.type] ?? "Beleg";
}
function documentNumberLabel(data: EInvoiceData): string {
  if (data.type === "CREDIT_NOTE") return data.creditNoteKind === "KORREKTUR" ? "Korrekturnummer" : "Stornonummer";
  return NUMBER_LABEL[data.type] ?? "Belegnummer";
}
```
`grep -n "TYPE_TITLE\[\|NUMBER_LABEL\[" src/lib/pdf/invoice-pdf.ts` — jede Fundstelle im Renderer auf die beiden Funktionen umstellen.

- [ ] **Step 5: Schema-Auswahl in der UI**

`MetaBlock.tsx` Z. 65–81, Dropdown auf alle sieben Schemata:
```tsx
<option value="REGULAR">Regelbesteuerung</option>
<option value="KLEINUNTERNEHMER">Kleinunternehmer (§ 19)</option>
<option value="DIFFERENZ">Differenzbesteuerung (§ 25a)</option>
<option value="REVERSE_CHARGE">Reverse Charge (§ 13b)</option>
<option value="IG_LIEFERUNG">Innergem. Lieferung (§ 6a)</option>
<option value="IG_LEISTUNG">Innergem. Leistung (§ 3a Abs. 2)</option>
<option value="AUSFUHR">Ausfuhrlieferung (§ 6)</option>
```
`OrganizationForm` (`defaultTaxScheme`) bleibt bei REGULAR/KLEINUNTERNEHMER/DIFFERENZ — die übrigen vier sind belegabhängig, nie Organisationsvorgabe.

In `MoreOptions.tsx` neben dem Hinweisfeld (Z. 211):
```tsx
{notice && !SCHEME_NOTICE_ACCEPTED[draft.taxScheme]?.some((re) => re.test(normalizeNotice(draft.notes))) && (
  <button type="button" onClick={() => set(dispatch, "notes", draft.notes ? `${notice} — ${draft.notes}` : notice)} className="text-xs text-indigo-600 hover:underline">
    Pflichthinweis einfügen
  </button>
)}
```
**Ruling:** Die Spec verlangt zusätzlich ein automatisches Voranstellen beim Schemawechsel. Das wird **nicht** als Reducer-Nebenwirkung gebaut (ein `set`-Dispatch auf `taxScheme` darf kein zweites Feld überschreiben — der Nutzer verlöre eine eigene Formulierung), sondern über diesen sichtbaren Knopf plus den bestehenden Automatismus in `toInvoicePayload` (Z. 281–282), der den Hinweis beim Speichern ohnehin voranstellt, wenn er fehlt. Gleiches Ergebnis ohne stille Textänderung.

`HeadTextBlock.tsx:17`: `createInvoiceInputSchema`/`updateInvoiceInputSchema` → `createInvoiceSchema`/`updateInvoiceSchema`.

- [ ] **Step 6: Gate + Commit** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run validate:erechnung && npm run api:check`. `api:check` schlägt wegen `consumerRetentionHint` an ⇒ `npm run api:check -- --write`, `openapi/openapi.json` mitcommitten.
```bash
git add src/schemas/index.ts src/domain/invoice src/lib/einvoice src/lib/pdf/invoice-pdf.ts src/lib/editor/draft.ts src/components/editor src/mcp/tools/invoices.ts openapi/openapi.json test
git commit -s -m "feat(rechnung): § 14b-Aufbewahrungshinweis verdrahtet, Storno-/Korrekturtitel, alle sieben Steuerschemata in der UI (Phase 12b, Task 5)"
```

---

### Task 6: KoSIT-Fixtures, COMPLIANCE, Doku, Gesamtprüfung

**Files:** Modify `scripts/generate-sample-xrechnung.ts` (`buildSample`-Optionen, zwei Kunden-Konstanten, fünf Fabriken, `SAMPLES`), `scripts/validate-erechnung.ts:103-120`, `COMPLIANCE.md` (§ 1, 7, 8, 9, 11), `docs/ANLEITUNG.md` (§ 4), `docs/LIMITATIONEN.md` (Abschnitt „E-Rechnung")

- [ ] **Step 1: `buildSample` erweitern** — Optionen `customer?: MapInput["customer"]`, `deliveryStart?: Date`, `deliveryEnd?: Date`, `notes?: string`; im `mapInput` entsprechend `customer: opts.customer ?? CUSTOMER`, `deliveryStart: opts.deliveryStart ?? null`, `deliveryEnd: opts.deliveryEnd ?? null`, `notes: opts.notes ?? "Vielen Dank für Ihren Auftrag."`. Zwei Kunden-Konstanten neben `CUSTOMER`:
```ts
const CUSTOMER_EU: MapInput["customer"] = { ...CUSTOMER, name: "Beispiel BV", addressLine1: "Keizersgracht 1", postalCode: "1015", city: "Amsterdam", countryCode: "NL", vatId: "NL123456789B01" };
const CUSTOMER_CH: MapInput["customer"] = { ...CUSTOMER, name: "Beispiel AG", addressLine1: "Bahnhofstr. 1", postalCode: "8001", city: "Zürich", countryCode: "CH", vatId: null };
```

- [ ] **Step 2: Fünf Fixtures ergänzen**

```ts
// Phase 12b — je eine Fixture fuer die bislang ungetesteten Steuerkategorien.
const reverseChargeAe = () => buildSample({
  number: "RE-2041-0001",
  notes: "Steuerschuldnerschaft des Leistungsempfängers",
  lines: [{ description: "Bauleistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 250000, taxRate: 0, taxCategory: "AE" }],
});
const igLieferungK = () => buildSample({
  number: "RE-2041-0002", customer: CUSTOMER_EU,
  notes: "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG)",
  deliveryStart: new Date("2041-05-01"), deliveryEnd: new Date("2041-05-31"),
  lines: [{ description: "Warenlieferung", quantityMilli: 5000, unit: "C62", unitNetPriceCents: 40000, taxRate: 0, taxCategory: "K" }],
});
const ausfuhrG = () => buildSample({
  number: "RE-2041-0003", customer: CUSTOMER_CH,
  notes: "Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG)",
  lines: [{ description: "Maschinenteil", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 180000, taxRate: 0, taxCategory: "G" }],
});
// § 19: idR keine USt-IdNr. -> BT-32 (Steuernummer) noetig, sonst BR-CO-26.
const kleinunternehmerE = () => buildSample({
  number: "RE-2041-0004", org: { ...ORG, vatId: null, taxNumber: "12/345/67890" },
  notes: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer",
  lines: [{ description: "Beratung", quantityMilli: 4000, unit: "HUR", unitNetPriceCents: 6000, taxRate: 0, taxCategory: "E" }],
});
const differenzE = () => buildSample({
  number: "RE-2041-0005",
  notes: "Gebrauchtgegenstände/Sonderregelung (§ 25a UStG)",
  lines: [{ description: "Gebrauchtes Notebook", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 45000, taxRate: 0, taxCategory: "E" }],
});
```
In `SAMPLES` eintragen: `"reverse-charge-ae"`, `"ig-lieferung-k"`, `"ausfuhr-g"`, `"kleinunternehmer-e"`, `"differenz-e"`. Dieselben fünf Namen an `SAMPLE_NAMES` in `scripts/validate-erechnung.ts` anhängen und den Kommentar aktualisieren. **Korrektur zur Spec:** dort steht „16 Fixtures" und „21 ACCEPTABLE" — tatsächlich sind es heute **15** Fixtures und **29** geprüfte XML-Dateien (`base` nur UBL, alle anderen UBL + CII); nach Phase 12b **20** Fixtures und **39** Dateien.

- [ ] **Step 3: `npm run validate:erechnung` bis grün.** Stolpersteine in dieser Reihenfolge prüfen: (1) BR-CO-26 — Verkäufer ohne USt-IdNr. braucht BT-32; (2) BR-AE-3/BR-IC-3 — Käufer-USt-IdNr. Pflicht (`reverse-charge-ae` nutzt den Bestandskunden `DE987654321`, `ig-lieferung-k` den NL-Kunden); (3) BR-G-3 verlangt keine Käufer-USt-IdNr. (`CUSTOMER_CH` hat `vatId: null`); (4) BR-*-10 — BT-120 oder BT-121 muss vorhanden sein (liefert `exemption.ts`); (5) Reihenfolgefehler melden sich als „cvc-complex-type.2.4.a" ⇒ Reihenfolge-Tabelle in den Global Constraints gegenprüfen.

- [ ] **Step 4: COMPLIANCE.md nachführen** (je Abschnitt mit Quelle **und** einem Absatz „Umsetzung dieser Software")
  - **§ 1**: Tabelle der sechs Schemata mit dem gedruckten Satz und der Norm; Hinweis, dass die Prüfung `SCHEME_NOTICE_ACCEPTED` heißt und keine Heuristik mehr ist.
  - **§ 7**: § 14b Abs. 1 S. 5 — der Zwei-Jahres-Hinweis an Privatpersonen bei grundstücksbezogenen Bauleistungen ist ab Phase 12b ein Schalter je Rechnung (kein Automatismus, „Bauleistung" ist nicht erkennbar).
  - **§ 8**: die drei neuen Blocker; ausdrücklich **keine** VIES-Onlineprüfung, **keine** ZM-Erzeugung (§ 60).
  - **§ 9**: die drei nach § 14a Abs. 6 zulässigen Formulierungen; warum die Kategorie jetzt `E` und nicht `S` ist (BR-S-05) und warum es keinen VATEX-Code gibt.
  - **§ 11**: PDF-Titel „Stornorechnung"/„Rechnungskorrektur"; `InvoiceTypeCode` bleibt 381; echte Selbstabrechnung (389) nicht umgesetzt.

- [ ] **Step 5: `docs/ANLEITUNG.md` § 4** um „Steuerschemata und Pflichthinweise" erweitern: die sieben Auswahlmöglichkeiten, was beim Festschreiben blockt, wie man den § 25a-Satz auf „Kunstgegenstände" bzw. „Sammlungsstücke und Antiquitäten" austauscht (Hinweisfeld überschreiben), wann der § 14b-Schalter zu setzen ist.

- [ ] **Step 6: `docs/LIMITATIONEN.md`**, Abschnitt „E-Rechnung": keine VIES-Onlineprüfung (die USt-IdNr. wird nur auf das Präfix geprüft, nicht auf Gültigkeit); keine ZM/OSS; keine echte Selbstabrechnung (TypeCode 389) — eine „Gutschrift" im Sinne des § 14 Abs. 2 S. 5 UStG kann diese Software nicht ausstellen; für § 19 und § 25a wird kein BT-121 gesetzt (kein passender VATEX-Code); BT-80 wird immer aus dem Land der Rechnungsanschrift abgeleitet, eine abweichende Lieferanschrift bildet das XML nicht ab; Kategorie `O` ist im Mapper vorbereitet, aber von keinem Schema erreichbar.

- [ ] **Step 7: Gesamtprüfung** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check`, dazu `bash scripts/test-postgres-migrations.sh` (Docker) und ein Playwright-Smoke (Skill `webapp-testing`, Login `admin@example.com` / `demo1234`, Screenshots nach `<scratchpad>/ui-previews/12b-*.png`): je Schema eine Rechnung anlegen → Pflichthinweis erscheint → festschreiben → PDF prüfen (Hinweis + korrekter Titel) → XRechnung herunterladen; Negativprobe: IG-Lieferung ohne Leistungsdatum lässt sich nicht festschreiben; § 14b-Schalter setzen → Satz im PDF.

- [ ] **Step 8: Commit**
```bash
git add scripts COMPLIANCE.md docs
git commit -s -m "test(erechnung): fuenf KoSIT-Fixtures fuer AE/K/G/E, Compliance und Anleitung nachgefuehrt (Phase 12b, Task 6)"
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. **Rechtstexte:** jeder Satz in `SCHEME_NOTICE` steht wortgleich in COMPLIANCE.md mit Norm; `SCHEME_NOTICE` ist die einzige Definition (`grep -rn "Steuerschuldnerschaft des Leistungsempfängers" src/` trifft nur `mandatory.ts` und `exemption.ts` — letzteres ist BT-120, anderer Zweck, im Kommentar erklärt).
2. **Prüfung:** die Erst-Wort-Heuristik ist weg (`grep -n 'split(" ")' src/domain/invoice/mandatory.ts` leer); jeder eigene Text erfüllt sein `SCHEME_NOTICE_ACCEPTED`; Bestandsentwürfe mit dem alten IG-Text bleiben festschreibbar; alle bestehenden Meldungstexte unverändert.
3. **GoBD:** die Datenmigration trifft nur Entwürfe (Postgres-Fall 17 prüft eine festgeschriebene Zeile auf Unverändertheit); keine Domain-Funktion schreibt auf festgeschriebene Belege; `ZERO_TAX_SCHEMES` ersetzt eine implizite Bedingung ohne Abdeckungsverlust.
4. **E-Rechnung, Reihenfolge:** die sechs Positionen aus den Global Constraints sind exakt eingehalten; `npm run validate:erechnung` ist für alle **20** Fixtures (39 Dateien, UBL und CII) ACCEPTABLE; die 15 Bestandsfixtures bleiben grün, obwohl sie jetzt BT-80 tragen.
5. **BT-121:** nur AE/K/G/O; E und Z ausdrücklich nicht (Kommentar erklärt, dass VATEX-D/F/I/J Erwerbe und keine § 25a-Verkäufe betreffen). Keine erfundenen Codes.
6. **BT-80/BG-14:** BG-14 erscheint nur bei gesetztem Start **und** Ende; BT-80 fällt auf das Käuferland zurück und ist überschreibbar; außer dem additiven Delivery-Block ändert kein bestehender Datenpfad sein Verhalten.
7. **§ 14b:** `consumerRetentionHint` ist jetzt schreib-, druck- und mapbar (§ 59) — durchgängig über UI, `createInvoiceSchema` (API v1) und MCP, mit **einer** Textkonstante für PDF und beide XML-Formate.
8. **Titel:** `creditNoteKind` wird ausschließlich aus `original.reversedByInvoiceId === invoice.id` abgeleitet (der einzige verlässliche Unterschied zwischen `cancel.ts` und `credit.ts`, beide setzen `correctsInvoiceId`); `InvoiceTypeCode` bleibt 381; Nummernkreis und Datenfelder unverändert.
9. **Typen:** `TaxCategory` in `src/lib/tax.ts` und `src/schemas/index.ts` sind deckungsgleich (beide mit `O`); `SCHEME_CATEGORY` (`src/lib/editor/constants.ts:45`) enthält danach `DIFFERENZ: "E"` und `AUSFUHR: "G"`; kein `any`, keine Casts auf Kategorie-Strings.
10. **Parität (§ 55):** `create_invoice` (MCP) und `POST /api/v1/Invoice` akzeptieren dieselben neuen Felder über dasselbe Zod-Schema; `openapi/openapi.json` regeneriert; kein Bypass-Pfad.
11. **Abgrenzung (§ 60):** keine VIES-Abfrage, keine ZM, keine OSS-Meldung, keine Selbstabrechnung — in LIMITATIONEN benannt.
12. **Betreiber-Abnahme vor dem Merge** (Spec, Teilphase 2): je Schema ein Muster-PDF **und** die validierte XML vorlegen. Deploy erst nach Abschluss der gesamten Phase 12 (Ruling).
