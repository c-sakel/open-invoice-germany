# Phase 11b — PDF-Layouts, automatische Fußzeile, Briefpapier-Seite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sieben wählbare PDF-Layouts (Schlicht nach den sevDesk-Beispielbelegen, Standard = heutiges Layout, Klassik, Modern, Blau, Schwarz, Kompakt), je Belegtyp einstellbar, mit automatischer vierspaltiger Fußzeile aus den Stammdaten, Live-Vorschau in einer dreiteiligen Briefpapier-Seite, per Beleg eingefroren, in API v1 und MCP verfügbar.

**Architecture:** Die drei bestehenden Renderer (`invoice-pdf.ts`, `delivery-note-pdf.ts`, `dunning-pdf.ts`) werden zur „Engine": sie liefern Daten und Reihenfolge, ein `PdfLayout`-Objekt aus `src/lib/pdf/layouts/` zeichnet Kopf (Logo, Absender, Empfänger, Titel, Metablock), Tabellenstil, Summenlinie und Fußzeile. `standard` ist die exakte Extraktion des heutigen Verhaltens (Kompatibilität), die anderen sechs sind Varianten davon. Die Layout-Kennung wandert in `printOptionsJson` (Override, beim Festschreiben eingefroren, bestehender Mechanismus aus Phase 7) und in `BrandingSettings` (Organisationsstandard + Map je Belegtyp).

**Tech Stack:** pdfkit (Standardfonts Helvetica), Prisma (SQLite + Postgres), Zod, Next.js App Router, Vitest + pdf-parse (Textextraktion), zod-to-openapi, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-09-07-phase-11-sevdesk-ux-design.md` (Branch `specs`), Abschnitt 2 „Layout-System", „Layouts (7)", „Fußzeile", „Layout-Auswahl", „Seite Briefpapier", „API", „Migration"; Abschnitte 3, 4, 5 (11b), 6.

## Global Constraints

- TypeScript strict, kein `any`; `unknown` + Narrowing. Dateien kebab-case, Konstanten UPPER_SNAKE_CASE.
- Zod an jeder Boundary: `layoutId` ∈ `LAYOUT_IDS`, `layoutByType` nur mit bekannten Belegtypen, `footerMode` ∈ `AUTO|CUSTOM`; Fehler → 400 in UI-Routen, API v1 und MCP gleich.
- Keine neue Abhängigkeit. Miniaturen sind statische SVG-Dateien unter `public/layouts/<id>.svg` (120×170).
- GoBD (Phase-7-Ruling): Layout ist Darstellung. Beim Festschreiben wird der effektive `layoutId` über `freezePrintOptionsJson` in den Override geschrieben; festgeschriebene Belege ändern sich bei späterer Umstellung nicht. Altbestand ohne `layoutId` im Override rendert mit dem Organisations-Layout.
- Interne Notizen erscheinen in keinem Layout (Engine reicht sie nicht durch; Test je Layout).
- E-Rechnung: XML unverändert; `validate:erechnung` bleibt grün. ZUGFeRD-PDF nutzt das gewählte Layout.
- Migration (§53): additive Spalten für SQLite (`npm run db:migrate -- --name phase11b_layouts`) UND Postgres (Ordner `prisma/migrations-postgres/<ts>_phase11b_layouts/migration.sql`, handgeschrieben nach dem Muster der SQLite-Migration, weil lokal kein Docker läuft; das CI-Gate `postgres-migrations` verifiziert). `prisma/schema.postgres.prisma` per `sed` aus `schema.prisma` regenerieren (CI `schema-drift`).
- Prisma immer mit `select`/Domain-Funktionen; `dbInternal` nur in Domain-/Test-Code.
- Bestehende PDF-Tests bleiben grün: `standard` muss den heutigen extrahierten Text unverändert liefern.
- Vor jedem Commit `npm run typecheck && npm run lint`; vor dem Abschluss `TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check`.
- Jeder Commit `git commit -s` (DCO) auf Branch `phase-11b/layouts` aus Fork-`main`.
- Testjahr dieser Phase: **2073** (Rechnungsnummern global eindeutig; Nummernkreis-Präfix `L11B-` setzen, Muster `test/integration/customer-routes.test.ts:71`).

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/lib/pdf/layouts/ids.ts` | `LAYOUT_IDS`, `LayoutId`, `LAYOUT_DOC_TYPES`, `LayoutDocType`, `DEFAULT_LAYOUT_ID` — reine Konstanten, von Zod importierbar (kein pdfkit) |
| `src/lib/pdf/layouts/types.ts` | `PdfLayout`, `LayoutFrame`, `KopfInput`, `TableStyle`, `FooterColumn` |
| `src/lib/pdf/layouts/shared.ts` | gemeinsame Zeichenhelfer: `drawRecipient`, `drawMetaRows`, `drawFooterColumns`, `drawTitle` |
| `src/lib/pdf/layouts/standard.ts` | heutiges Layout, 1:1 extrahiert |
| `src/lib/pdf/layouts/schlicht.ts`, `klassik.ts`, `modern.ts` | strukturell eigene Köpfe/Fußzeilen |
| `src/lib/pdf/layouts/styled.ts` | Fabrik `styledLayout(base, overrides)` für `blau`, `schwarz`, `kompakt` |
| `src/lib/pdf/layouts/registry.ts` | `LAYOUTS: Record<LayoutId, PdfLayout>`, `getLayout(id)`, `listLayouts()` |
| `src/lib/pdf/footer.ts` | `buildFooterColumns(facts, brand)` — AUTO-Fußzeile (4 Spalten) bzw. CUSTOM (3 Spalten) |
| `src/lib/pdf/theme.ts` | `PdfTheme` + `layoutId`, `footerFacts` |
| `src/lib/pdf/invoice-pdf.ts`, `delivery-note-pdf.ts`, `dunning-pdf.ts` | Engines auf Layout-Hooks |
| `src/domain/settings/layout.ts` | `resolveLayoutId(override, byType, orgDefault, docType)`, `parseLayoutByType(json)` |
| `src/domain/settings/branding.ts`, `print.ts`, `theme.ts` | neue Felder, Override mit `layoutId`, `loadPdfTheme(orgId, overrideJson?, docType?)` |
| `src/schemas/settings.ts` | `layoutIdSchema`, `layoutByTypeSchema`, `footerModeSchema`, Branding-Felder, Override-Feld |
| `src/schemas/index.ts` | `organizationSchema.ownerName` |
| `prisma/schema.prisma`, `prisma/schema.postgres.prisma`, Migrationen | `BrandingSettings.layoutId/layoutByTypeJson/footerMode`, `Organization.ownerName` |
| `src/domain/settings/preview.ts`, `src/app/api/settings/branding/preview/route.ts` | Vorschau mit `layoutId`, `docType` inkl. `DUNNING` |
| `src/app/einstellungen/briefpapier/page.tsx`, `src/components/settings/BriefpapierTabs.tsx`, `LayoutGallery.tsx` | drei Reiter, Galerie, Live-Vorschau |
| `src/app/einstellungen/druckoptionen/page.tsx` | Redirect auf `?tab=druckoptionen` |
| `src/components/SettingsTabs.tsx`, `src/lib/nav.ts` | Tabs aus `SETTINGS_ITEMS` (11a-Nachtrag M3) |
| `src/components/PrintOptionsPanel.tsx` | Layout-Auswahl je Beleg (Entwurf) |
| `src/app/api/v1/Layout/route.ts`, `src/api/serializers/layout.ts`, `src/api/openapi.ts`, `openapi/openapi.json` | REST-Liste der Layouts |
| `src/mcp/tools/settings.ts` | `list_pdf_layouts`; `set_print_options` mit `layoutId` |
| `public/layouts/*.svg` | sieben Miniaturen |
| Tests | `test/unit/pdf-footer.test.ts`, `test/unit/pdf-layouts.test.ts`, `test/unit/layout-resolve.test.ts`, Erweiterungen in `test/integration/pdf-theme.test.ts`, `test/integration/settings-routes` (bestehend prüfen), `test/integration/mcp-settings.test.ts`, `test/integration/api-resources.test.ts` (bestehend prüfen) |

---

### Task 1: Schema, Migrationen, Zod, Domain-Felder, Inhaber-Feld

**Files:**
- Create: `src/lib/pdf/layouts/ids.ts`, `prisma/migrations/<ts>_phase11b_layouts/migration.sql` (via Prisma), `prisma/migrations-postgres/<ts>_phase11b_layouts/migration.sql` (Hand)
- Modify: `prisma/schema.prisma`, `prisma/schema.postgres.prisma`, `src/schemas/settings.ts`, `src/schemas/index.ts` (organizationSchema), `src/domain/settings/branding.ts`, `src/components/forms/OrganizationForm.tsx`, der Server-Action/Route, die `organizationSchema` konsumiert (`grep -rn "organizationSchema" src/app`), `src/domain/settings/layout.ts` (neu)
- Test: `test/unit/layout-resolve.test.ts`, `test/integration/pdf-theme.test.ts` (Branding-Roundtrip)

**Interfaces:**
- Produces:
  ```ts
  // src/lib/pdf/layouts/ids.ts
  export const LAYOUT_IDS = ["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"] as const;
  export type LayoutId = (typeof LAYOUT_IDS)[number];
  export const DEFAULT_LAYOUT_ID: LayoutId = "standard";
  export const LAYOUT_DOC_TYPES = ["INVOICE", "CREDIT_NOTE", "QUOTE", "ORDER_CONFIRMATION", "PROFORMA", "DELIVERY_NOTE", "DUNNING"] as const;
  export type LayoutDocType = (typeof LAYOUT_DOC_TYPES)[number];
  // src/schemas/settings.ts
  export const layoutIdSchema = z.enum(LAYOUT_IDS);
  export const layoutByTypeSchema = z.object(Object.fromEntries(LAYOUT_DOC_TYPES.map((t) => [t, layoutIdSchema.optional()])) as Record<LayoutDocType, z.ZodOptional<typeof layoutIdSchema>>);
  export type LayoutByType = z.infer<typeof layoutByTypeSchema>;
  export const footerModeSchema = z.enum(["AUTO", "CUSTOM"]);
  // brandingSettingsInputSchema += layoutId (default "standard"), layoutByType (default {}), footerMode (default "AUTO")
  // printOptionsOverrideSchema += layoutId: layoutIdSchema.optional()
  // src/domain/settings/layout.ts
  export function resolveLayoutId(args: { overrideLayoutId?: LayoutId | null; layoutByType: LayoutByType; orgDefault: LayoutId; docType: LayoutDocType }): LayoutId;
  export function parseLayoutByType(json: string | null | undefined): LayoutByType; // tolerant: {} bei Fehler
  export function invoiceTypeToLayoutDocType(type: string): LayoutDocType; // INVOICE|PARTIAL|DOWNPAYMENT|FINAL|CORRECTION→INVOICE, CREDIT_NOTE→CREDIT_NOTE, ANGEBOT→QUOTE, AUFTRAGSBESTAETIGUNG→ORDER_CONFIRMATION, PROFORMA→PROFORMA
  ```
- `BrandingSettingsInput` erhält `layoutId: LayoutId`, `layoutByType: LayoutByType`, `footerMode: "AUTO"|"CUSTOM"`; DB speichert `layoutByType` als `layoutByTypeJson` (String, JSON).
- `Organization.ownerName String?`; `organizationSchema.ownerName: z.string().max(120).optional()`.

- [ ] **Step 1: Failing tests**

```ts
// test/unit/layout-resolve.test.ts
import { describe, it, expect } from "vitest";
import { resolveLayoutId, parseLayoutByType, invoiceTypeToLayoutDocType } from "@/domain/settings/layout";
import { brandingSettingsInputSchema, printOptionsOverrideSchema } from "@/schemas/settings";

describe("resolveLayoutId", () => {
  it("Override > Typ-Map > Organisation > standard", () => {
    expect(resolveLayoutId({ overrideLayoutId: "blau", layoutByType: { INVOICE: "modern" }, orgDefault: "schlicht", docType: "INVOICE" })).toBe("blau");
    expect(resolveLayoutId({ overrideLayoutId: null, layoutByType: { INVOICE: "modern" }, orgDefault: "schlicht", docType: "INVOICE" })).toBe("modern");
    expect(resolveLayoutId({ layoutByType: { INVOICE: "modern" }, orgDefault: "schlicht", docType: "QUOTE" })).toBe("schlicht");
    expect(resolveLayoutId({ layoutByType: {}, orgDefault: "standard", docType: "DUNNING" })).toBe("standard");
  });
  it("parseLayoutByType ist tolerant und filtert Unbekanntes", () => {
    expect(parseLayoutByType(null)).toEqual({});
    expect(parseLayoutByType("kaputt{")).toEqual({});
    expect(parseLayoutByType(JSON.stringify({ INVOICE: "schlicht", FOO: "x", QUOTE: "nope" }))).toEqual({});
    expect(parseLayoutByType(JSON.stringify({ INVOICE: "schlicht" }))).toEqual({ INVOICE: "schlicht" });
  });
  it("invoiceTypeToLayoutDocType", () => {
    expect(invoiceTypeToLayoutDocType("PARTIAL")).toBe("INVOICE");
    expect(invoiceTypeToLayoutDocType("CREDIT_NOTE")).toBe("CREDIT_NOTE");
    expect(invoiceTypeToLayoutDocType("AUFTRAGSBESTAETIGUNG")).toBe("ORDER_CONFIRMATION");
    expect(invoiceTypeToLayoutDocType("ANGEBOT")).toBe("QUOTE");
    expect(invoiceTypeToLayoutDocType("PROFORMA")).toBe("PROFORMA");
    expect(invoiceTypeToLayoutDocType("unbekannt")).toBe("INVOICE");
  });
});

describe("Zod: Branding + Override", () => {
  it("Defaults: layoutId standard, layoutByType {}, footerMode AUTO", () => {
    const b = brandingSettingsInputSchema.parse({});
    expect(b.layoutId).toBe("standard");
    expect(b.layoutByType).toEqual({});
    expect(b.footerMode).toBe("AUTO");
  });
  it("lehnt unbekannte layoutId, unbekannten Belegtyp und footerMode ab", () => {
    expect(brandingSettingsInputSchema.safeParse({ layoutId: "premium" }).success).toBe(false);
    expect(brandingSettingsInputSchema.safeParse({ layoutByType: { INVOICE: "gibtsnicht" } }).success).toBe(false);
    expect(brandingSettingsInputSchema.safeParse({ layoutByType: { FOO: "standard" } }).success).toBe(false);
    expect(brandingSettingsInputSchema.safeParse({ footerMode: "BOTH" }).success).toBe(false);
    expect(printOptionsOverrideSchema.safeParse({ layoutId: "kompakt" }).success).toBe(true);
    expect(printOptionsOverrideSchema.safeParse({ layoutId: "x" }).success).toBe(false);
  });
});
```

Hinweis: `layoutByTypeSchema` muss `.strict()` sein, damit `FOO` abgelehnt wird.

In `test/integration/pdf-theme.test.ts` (bestehende Datei, Testjahr 2056 bleibt dort) einen Roundtrip ergänzen:

```ts
it("Branding speichert layoutId, layoutByType und footerMode; Organization.ownerName landet im Theme", async () => {
  const orgId = await makeOrg();
  await dbInternal.organization.update({ where: { id: orgId }, data: { ownerName: "Erika Muster" } });
  await saveBrandingSettings(orgId, { layoutId: "schlicht", layoutByType: { DELIVERY_NOTE: "kompakt" }, footerMode: "AUTO" });
  const brand = await loadBrandingSettings(orgId);
  expect(brand.layoutId).toBe("schlicht");
  expect(brand.layoutByType).toEqual({ DELIVERY_NOTE: "kompakt" });
  const theme = await loadPdfTheme(orgId, null, "DELIVERY_NOTE");
  expect(theme.layoutId).toBe("kompakt");
  expect(theme.footerFacts.ownerName).toBe("Erika Muster");
  const inv = await loadPdfTheme(orgId, null, "INVOICE");
  expect(inv.layoutId).toBe("schlicht");
});
```
(`loadPdfTheme` mit drittem Parameter und `theme.layoutId`/`theme.footerFacts` entstehen in Task 3 — dieser Integrationstest wird in Task 1 geschrieben, aber erst ab Task 3 grün; bis dahin mit `it.skip` markieren und in Task 3 aktivieren. `loadBrandingSettings` importieren.)

- [ ] **Step 2: Tests laufen lassen, müssen fehlschlagen**

Run: `npx vitest run test/unit/layout-resolve.test.ts`
Expected: FAIL — `Cannot find module '@/domain/settings/layout'`

- [ ] **Step 3: Konstanten, Zod, Domain**

```ts
// src/lib/pdf/layouts/ids.ts
/** Layout-Kennungen (Phase 11b). Reine Konstanten — auch fuer Zod/Client importierbar. */
export const LAYOUT_IDS = ["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];
export const DEFAULT_LAYOUT_ID: LayoutId = "standard";
export const LAYOUT_DOC_TYPES = ["INVOICE", "CREDIT_NOTE", "QUOTE", "ORDER_CONFIRMATION", "PROFORMA", "DELIVERY_NOTE", "DUNNING"] as const;
export type LayoutDocType = (typeof LAYOUT_DOC_TYPES)[number];
export const LAYOUT_DOC_TYPE_LABEL: Record<LayoutDocType, string> = {
  INVOICE: "Rechnung",
  CREDIT_NOTE: "Gutschrift",
  QUOTE: "Angebot",
  ORDER_CONFIRMATION: "Auftragsbestätigung",
  PROFORMA: "Proforma",
  DELIVERY_NOTE: "Lieferschein",
  DUNNING: "Mahnung",
};
export function isLayoutId(value: unknown): value is LayoutId {
  return typeof value === "string" && (LAYOUT_IDS as readonly string[]).includes(value);
}
```

In `src/schemas/settings.ts` (vor `printOptionsOverrideSchema`):

```ts
import { LAYOUT_IDS, LAYOUT_DOC_TYPES, type LayoutDocType } from "@/lib/pdf/layouts/ids";

export const layoutIdSchema = z.enum(LAYOUT_IDS);
export type LayoutIdInput = z.infer<typeof layoutIdSchema>;
export const layoutByTypeSchema = z
  .object(Object.fromEntries(LAYOUT_DOC_TYPES.map((t) => [t, layoutIdSchema.optional()])) as Record<LayoutDocType, z.ZodOptional<typeof layoutIdSchema>>)
  .strict();
export type LayoutByType = z.infer<typeof layoutByTypeSchema>;
export const footerModeSchema = z.enum(["AUTO", "CUSTOM"]);
```

`printOptionsOverrideSchema` wird zu `z.object({ ...printOptionFields, layoutId: layoutIdSchema.optional() }).partial()`; `brandingSettingsInputSchema` bekommt drei Felder:

```ts
  layoutId: layoutIdSchema.default("standard"),
  layoutByType: layoutByTypeSchema.default({}),
  footerMode: footerModeSchema.default("AUTO"),
```

```ts
// src/domain/settings/layout.ts
import { DEFAULT_LAYOUT_ID, type LayoutDocType, type LayoutId } from "@/lib/pdf/layouts/ids";
import { layoutByTypeSchema, type LayoutByType } from "@/schemas/settings";

/** Aufloesung: Beleg-Override > Typ-Map > Organisationsstandard > "standard" (Spec Phase 11, "Layout-Auswahl"). */
export function resolveLayoutId(args: { overrideLayoutId?: LayoutId | null; layoutByType: LayoutByType; orgDefault: LayoutId; docType: LayoutDocType }): LayoutId {
  return args.overrideLayoutId ?? args.layoutByType[args.docType] ?? args.orgDefault ?? DEFAULT_LAYOUT_ID;
}

/** Liest `BrandingSettings.layoutByTypeJson`; kaputtes JSON oder unbekannte Werte ⇒ {} (nie werfen im Renderpfad). */
export function parseLayoutByType(json: string | null | undefined): LayoutByType {
  if (!json) return {};
  try {
    const parsed = layoutByTypeSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

const INVOICE_FAMILY = new Set(["INVOICE", "PARTIAL", "DOWNPAYMENT", "FINAL", "CORRECTION"]);
export function invoiceTypeToLayoutDocType(type: string): LayoutDocType {
  if (type === "CREDIT_NOTE") return "CREDIT_NOTE";
  if (type === "ANGEBOT") return "QUOTE";
  if (type === "AUFTRAGSBESTAETIGUNG") return "ORDER_CONFIRMATION";
  if (type === "PROFORMA") return "PROFORMA";
  if (INVOICE_FAMILY.has(type)) return "INVOICE";
  return "INVOICE";
}
```

`src/domain/settings/branding.ts`: `loadBrandingSettings` liest zusätzlich `layoutId: row.layoutId, layoutByType: parseLayoutByType(row.layoutByTypeJson), footerMode: row.footerMode`; `saveBrandingSettings` schreibt `layoutByTypeJson: JSON.stringify(input.layoutByType)` und entfernt `layoutByType` aus dem Spread (`const { layoutByType, ...rest } = input;`). Rückgabe bleibt `input`.

- [ ] **Step 4: Prisma-Schema und Migrationen**

`prisma/schema.prisma`, `model BrandingSettings` nach `showBackground`:

```prisma
  // Phase 11b — PDF-Layouts (Spec Phase 11): Organisationsstandard, Map je Belegtyp (JSON), Fusszeilenmodus.
  layoutId         String  @default("standard")
  layoutByTypeJson String?
  footerMode       String  @default("AUTO") // AUTO (vierspaltig aus Stammdaten) | CUSTOM (footerLeft/Center/Right)
```

`model Organization` nach `bankName`:

```prisma
  ownerName        String? // Phase 11b — Inhaber/-in fuer die automatische Fusszeile
```

Dann:

```bash
sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma > prisma/schema.postgres.prisma
npm run db:migrate -- --name phase11b_layouts      # interaktiv? Falls der Befehl blockiert: npx prisma migrate dev --name phase11b_layouts --create-only, dann npx prisma migrate deploy
ls prisma/migrations | tail -1
```

Postgres-Migration von Hand (Ordnername = SQLite-Timestamp + 30 Sekunden, z. B. `20260907120030_phase11b_layouts`):

```sql
-- Phase 11b — PDF-Layouts: Organisationsstandard, Typ-Map, Fusszeilenmodus; Inhaber fuer die Fusszeile.
-- AlterTable
ALTER TABLE "BrandingSettings" ADD COLUMN "layoutId" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "BrandingSettings" ADD COLUMN "layoutByTypeJson" TEXT;
ALTER TABLE "BrandingSettings" ADD COLUMN "footerMode" TEXT NOT NULL DEFAULT 'AUTO';
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "ownerName" TEXT;
```

Vergleiche den Inhalt mit der von Prisma erzeugten SQLite-Datei (dort `ALTER TABLE ... ADD COLUMN` identisch, ggf. in einem Statement je Tabelle) und übernimm Kommentar + Statements.

- [ ] **Step 5: Inhaber-Feld im Stammdaten-Formular**

`src/schemas/index.ts` `organizationSchema`: `ownerName: z.string().trim().max(120).optional(),` nach `legalName`. In `src/components/forms/OrganizationForm.tsx` nach dem Feld „Firmenname": `<TextField label="Inhaber/-in" name="ownerName" defaultValue={org?.ownerName} hint="Erscheint in der automatischen Fußzeile (optional)." />`. Prüfe die Server-Action/Route, die das Formular speichert (`grep -rn "organizationSchema" src/app src/domain`), dass `ownerName` in `create`/`update` durchgereicht wird (leerer String ⇒ `null`). API v1 `Settings` ist davon nicht betroffen (Organisation ist keine Settings-Ressource), MCP: `grep -rn "legalName" src/mcp/tools` — existiert ein `update_organization`-Tool, `ownerName` dort ergänzen; sonst nichts.

- [ ] **Step 6: Tests, Typecheck, Commit**

Run: `npx vitest run test/unit/layout-resolve.test.ts test/integration/pdf-theme.test.ts && npm run typecheck && npm run lint`
Expected: layout-resolve PASS (5), pdf-theme PASS (neuer Test skipped).

```bash
git add prisma src/lib/pdf/layouts/ids.ts src/schemas src/domain/settings test/unit/layout-resolve.test.ts test/integration/pdf-theme.test.ts src/components/forms/OrganizationForm.tsx <action-datei>
git commit -s -m "feat(layouts): Schema, Migrationen, Zod und Aufloesung fuer PDF-Layouts (Phase 11b, Task 1)"
```

---

### Task 2: Layout-Engine — `standard` extrahieren, Rechnungs-Renderer auf Hooks

**Files:**
- Create: `src/lib/pdf/layouts/types.ts`, `src/lib/pdf/layouts/shared.ts`, `src/lib/pdf/layouts/standard.ts`, `src/lib/pdf/layouts/registry.ts`
- Modify: `src/lib/pdf/theme.ts` (`layoutId`, `footerFacts`), `src/lib/pdf/invoice-pdf.ts`, `test/helpers/pdf-theme.ts` (`testPdfTheme` setzt `layoutId: "standard"`, `footerFacts: {}`)
- Test: bestehende `test/unit/pdf-*.test.ts`, `test/integration/pdf-theme.test.ts` müssen unverändert grün bleiben; `test/unit/pdf-layouts.test.ts` (Teil 1: standard)

**Interfaces:**
- Produces:
  ```ts
  // src/lib/pdf/layouts/types.ts
  export interface LayoutFrame { doc: PDFKit.PDFDocument; theme: PdfTheme; margins: PdfMargins; left: number; right: number; width: number; primary: string; base: number /* Grundschrift pt */ }
  export interface KopfInput {
    title: string;                 // "Rechnung", "Lieferschein", "1. Mahnung"
    numberLabel: string; number: string;
    meta: { label: string; value: string }[];  // Datum, Leistungsdatum, Fällig, USt-IdNr, Bezug …
    recipient: { name: string; contactName?: string | null; addressLine1: string; addressLine2?: string | null; postalCode: string; city: string };
    extraRecipientBlock?: { heading: string; lines: string[] }; // Lieferadresse
    senderFallback: string;
    intro?: string | null;         // Kopftext (bereits Platzhalter-aufgeloest)
  }
  export interface TableStyle { headerFill: string | null; headerText: string; headerHeight: number; rowRule: string | null; zebra: string | null; boldTitle: boolean; textColor: string }
  export interface FooterColumn { lines: string[] }
  export interface PdfLayout {
    id: LayoutId; name: string; description: string;
    /** Schriftgroessen-Basis: brand.fontSizePt (Default 10) + Delta */
    fontDelta: number;
    /** zeichnet Logo, Absenderzeile, Empfaenger, Titel, Meta, Kopftext; liefert y fuer den Inhaltsbeginn */
    drawKopf(frame: LayoutFrame, input: KopfInput): number;
    table: TableStyle;
    /** Linie ueber dem Summenblock */
    drawTotalsRule(frame: LayoutFrame, x: number, y: number): void;
    /** Fusszeile (Spalten kommen aus footer.ts); y = Oberkante */
    drawFooter(frame: LayoutFrame, columns: FooterColumn[], y: number): void;
    /** Hoehe, die drawFooter braucht (fuer footY-Berechnung) */
    footerHeight: number;
  }
  // registry.ts
  export function getLayout(id: string | null | undefined): PdfLayout; // Fallback standard
  export function listLayouts(): { id: LayoutId; name: string; description: string }[];
  ```
- `PdfTheme` bekommt `layoutId: LayoutId` und `footerFacts: { website?: string | null; ownerName?: string | null }` (beide Pflichtfelder im Typ; `testPdfTheme` setzt Defaults).

- [ ] **Step 1: Failing test (standard-Textgleichheit)**

```ts
// test/unit/pdf-layouts.test.ts (Teil 1)
import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { getLayout, listLayouts } from "@/lib/pdf/layouts/registry";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";
import type { EInvoiceData } from "@/lib/einvoice/types";

export function sampleInvoice(): EInvoiceData {
  const lines = Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1),
    description: `Position ${i + 1}`,
    descriptionLong: i === 2 ? "**Langtext** mit Details\n- Punkt A\n- Punkt B" : undefined,
    quantityMilli: 2000,
    unit: "C62",
    unitNetPriceCents: 1250,
    lineNetCents: 2500,
    taxRate: 19,
    taxCategory: "S",
    lineType: "ITEM" as const,
    discountCents: i === 4 ? 250 : undefined,
    discountPermille: i === 4 ? 100 : undefined,
  }));
  lines.splice(10, 0, { id: "h1", description: "Abschnitt B", quantityMilli: 0, unit: "C62", unitNetPriceCents: 0, lineNetCents: 0, taxRate: 19, taxCategory: "S", lineType: "HEADING" as const });
  const net = 30 * 2500 - 250;
  const tax = Math.round(net * 0.19);
  return {
    number: "RE-2073-00001",
    type: "INVOICE",
    issueDate: new Date("2073-05-02"),
    dueDate: new Date("2073-05-16"),
    deliveryDate: new Date("2073-05-01"),
    currency: "EUR",
    headerText: "Sehr geehrte Damen und Herren, vielen Dank für Ihren Auftrag.",
    footerText: "Wir bedanken uns für Ihr Vertrauen.",
    seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin", countryCode: "DE", vatId: "DE123456789", taxNumber: "12/345/67890", email: "info@muster.example", phone: "030 123456" },
    buyer: { name: "Kunde AG", contactName: "Frau Beispiel", addressLine1: "Kundenweg 2", postalCode: "54321", city: "Stadt", countryCode: "DE", vatId: "DE987654321" },
    lines,
    taxSubtotals: [{ taxRate: 19, taxCategory: "S", taxableCents: net, taxCents: tax }],
    netTotalCents: net,
    taxTotalCents: tax,
    grossTotalCents: net + tax,
    payableCents: net + tax,
    giroAmountCents: net + tax,
    iban: "DE02120300000000202051",
    bic: "BYLADEM1001",
    bankName: "Testbank",
    paymentTermsHuman: "Zahlbar innerhalb 14 Tagen ohne Abzug.",
  };
}

describe("Layout-Register", () => {
  it("kennt sieben Layouts, standard ist Fallback", () => {
    expect(listLayouts().map((l) => l.id)).toEqual(["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"]);
    expect(getLayout("gibtsnicht").id).toBe("standard");
    expect(getLayout(undefined).id).toBe("standard");
  });
});

describe("Layout standard (Kompatibilitaet)", () => {
  it("rendert die Musterrechnung mit allen Kernangaben auf zwei Seiten", async () => {
    const pdf = await renderInvoicePdf(sampleInvoice(), testPdfTheme({ layoutId: "standard" }));
    const { text, numpages } = await parsePdf(pdf);
    expect(numpages).toBe(2);
    expect(text).toContain("RE-2073-00001");
    expect(text).toContain("Kunde AG");
    expect(text).toContain("Abschnitt B");
    expect(text).toContain("Seite 1 von 2");
    expect(text).toContain("Seite 2 von 2");
    expect((text.match(/Beschreibung/g) ?? []).length).toBeGreaterThanOrEqual(2); // Tabellenkopf auf Seite 2 wiederholt
    expect(text).toContain("DE02120300000000202051");
    expect(text).toContain("Gesamtbetrag");
  });
});
```

(Die `EInvoiceLine`-Felder `descriptionLong`, `discountCents`, `discountPermille`, `taxCategory`, `taxableCents` gegen `src/lib/einvoice/types.ts` prüfen und den Fixture-Typ anpassen, falls Namen abweichen — Assertions bleiben. Das Register wird bis Task 5 nur `standard` enthalten; in Task 2 das Register-Assert auf `expect(listLayouts()[0].id).toBe("standard")` reduzieren und in Task 5 auf die volle Liste erweitern.)

- [ ] **Step 2: Test fehlschlagen lassen**

Run: `npx vitest run test/unit/pdf-layouts.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pdf/layouts/registry'`

- [ ] **Step 3: Typen, shared, standard, Registry**

```ts
// src/lib/pdf/layouts/types.ts
import type { PdfTheme } from "../theme";
import type { PdfMargins } from "../layout";
import type { LayoutId } from "./ids";

export interface LayoutFrame {
  doc: PDFKit.PDFDocument;
  theme: PdfTheme;
  margins: PdfMargins;
  left: number;
  right: number;
  width: number;
  primary: string;
  /** Grundschriftgroesse in pt (brand.fontSizePt + layout.fontDelta) */
  base: number;
}

export interface KopfMetaRow {
  label: string;
  value: string;
}

export interface KopfInput {
  title: string;
  numberLabel: string;
  number: string;
  meta: KopfMetaRow[];
  recipient: { name: string; contactName?: string | null; addressLine1: string; addressLine2?: string | null; postalCode: string; city: string };
  extraRecipientBlock?: { heading: string; lines: string[] };
  senderFallback: string;
  intro?: string | null;
}

export interface TableStyle {
  headerFill: string | null;
  headerText: string;
  headerHeight: number;
  rowRule: string | null;
  zebra: string | null;
  boldTitle: boolean;
  textColor: string;
}

export interface FooterColumn {
  lines: string[];
}

export interface PdfLayout {
  id: LayoutId;
  name: string;
  description: string;
  fontDelta: number;
  drawKopf(frame: LayoutFrame, input: KopfInput): number;
  table: TableStyle;
  drawTotalsRule(frame: LayoutFrame, x: number, y: number): void;
  drawFooter(frame: LayoutFrame, columns: FooterColumn[], y: number): void;
  footerHeight: number;
}
```

```ts
// src/lib/pdf/layouts/shared.ts
import type { LayoutFrame, KopfInput, FooterColumn } from "./types";
import { drawLogo, drawSenderLine } from "../layout";

/** Empfaengerblock (DIN-5008-Fenster); liefert Unterkante. */
export function drawRecipient(frame: LayoutFrame, input: KopfInput, y: number, size = 11): number {
  const { doc, left } = frame;
  const r = input.recipient;
  doc.fillColor("#000").font("Helvetica").fontSize(size);
  doc.text(r.name, left, y);
  if (r.contactName) doc.text(r.contactName);
  doc.text(r.addressLine1);
  if (r.addressLine2) doc.text(r.addressLine2);
  doc.text(`${r.postalCode} ${r.city}`);
  if (input.extraRecipientBlock) {
    doc.fontSize(size - 2).fillColor("#555").text(input.extraRecipientBlock.heading, left, doc.y + 8);
    doc.fontSize(size).fillColor("#000");
    for (const l of input.extraRecipientBlock.lines) doc.text(l);
  }
  return doc.y;
}

/** Rechtsbuendige Meta-Zeilen "Label: Wert" ab (x, y); liefert Unterkante. */
export function drawMetaRows(frame: LayoutFrame, rows: { label: string; value: string }[], x: number, y: number, size = 10, color = "#333"): number {
  const { doc, right } = frame;
  doc.font("Helvetica").fontSize(size).fillColor(color);
  let first = true;
  for (const row of rows) {
    if (first) {
      doc.text(`${row.label}: ${row.value}`, x, y, { width: right - x, align: "right" });
      first = false;
    } else {
      doc.text(`${row.label}: ${row.value}`, { width: right - x, align: "right" });
    }
  }
  return doc.y;
}

/** Zweispaltige Meta-Tabelle (Label links grau, Wert rechts) fuer sevDesk-artige Infobloecke; liefert Unterkante. */
export function drawMetaTable(frame: LayoutFrame, rows: { label: string; value: string }[], x: number, y: number, width: number, size = 9): number {
  const { doc } = frame;
  let cy = y;
  for (const row of rows) {
    doc.font("Helvetica").fontSize(size).fillColor("#555").text(row.label, x, cy, { width: width / 2, lineBreak: false });
    doc.fillColor("#000").text(row.value, x + width / 2, cy, { width: width / 2, align: "right", lineBreak: false });
    cy += size + 4;
  }
  return cy;
}

/** Fusszeilen-Spalten gleichmaessig ueber die Breite; liefert nichts. */
export function drawFooterColumns(frame: LayoutFrame, columns: FooterColumn[], y: number, size = 7.5, color = "#666666"): void {
  const { doc, left, width } = frame;
  const visible = columns.filter((c) => c.lines.length > 0);
  if (visible.length === 0) return;
  const gap = 10;
  const colWidth = (width - gap * (visible.length - 1)) / visible.length;
  doc.font("Helvetica").fontSize(size).fillColor(color);
  visible.forEach((col, i) => {
    doc.text(col.lines.join("\n"), left + i * (colWidth + gap), y, { width: colWidth, lineGap: 1 });
  });
}

export function drawLogoAndSender(frame: LayoutFrame, input: KopfInput): void {
  const { doc, theme, right, left, margins } = frame;
  drawLogo(doc, theme, right, margins.top);
  drawSenderLine(doc, theme, left, margins.top, input.senderFallback);
}
```

```ts
// src/lib/pdf/layouts/standard.ts
/** Layout "Standard" — exakt das Layout von Phase 7 (Kompatibilitaet fuer Bestandsbetreiber). */
import type { PdfLayout } from "./types";
import { drawLogoAndSender, drawRecipient, drawMetaRows, drawFooterColumns } from "./shared";

export const standardLayout: PdfLayout = {
  id: "standard",
  name: "Standard",
  description: "Dunkler Tabellenkopf, Titel in Primärfarbe, dreispaltige Fußzeile.",
  fontDelta: 0,
  drawKopf(frame, input) {
    const { doc, left, right, margins, primary } = frame;
    drawLogoAndSender(frame, input);
    const buyerY = margins.top + 60;
    drawRecipient(frame, input, buyerY);
    doc.fontSize(18).fillColor(primary).font("Helvetica").text(input.title, left, buyerY, { align: "right", width: right - left });
    const metaTop = margins.top + 90;
    drawMetaRows(frame, [{ label: input.numberLabel, value: input.number }, ...input.meta], left + 250, metaTop);
    let y = margins.top + 170;
    if (input.intro) {
      doc.fontSize(9).fillColor("#333").text(input.intro, left, y, { width: right - left });
      y = doc.y + 10;
    }
    return y;
  },
  table: { headerFill: "#1f2937", headerText: "#fff", headerHeight: 18, rowRule: null, zebra: null, boldTitle: false, textColor: "#000" },
  drawTotalsRule(frame, x, y) {
    frame.doc.moveTo(x, y).lineTo(frame.right, y).strokeColor(frame.primary).stroke();
  },
  drawFooter(frame, columns, y) {
    // Phase 7: drei Spalten (links/mitte/rechts) — bei AUTO-Fusszeile werden vier Spalten
    // gleichmaessig verteilt; Text grau 8pt wie bisher.
    drawFooterColumns(frame, columns, y, 8, "#666666");
  },
  footerHeight: 32,
};
```

```ts
// src/lib/pdf/layouts/registry.ts
import { DEFAULT_LAYOUT_ID, LAYOUT_IDS, isLayoutId, type LayoutId } from "./ids";
import type { PdfLayout } from "./types";
import { standardLayout } from "./standard";

const LAYOUTS: Partial<Record<LayoutId, PdfLayout>> = { standard: standardLayout };

export function registerLayout(layout: PdfLayout): void {
  LAYOUTS[layout.id] = layout;
}

export function getLayout(id: string | null | undefined): PdfLayout {
  if (isLayoutId(id)) {
    const found = LAYOUTS[id];
    if (found) return found;
  }
  return LAYOUTS[DEFAULT_LAYOUT_ID]!;
}

export function listLayouts(): { id: LayoutId; name: string; description: string }[] {
  return LAYOUT_IDS.filter((id) => LAYOUTS[id]).map((id) => ({ id, name: LAYOUTS[id]!.name, description: LAYOUTS[id]!.description }));
}
```

(Tasks 4/5 ersetzen `Partial<Record>` durch das vollständige `Record` mit allen sieben Imports und entfernen `registerLayout`.)

`src/lib/pdf/theme.ts`:

```ts
import type { LayoutId } from "./layouts/ids";
export interface PdfFooterFacts { website?: string | null; ownerName?: string | null }
export interface PdfTheme {
  brand: BrandingSettingsInput;
  options: EffectivePrintOptions;
  /** Phase 11b — aufgeloeste Layout-Kennung (Override > Typ-Map > Organisation). */
  layoutId: LayoutId;
  /** Phase 11b — Zusatzfakten fuer die AUTO-Fusszeile, die nicht in EInvoiceData stehen. */
  footerFacts: PdfFooterFacts;
  logoBuffer?: Buffer; backgroundBuffer?: Buffer; showPaymentTermsText: boolean; compress?: boolean;
}
```

`test/helpers/pdf-theme.ts` `testPdfTheme`: `layoutId: "standard", footerFacts: {}` in die Defaults; `overrides` dürfen `layoutId` setzen. `src/domain/settings/theme.ts` vorläufig: `layoutId: brand.layoutId, footerFacts: {}` (Task 3 vervollständigt).

- [ ] **Step 4: `invoice-pdf.ts` auf Hooks umstellen**

Ersetze in `renderInvoicePdf` die Zeilen 144–179 (Logo bis Kopftext) durch:

```ts
  const layout = getLayout(theme.layoutId);
  const base = theme.brand.fontSizePt + layout.fontDelta; // Phase 11b: fontSizePt wird erstmals konsumiert
  const frame: LayoutFrame = { doc, theme, margins, left, right, width: right - left, primary: theme.brand.primaryColor, base };
  const meta: KopfMetaRow[] = [{ label: "Rechnungsdatum", value: deDate(data.issueDate) }];
  if (data.deliveryDate) meta.push({ label: "Leistungsdatum", value: deDate(data.deliveryDate) });
  if (data.dueDate) meta.push({ label: "Fällig am", value: deDate(data.dueDate) });
  if (data.buyer.vatId) meta.push({ label: "USt-IdNr. Empfänger", value: data.buyer.vatId });
  if (data.sourceNumber) meta.push({ label: "Bezug", value: `zu ${data.sourceLabel ?? "Beleg"} ${data.sourceNumber}` });
  let y = layout.drawKopf(frame, {
    title: TYPE_TITLE[data.type] ?? "Rechnung",
    numberLabel: NUMBER_LABEL[data.type] ?? "Nummer",
    number: data.number,
    meta,
    recipient: data.buyer,
    senderFallback: `${data.seller.name} · ${data.seller.addressLine1} · ${data.seller.postalCode} ${data.seller.city}`,
    intro: data.headerText,
  });
```

Wichtig für die Textgleichheit von `standard`: `drawMetaRows` schreibt „Rechnungsnummer: RE-…" als erste Zeile, danach dieselben Zeilen wie bisher; das Meta-Label „Fällig am" und die Reihenfolge bleiben identisch.

Tabellenkopf (Zeilen 193–203) nutzt `layout.table`:

```ts
  const drawTableHeader = (atY: number): number => {
    const t = layout.table;
    doc.fontSize(base - 1);
    if (t.headerFill) {
      doc.rect(left, atY, right - left, t.headerHeight).fill(t.headerFill);
    } else {
      doc.moveTo(left, atY + t.headerHeight).lineTo(right, atY + t.headerHeight).strokeColor(t.rowRule ?? "#999").stroke();
    }
    doc.fillColor(t.headerText).font(t.headerFill ? "Helvetica" : "Helvetica-Oblique");
    for (const col of columns) {
      if (col.key === "desc" && !theme.options.showDescription) continue;
      doc.text(col.header, tableX + colX[col.key]!, atY + (t.headerFill ? 5 : 3), { width: col.width, align: col.align ?? "left" });
    }
    doc.font("Helvetica").fillColor(t.textColor).fontSize(base - 1);
    return atY + t.headerHeight + 4;
  };
```

Für `standard` (headerFill `#1f2937`, headerHeight 18, Text `#fff`) ergibt das exakt die bisherige Geometrie (`atY + 22`). In der ITEM-Zeile: `if (layout.table.boldTitle) doc.font("Helvetica-Bold")` vor `doc.text(line.description, …)` und danach `doc.font("Helvetica")`; bei `zebra` vor jeder ITEM-Zeile mit geradem `itemPos` ein `doc.rect(left, y - 2, right - left, h).fill(zebra)` und `doc.fillColor(textColor)`; bei `rowRule` nach der Zeile eine 0.3-pt-Linie in `rowRule`-Farbe unter `y + h - 3`. Alle Schriftgrößen `9` → `base - 1`, `10` → `base`, `8` → `base - 2`, `18` (Titel) bleibt in den Layouts.

Summenlinie (Zeile 304) → `layout.drawTotalsRule(frame, sumLabelX, y)`. Fußzeile (Zeilen 381–411) →

```ts
  const footY = doc.page.height - margins.bottom - layout.footerHeight;
  if (theme.options.showFooter) {
    layout.drawFooter(frame, buildFooterColumns({ seller: data.seller, iban: data.iban, bic: data.bic, bankName: data.bankName, ...theme.footerFacts }, theme.brand), footY);
  }
```

`buildFooterColumns` kommt in Task 3; in Task 2 eine lokale Zwischenlösung vermeiden — Task 2 und 3 werden nacheinander vom selben Implementer ausgeführt (siehe Dispatch-Hinweis), Task 2 darf `footer.ts` bereits mit der `CUSTOM`-/Fallback-Logik anlegen (drei Spalten aus `footerLeft/Center/Right`, sonst die zwei bisherigen Fallback-Zeilen als eine Spalte), Task 3 ergänzt AUTO. GiroCode-Position: `giroY = footY - giroSize - 14` bleibt.

- [ ] **Step 5: Alle PDF-Tests laufen lassen**

Run: `npx vitest run test/unit/pdf-layouts.test.ts test/unit/pdf-marks.test.ts test/unit/pdf-compress.test.ts test/unit/pdf-data.test.ts test/integration/pdf-theme.test.ts test/integration/pdf-contact-placeholder.test.ts && npm run typecheck && npm run lint`
Expected: alle PASS. Bei Textabweichung in bestehenden Tests: Geometrie/Schriftgrößen angleichen, nicht die Tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pdf test/helpers/pdf-theme.ts test/unit/pdf-layouts.test.ts src/domain/settings/theme.ts
git commit -s -m "feat(layouts): Layout-Engine, standard-Layout extrahiert, Rechnungs-Renderer auf Hooks (Phase 11b, Task 2)"
```

---

### Task 3: Automatische Fußzeile, Theme-Fakten, Lieferschein- und Mahnungs-Renderer auf Hooks

**Files:**
- Create: `src/lib/pdf/footer.ts`
- Modify: `src/domain/settings/theme.ts` (`loadPdfTheme(orgId, overrideJson?, docType?)`), `src/lib/pdf/delivery-note-pdf.ts`, `src/lib/pdf/dunning-pdf.ts`, `src/lib/pdf/invoice-pdf.ts` (Import), `test/integration/pdf-theme.test.ts` (Skip entfernen)
- Test: `test/unit/pdf-footer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FooterFacts { seller: { name: string; addressLine1: string; addressLine2?: string | null; postalCode: string; city: string; vatId?: string | null; taxNumber?: string | null; email?: string | null; phone?: string | null }; iban?: string | null; bic?: string | null; bankName?: string | null; website?: string | null; ownerName?: string | null }
  export function buildFooterColumns(facts: FooterFacts, brand: BrandingSettingsInput): FooterColumn[];
  ```
  AUTO: vier Spalten `[Firma, Adresse1, (Adresse2), PLZ Ort]`, `[Tel. …, E-Mail …, Web …]`, `[USt-IdNr. …, Steuer-Nr. …, Inhaber/-in …]`, `[Bank …, IBAN …, BIC …]`; leere Zeilen entfallen, leere Spalten entfallen. CUSTOM: drei Spalten aus `footerLeft/Center/Right` (nur gesetzte). Ist CUSTOM gewählt, aber alle drei leer ⇒ AUTO.
- `loadPdfTheme(orgId, overrideJson?, docType: LayoutDocType = "INVOICE")` setzt `layoutId = resolveLayoutId({ overrideLayoutId: override.layoutId, layoutByType: brand.layoutByType, orgDefault: brand.layoutId, docType })` und `footerFacts` aus `Organization` (`website`, `ownerName`).

- [ ] **Step 1: Failing test**

```ts
// test/unit/pdf-footer.test.ts
import { describe, it, expect } from "vitest";
import { buildFooterColumns } from "@/lib/pdf/footer";
import { brandingSettingsInputSchema } from "@/schemas/settings";

const seller = { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin", vatId: "DE123456789", taxNumber: "12/345/67890", email: "info@muster.example", phone: "030 1" };

describe("buildFooterColumns", () => {
  it("AUTO: vier Spalten aus Stammdaten, leere Zeilen entfallen", () => {
    const cols = buildFooterColumns({ seller, iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Testbank", website: "muster.example", ownerName: "Erika Muster" }, brandingSettingsInputSchema.parse({}));
    expect(cols).toHaveLength(4);
    expect(cols[0]!.lines).toEqual(["Muster GmbH", "Hauptstr. 1", "12345 Berlin"]);
    expect(cols[1]!.lines).toEqual(["Tel. 030 1", "E-Mail info@muster.example", "Web muster.example"]);
    expect(cols[2]!.lines).toEqual(["USt-IdNr. DE123456789", "Steuer-Nr. 12/345/67890", "Inhaber/-in Erika Muster"]);
    expect(cols[3]!.lines).toEqual(["Bank Testbank", "IBAN DE02 1203 0000 0000 2020 51", "BIC BYLADEM1001"]);
  });
  it("AUTO ohne Bank/Kontakt: nur die belegten Spalten", () => {
    const cols = buildFooterColumns({ seller: { ...seller, email: null, phone: null, vatId: null, taxNumber: null } }, brandingSettingsInputSchema.parse({}));
    expect(cols).toHaveLength(1);
  });
  it("CUSTOM: drei Freitextspalten; leer ⇒ AUTO", () => {
    const custom = brandingSettingsInputSchema.parse({ footerMode: "CUSTOM", footerLeft: "L", footerRight: "R" });
    expect(buildFooterColumns({ seller }, custom).map((c) => c.lines)).toEqual([["L"], ["R"]]);
    const empty = brandingSettingsInputSchema.parse({ footerMode: "CUSTOM" });
    expect(buildFooterColumns({ seller }, empty)[0]!.lines[0]).toBe("Muster GmbH");
  });
});
```

- [ ] **Step 2: Fehlschlag prüfen**

Run: `npx vitest run test/unit/pdf-footer.test.ts` — Expected: FAIL `Cannot find module '@/lib/pdf/footer'` (bzw. Assertions, falls Task 2 eine Vorstufe anlegte).

- [ ] **Step 3: footer.ts**

```ts
// src/lib/pdf/footer.ts
/**
 * Fusszeile (Phase 11b, Spec "Fusszeile"): AUTO = vier Spalten aus den Stammdaten
 * (Firma/Adresse | Kontakt | Steuer/Inhaber | Bank), CUSTOM = die drei Freitextfelder aus
 * Phase 7. Reine Funktion, die Layouts zeichnen die Spalten.
 */
import type { BrandingSettingsInput } from "@/schemas/settings";
import type { FooterColumn } from "./layouts/types";

export interface FooterFacts {
  seller: { name: string; addressLine1: string; addressLine2?: string | null; postalCode: string; city: string; vatId?: string | null; taxNumber?: string | null; email?: string | null; phone?: string | null };
  iban?: string | null;
  bic?: string | null;
  bankName?: string | null;
  website?: string | null;
  ownerName?: string | null;
}

function groupIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

function compact(lines: (string | null | undefined | false)[]): string[] {
  return lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0);
}

export function buildFooterColumns(facts: FooterFacts, brand: BrandingSettingsInput): FooterColumn[] {
  if (brand.footerMode === "CUSTOM") {
    const custom = compact([brand.footerLeft, brand.footerCenter, brand.footerRight]).map((t) => ({ lines: [t] }));
    if (custom.length > 0) return custom;
  }
  const s = facts.seller;
  const columns: FooterColumn[] = [
    { lines: compact([s.name, s.addressLine1, s.addressLine2, `${s.postalCode} ${s.city}`]) },
    { lines: compact([s.phone && `Tel. ${s.phone}`, s.email && `E-Mail ${s.email}`, facts.website && `Web ${facts.website}`]) },
    { lines: compact([s.vatId && `USt-IdNr. ${s.vatId}`, s.taxNumber && `Steuer-Nr. ${s.taxNumber}`, facts.ownerName && `Inhaber/-in ${facts.ownerName}`]) },
    { lines: compact([facts.bankName && `Bank ${facts.bankName}`, facts.iban && `IBAN ${groupIban(facts.iban)}`, facts.bic && `BIC ${facts.bic}`]) },
  ];
  return columns.filter((c) => c.lines.length > 0);
}
```

- [ ] **Step 4: `loadPdfTheme` erweitern**

```ts
export async function loadPdfTheme(orgId: string, overrideJson?: string | null, docType: LayoutDocType = "INVOICE"): Promise<PdfTheme> {
  const [brand, printSettings, documentSettings, org] = await Promise.all([
    loadBrandingSettings(orgId),
    loadPrintSettings(orgId),
    loadDocumentSettings(orgId),
    dbInternal.organization.findUnique({ where: { id: orgId }, select: { website: true, ownerName: true } }),
  ]);
  const options = effectivePrintOptions(printSettings, overrideJson);
  const layoutId = resolveLayoutId({ overrideLayoutId: options.layoutId ?? null, layoutByType: brand.layoutByType, orgDefault: brand.layoutId, docType });
  // … Logo/Hintergrund wie bisher …
  return { brand, options, layoutId, footerFacts: { website: org?.website ?? null, ownerName: org?.ownerName ?? null }, logoBuffer, backgroundBuffer, showPaymentTermsText: documentSettings.showPaymentTermsText };
}
```

`effectivePrintOptions` liefert jetzt `PrintSettingsInput & { layoutId?: LayoutId }` (Typ `EffectivePrintOptions` in `theme.ts` entsprechend erweitern); der Spread `{ ...global, ...parsed.data }` trägt `layoutId` automatisch mit.

- [ ] **Step 5: Lieferschein und Mahnung auf Hooks**

`delivery-note-pdf.ts` Zeilen 153–197 → `layout.drawKopf(frame, { title: "Lieferschein", numberLabel: "Lieferscheinnummer", number: data.number, meta: [Datum, Lieferdatum?, Versanddatum?, Bezugsbeleg?], recipient: data.buyer, extraRecipientBlock: data.showDeliveryAddress && data.deliveryAddress ? { heading: "Lieferadresse:", lines: [addressLine1, addressLine2?, "PLZ Ort"] } : undefined, senderFallback, intro: data.headerText })`; Rückgabe = Tabellenbeginn (die bisherige `Math.max(leftColumnBottom, rightColumnBottom, margins.top + 150) + 20`-Logik wandert in `standard.drawKopf`: `return Math.max(recipientBottom, metaBottom, margins.top + 150) + 20` wenn `extraRecipientBlock` gesetzt ist, sonst wie in Task 2). Tabellenkopf und Fußzeile analog zu Task 2 (Tabellenkopf-Helfer aus `invoice-pdf.ts` in `shared.ts` als `drawTableHeaderRow(frame, layout, columns, atY, showDescription)` verschieben und in beiden Engines nutzen). Auch der Lieferschein bekommt den `ensureSpace`-Schutz je Zeile (Nachtrag aus der Erhebung: bisher ohne Paginierungsschutz) — dieselbe Logik wie in `invoice-pdf.ts`.

`dunning-pdf.ts` Zeilen 83–100 → `layout.drawKopf(frame, { title, numberLabel: "Nr.", number: data.number, meta: [{ label: "Datum", value: deDate(data.sentDate) }], recipient: data.buyer, senderFallback })`; Anrede/Intro ab `y + 0` statt `margins.top + 150`, Aufstellung ab `doc.y + 20` statt `margins.top + 240`; Summenlinie → `layout.drawTotalsRule`; Fußzeile → `layout.drawFooter` mit `buildFooterColumns({ seller: data.seller, iban: data.iban, bic: data.bic, bankName: data.bankName, ...theme.footerFacts }, theme.brand)` (Felder gegen `DunningPdfData` prüfen).

- [ ] **Step 6: Tests**

`test/integration/pdf-theme.test.ts`: den in Task 1 übersprungenen Test aktivieren; zusätzlich:

```ts
it("AUTO-Fusszeile: Inhaber und Website stehen im Rechnungs-, Lieferschein- und Mahnungs-PDF", async () => {
  const orgId = await makeOrg();
  await dbInternal.organization.update({ where: { id: orgId }, data: { ownerName: "Erika Muster", website: "muster.example" } });
  const theme = await loadPdfTheme(orgId);
  const inv = await parsePdf(await renderInvoicePdf(baseInvoiceData(), { ...theme, compress: false }));
  expect(inv.text).toContain("Inhaber/-in Erika Muster");
  expect(inv.text).toContain("Web muster.example");
  // Lieferschein + Mahnung: bestehende Fixtures dieser Datei (deliveryNoteData()/dunningData()) verwenden
});
```

Run: `npx vitest run test/unit/pdf-footer.test.ts test/unit/pdf-layouts.test.ts test/unit/delivery-note-pdf.test.ts test/integration/pdf-theme.test.ts && npm run typecheck && npm run lint` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pdf src/domain/settings/theme.ts test/unit/pdf-footer.test.ts test/integration/pdf-theme.test.ts
git commit -s -m "feat(layouts): automatische Fusszeile, Theme-Fakten, Lieferschein/Mahnung auf Layout-Hooks (Phase 11b, Task 3)"
```

---

### Task 4: Layouts `schlicht`, `klassik`, `modern` + Miniaturen

**Files:**
- Create: `src/lib/pdf/layouts/schlicht.ts`, `klassik.ts`, `modern.ts`, `public/layouts/standard.svg`, `schlicht.svg`, `klassik.svg`, `modern.svg`
- Modify: `src/lib/pdf/layouts/registry.ts`
- Test: `test/unit/pdf-layouts.test.ts` (Teil 2)

**Interfaces:** nutzt `PdfLayout`, `shared.ts`, `drawFooterColumns`, `drawMetaTable`.

- [ ] **Step 1: Failing test (Matrix, vorerst vier Layouts)**

```ts
// test/unit/pdf-layouts.test.ts — anhaengen
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
// Fixtures: deliveryNoteData() und dunningData() aus test/integration/pdf-theme.test.ts in
// test/helpers/pdf-fixtures.ts verschieben und hier importieren (Task 4 legt die Helferdatei an).
import { sampleDeliveryNote, sampleDunning } from "../helpers/pdf-fixtures";

const MATRIX = ["standard", "schlicht", "klassik", "modern"] as const; // Task 5: + blau, schwarz, kompakt

describe.each(MATRIX)("Layout %s", (layoutId) => {
  it("Rechnung: zwei Seiten, Kernangaben, Fusszeile, kein Notizleck", async () => {
    const data = sampleInvoice();
    const pdf = await renderInvoicePdf(data, testPdfTheme({ layoutId, footerFacts: { ownerName: "Erika Muster", website: "muster.example" } }));
    const { text, numpages } = await parsePdf(pdf);
    expect(numpages).toBeGreaterThanOrEqual(2);
    for (const s of ["RE-2073-00001", "Kunde AG", "Abschnitt B", "Position 30", "Langtext", "Gesamtbetrag", "DE02 1203 0000 0000 2020 51", "Inhaber/-in Erika Muster", "Seite 1 von"]) {
      expect(text, `${layoutId}: ${s}`).toContain(s);
    }
    expect((text.match(/Beschreibung/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain("GEHEIM");
  });
  it("Lieferschein und Mahnung rendern", async () => {
    const dn = await parsePdf(await renderDeliveryNotePdf(sampleDeliveryNote(), testPdfTheme({ layoutId })));
    expect(dn.text).toContain("Lieferschein");
    const du = await parsePdf(await renderDunningPdf(sampleDunning(), testPdfTheme({ layoutId })));
    expect(du.text).toMatch(/Mahnung|Zahlungserinnerung/);
  });
});
```

`sampleInvoice()` bekommt zusätzlich `notes: "Sichtbare Notiz"`; ein Feld `internalNotes` existiert in `EInvoiceData` nicht — der Negativtest sichert, dass kein Layout den String „GEHEIM" aus versehentlich durchgereichten Daten druckt: in `sampleInvoice()` `(data as unknown as Record<string, unknown>).internalNotes = "GEHEIM-NOTIZ"` setzen.

- [ ] **Step 2: Fehlschlag prüfen** — Run: `npx vitest run test/unit/pdf-layouts.test.ts` — Expected: FAIL (schlicht/klassik/modern fallen auf standard zurück? Nein: `getLayout` liefert standard, die Texte würden bestehen). Damit der Test die Layouts wirklich erzwingt: `it("Register enthaelt %s", () => expect(getLayout(layoutId).id).toBe(layoutId))` in `describe.each` ergänzen — das schlägt fehl, solange das Layout fehlt.

- [ ] **Step 3: schlicht (Referenz = Beispielbelege AN-1094 / RE-41362)**

```ts
// src/lib/pdf/layouts/schlicht.ts
/**
 * Layout "Schlicht" — nach den sevDesk-Beispielbelegen des Betreibers: Logo rechts oben,
 * kleine Absenderzeile, Infoblock rechts als zweispaltige Tabelle (Nummer gross kursiv),
 * Titel fett-kursiv, Tabellenkopf nur kursiv mit Linie, fette Positionstitel, vierspaltige
 * Fusszeile in Primaerfarbe.
 */
import type { PdfLayout } from "./types";
import { drawLogoAndSender, drawRecipient, drawMetaTable, drawFooterColumns } from "./shared";

export const schlichtLayout: PdfLayout = {
  id: "schlicht",
  name: "Schlicht",
  description: "Ruhig und klar: Infoblock rechts, kursive Tabellenköpfe, fette Positionstitel, farbige vierspaltige Fußzeile.",
  fontDelta: 0,
  drawKopf(frame, input) {
    const { doc, left, right, margins, base } = frame;
    drawLogoAndSender(frame, input);
    const buyerY = margins.top + 62;
    const recipientBottom = drawRecipient(frame, input, buyerY, base + 1);

    // Infoblock rechts (Breite 200): Nummer gross kursiv, darunter Label/Wert-Zeilen.
    const infoX = right - 200;
    doc.font("Helvetica-Oblique").fontSize(base + 3).fillColor("#000");
    doc.text(input.numberLabel, infoX, buyerY - 4, { width: 100, lineBreak: false });
    doc.text(input.number, infoX + 100, buyerY - 4, { width: 100, align: "right", lineBreak: false });
    const metaBottom = drawMetaTable(frame, input.meta, infoX, buyerY + base + 8, 200, base - 1);

    let y = Math.max(recipientBottom, metaBottom, margins.top + 150) + 26;
    doc.font("Helvetica-BoldOblique").fontSize(base + 4).fillColor("#000").text(`${input.title} ${input.number}`, left, y, { width: right - left });
    y = doc.y + 12;
    if (input.intro) {
      doc.font("Helvetica").fontSize(base).fillColor("#000").text(input.intro, left, y, { width: right - left });
      y = doc.y + 12;
    }
    return y;
  },
  table: { headerFill: null, headerText: "#333", headerHeight: 16, rowRule: "#dddddd", zebra: null, boldTitle: true, textColor: "#000" },
  drawTotalsRule(frame, x, y) {
    frame.doc.moveTo(x, y).lineTo(frame.right, y).lineWidth(0.5).strokeColor("#999999").stroke().lineWidth(1);
  },
  drawFooter(frame, columns, y) {
    drawFooterColumns(frame, columns, y, 7.5, frame.primary);
  },
  footerHeight: 44,
};
```

Der Titel enthält bei `schlicht` die Nummer („Angebot AN-1094"); im Infoblock steht sie ebenfalls (wie im Beispiel). Beim Lieferschein/Mahnung gilt dasselbe Muster.

- [ ] **Step 4: klassik und modern**

```ts
// src/lib/pdf/layouts/klassik.ts
import type { PdfLayout } from "./types";
import { drawRecipient, drawMetaRows, drawFooterColumns } from "./shared";
import { drawLogo, drawSenderLine } from "../layout";
import { mm } from "../marks";

/** Layout "Klassik" — Logo links oben, Firmenname rechts, Doppellinie unter dem Kopf, graue Fusszeile mit Linie. */
export const klassikLayout: PdfLayout = {
  id: "klassik",
  name: "Klassik",
  description: "Logo links, Firmenname rechts, Doppellinie unter dem Kopf, dezente graue Fußzeile.",
  fontDelta: 0,
  drawKopf(frame, input) {
    const { doc, theme, left, right, margins, primary, base } = frame;
    if (theme.logoBuffer) doc.image(theme.logoBuffer, left, margins.top, { width: mm(theme.brand.logoWidthMm) });
    doc.font("Helvetica-Bold").fontSize(base + 4).fillColor(primary).text(input.senderFallback.split(" · ")[0] ?? "", left, margins.top, { width: right - left, align: "right" });
    const ruleY = margins.top + 42;
    doc.moveTo(left, ruleY).lineTo(right, ruleY).lineWidth(1.2).strokeColor(primary).stroke();
    doc.moveTo(left, ruleY + 3).lineTo(right, ruleY + 3).lineWidth(0.4).strokeColor(primary).stroke().lineWidth(1);
    drawSenderLine(doc, theme, left, ruleY + 12, input.senderFallback);
    const buyerY = ruleY + 30;
    const recipientBottom = drawRecipient(frame, input, buyerY, base + 1);
    doc.font("Helvetica-Bold").fontSize(base + 6).fillColor("#000").text(input.title, left + 250, buyerY, { width: right - left - 250, align: "right" });
    const metaBottom = drawMetaRows(frame, [{ label: input.numberLabel, value: input.number }, ...input.meta], left + 250, buyerY + base + 14, base, "#333");
    let y = Math.max(recipientBottom, metaBottom, margins.top + 160) + 20;
    if (input.intro) {
      doc.font("Helvetica").fontSize(base).fillColor("#000").text(input.intro, left, y, { width: right - left });
      y = doc.y + 10;
    }
    return y;
  },
  table: { headerFill: null, headerText: "#000", headerHeight: 18, rowRule: "#cccccc", zebra: null, boldTitle: false, textColor: "#000" },
  drawTotalsRule(frame, x, y) {
    frame.doc.moveTo(x, y).lineTo(frame.right, y).strokeColor("#000").stroke();
  },
  drawFooter(frame, columns, y) {
    frame.doc.moveTo(frame.left, y - 6).lineTo(frame.right, y - 6).lineWidth(0.4).strokeColor("#999999").stroke().lineWidth(1);
    drawFooterColumns(frame, columns, y, 7.5, "#555555");
  },
  footerHeight: 40,
};
```

```ts
// src/lib/pdf/layouts/modern.ts
import type { PdfLayout } from "./types";
import { drawRecipient, drawMetaTable, drawFooterColumns } from "./shared";
import { drawSenderLine } from "../layout";
import { mm } from "../marks";

/** Layout "Modern" — Kopfbalken in Primaerfarbe ueber die volle Breite mit Logo/Firmenname in Weiss, Infoblock als Karte. */
export const modernLayout: PdfLayout = {
  id: "modern",
  name: "Modern",
  description: "Farbiger Kopfbalken mit Logo, Infoblock als Karte, Zebrastreifen in der Tabelle.",
  fontDelta: 0,
  drawKopf(frame, input) {
    const { doc, theme, left, right, margins, primary, base } = frame;
    const barH = 54;
    doc.rect(0, 0, doc.page.width, margins.top + barH).fill(primary);
    if (theme.logoBuffer) {
      doc.image(theme.logoBuffer, left, (margins.top + barH - mm(12)) / 2, { height: mm(12) });
    } else {
      doc.font("Helvetica-Bold").fontSize(base + 6).fillColor("#fff").text(input.senderFallback.split(" · ")[0] ?? "", left, margins.top + 16);
    }
    doc.font("Helvetica-Bold").fontSize(base + 8).fillColor("#fff").text(input.title, left, margins.top + 14, { width: right - left, align: "right" });
    const top = margins.top + barH + 18;
    drawSenderLine(doc, theme, left, top, input.senderFallback);
    const buyerY = top + 18;
    const recipientBottom = drawRecipient(frame, input, buyerY, base + 1);
    const cardX = right - 210;
    const cardH = (input.meta.length + 1) * (base + 3) + 16;
    doc.roundedRect(cardX, buyerY - 8, 210, cardH, 4).fill("#f3f4f6");
    doc.fillColor("#000");
    const metaBottom = drawMetaTable(frame, [{ label: input.numberLabel, value: input.number }, ...input.meta], cardX + 8, buyerY, 194, base - 1);
    let y = Math.max(recipientBottom, metaBottom + 8, margins.top + 190) + 16;
    if (input.intro) {
      doc.font("Helvetica").fontSize(base).fillColor("#000").text(input.intro, left, y, { width: right - left });
      y = doc.y + 10;
    }
    return y;
  },
  table: { headerFill: "#f3f4f6", headerText: "#111", headerHeight: 18, rowRule: null, zebra: "#fafafa", boldTitle: true, textColor: "#000" },
  drawTotalsRule(frame, x, y) {
    frame.doc.moveTo(x, y).lineTo(frame.right, y).lineWidth(1.5).strokeColor(frame.primary).stroke().lineWidth(1);
  },
  drawFooter(frame, columns, y) {
    const { doc, primary } = frame;
    doc.rect(0, y - 8, doc.page.width, doc.page.height - y + 8).fill("#f3f4f6");
    doc.moveTo(frame.left, y - 8).lineTo(frame.right, y - 8).lineWidth(1).strokeColor(primary).stroke();
    drawFooterColumns(frame, columns, y, 7.5, "#333333");
  },
  footerHeight: 44,
};
```

Hinweis für `modern`: `drawBackground` (Hintergrundbild) zeichnet vor dem Kopf; der Balken überdeckt oben, das ist gewollt. Der Balken muss auch auf Folgeseiten stehen: `invoice-pdf.ts` ruft nach `doc.addPage()` `layout.drawPageChrome?.(frame)` auf — ergänze `drawPageChrome?(frame: LayoutFrame): void` optional im `PdfLayout`-Typ; `modern` implementiert es (nur Balken ohne Titel, Höhe 24) und `ensureSpace` startet Folgeseiten bei `margins.top + 30` statt `margins.top`, wenn `drawPageChrome` existiert (Rückgabewert `number` = neuer Start-y). Die anderen Layouts lassen es weg.

- [ ] **Step 5: Registry + Miniaturen**

Registry: `LAYOUTS` als `Record<LayoutId, PdfLayout>` mit `standard, schlicht, klassik, modern` (blau/schwarz/kompakt in Task 5 — bis dahin in Task 4 `Partial` belassen). Vier SVGs (120×170, `viewBox="0 0 120 170"`), rein schematisch: weiße Seite mit `#e5e7eb`-Rahmen, Logo-Platzhalter als Rechteck (standard/schlicht rechts oben, klassik links, modern als Balken oben in `#4f46e5`), Adressblock als 4 graue Linien links, Infoblock als 4 kurze Linien rechts, Tabellenkopf als Balken (standard `#1f2937`, modern `#f3f4f6`, klassik/schlicht Linie), 6 Zeilen, Summen rechts, Fußzeile als 3–4 Spalten (schlicht in `#4f46e5`). Datei je Layout mit `<title>` = Name.

- [ ] **Step 6: Tests, Commit**

Run: `npx vitest run test/unit/pdf-layouts.test.ts test/integration/pdf-theme.test.ts && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add src/lib/pdf/layouts public/layouts test/unit/pdf-layouts.test.ts test/helpers/pdf-fixtures.ts test/integration/pdf-theme.test.ts
git commit -s -m "feat(layouts): Layouts schlicht, klassik, modern mit Miniaturen (Phase 11b, Task 4)"
```

---

### Task 5: Layouts `blau`, `schwarz`, `kompakt`; vollständige Matrix

**Files:**
- Create: `src/lib/pdf/layouts/styled.ts`, `public/layouts/blau.svg`, `schwarz.svg`, `kompakt.svg`
- Modify: `src/lib/pdf/layouts/registry.ts`, `test/unit/pdf-layouts.test.ts` (MATRIX = alle sieben; Register-Assert auf volle Liste)

- [ ] **Step 1: Test erweitern** — `MATRIX` um `"blau", "schwarz", "kompakt"` ergänzen; `listLayouts()`-Assert auf die vollständige Reihenfolge. Run → FAIL (Register kennt sie nicht).

- [ ] **Step 2: Fabrik und drei Layouts**

```ts
// src/lib/pdf/layouts/styled.ts
import type { PdfLayout, TableStyle } from "./types";
import { standardLayout } from "./standard";
import { drawFooterColumns } from "./shared";

interface StyledOptions {
  id: PdfLayout["id"];
  name: string;
  description: string;
  accent: string; // ueberstimmt brand.primaryColor fuer Tabellenkopf/Linien
  table: Partial<TableStyle>;
  fontDelta?: number;
  footerColor?: string;
}

/** Varianten des Standard-Layouts mit eigener Akzentfarbe und Tabellenstil (blau, schwarz, kompakt). */
export function styledLayout(o: StyledOptions): PdfLayout {
  return {
    ...standardLayout,
    id: o.id,
    name: o.name,
    description: o.description,
    fontDelta: o.fontDelta ?? 0,
    table: { ...standardLayout.table, ...o.table },
    drawKopf(frame, input) {
      return standardLayout.drawKopf({ ...frame, primary: o.accent }, input);
    },
    drawTotalsRule(frame, x, y) {
      frame.doc.moveTo(x, y).lineTo(frame.right, y).lineWidth(1.2).strokeColor(o.accent).stroke().lineWidth(1);
    },
    drawFooter(frame, columns, y) {
      frame.doc.moveTo(frame.left, y - 6).lineTo(frame.right, y - 6).lineWidth(0.6).strokeColor(o.accent).stroke().lineWidth(1);
      drawFooterColumns(frame, columns, y, 7.5, o.footerColor ?? "#555555");
    },
  };
}

export const blauLayout = styledLayout({ id: "blau", name: "Blau", description: "Standard-Aufbau mit blauem Tabellenkopf und blauen Linien.", accent: "#1d4ed8", table: { headerFill: "#1d4ed8", headerText: "#fff", rowRule: "#dbeafe" } });
export const schwarzLayout = styledLayout({ id: "schwarz", name: "Schwarz", description: "Kontrastreich: schwarzer Tabellenkopf, schwarze Linien, graue Fußzeile.", accent: "#000000", table: { headerFill: "#000000", headerText: "#fff", rowRule: "#e5e7eb" }, footerColor: "#333333" });
export const kompaktLayout = styledLayout({ id: "kompakt", name: "Kompakt", description: "Kleinere Schrift und engere Zeilen für lange Positionslisten.", accent: "#374151", table: { headerFill: "#374151", headerText: "#fff", headerHeight: 14, rowRule: "#eeeeee" }, fontDelta: -1 });
```

`kompakt`: die Engine liest die Zeilenhöhe `h` aus `base + 7` (Standard 16 bei base 9? Achtung: heute `h = 16` bei Schrift 9) — definiere in der Engine `const rowH = Math.round((base - 1) * 1.8)` (ergibt 16 bei fontSizePt 10, 14 bei kompakt), und den Rabatt-/Langtext-Abstand proportional (`Math.round(rowH * 0.8)`).

- [ ] **Step 3: Registry vervollständigen** — `Record<LayoutId, PdfLayout>` mit allen sieben, `registerLayout` entfernen. Drei SVGs analog Task 4 (blau `#1d4ed8`-Kopf, schwarz `#000`-Kopf, kompakt 9 dünne Zeilen).

- [ ] **Step 4: Tests, Commit**

Run: `npx vitest run test/unit/pdf-layouts.test.ts test/unit && npm run typecheck && npm run lint` — Expected: PASS (7 Layouts × 2 Tests + Register).

```bash
git add src/lib/pdf/layouts public/layouts test/unit/pdf-layouts.test.ts
git commit -s -m "feat(layouts): blau, schwarz, kompakt; Layout-Matrix-Tests (Phase 11b, Task 5)"
```

---

### Task 6: Auflösung an allen Aufrufstellen, Einfrieren, Vorschau-Route

**Files:**
- Modify: `src/domain/settings/print.ts` (`freezePrintOptionsJson(global, existing, layoutId)`), `src/domain/invoice/finalize.ts` (Aufruf mit aufgelöstem Layout), alle `loadPdfTheme(...)`-Aufrufer (Liste im Kontext: invoices/documents/delivery-notes/dunnings/public angebot/v1 Invoice pdf, zugferd, `src/api/files.ts`, `src/domain/email/attachments.ts`, `src/mcp/tools/invoices.ts`) — jeweils `docType` übergeben, `src/domain/settings/preview.ts` (+ `DUNNING`, `CREDIT_NOTE`), `src/app/api/settings/branding/preview/route.ts` (`layoutId`, Zod)
- Test: `test/unit/layout-resolve.test.ts` (freeze), `test/integration/pdf-theme.test.ts` (Einfrieren bei Festschreibung), Routen-Test für die Vorschau in `test/integration/settings-routes.test.ts` (falls vorhanden, sonst neu `test/integration/branding-preview.test.ts`)

**Interfaces:**
- `freezePrintOptionsJson(global, existingOverrideJson, layoutId: LayoutId): string` — wie bisher, zusätzlich: fehlt `layoutId` im Override, wird der übergebene Wert ergänzt (auch wenn die zehn Schalter vollständig sind).
- `finalizeInvoice`: `const brand = await loadBrandingSettings(orgId); const layoutId = resolveLayoutId({ overrideLayoutId: effectivePrintOptions(global, invoice.printOptionsJson).layoutId ?? null, layoutByType: brand.layoutByType, orgDefault: brand.layoutId, docType: invoiceTypeToLayoutDocType(invoice.type) })`.
- Vorschau: `GET /api/settings/branding/preview?docType=INVOICE|CREDIT_NOTE|ANGEBOT|DELIVERY_NOTE|DUNNING&layoutId=<id>`; `layoutId` optional (Default = aufgelöstes Organisations-Layout für den Typ), unbekannt ⇒ 400 (Zod `z.object({ docType: z.enum(PREVIEW_DOC_TYPES).default("INVOICE"), layoutId: layoutIdSchema.optional() })`).

- [ ] **Step 1: Failing tests**

```ts
// test/unit/layout-resolve.test.ts — anhaengen
import { freezePrintOptionsJson, DEFAULT_PRINT_SETTINGS } from "@/domain/settings/print";
describe("freezePrintOptionsJson mit layoutId", () => {
  it("ergaenzt layoutId, wenn er fehlt — auch bei vollstaendigen Schaltern", () => {
    const full = JSON.stringify(DEFAULT_PRINT_SETTINGS);
    const frozen = JSON.parse(freezePrintOptionsJson(DEFAULT_PRINT_SETTINGS, full, "schlicht")) as { layoutId?: string };
    expect(frozen.layoutId).toBe("schlicht");
  });
  it("laesst einen vorhandenen layoutId unveraendert", () => {
    const existing = JSON.stringify({ ...DEFAULT_PRINT_SETTINGS, layoutId: "blau" });
    expect(freezePrintOptionsJson(DEFAULT_PRINT_SETTINGS, existing, "schlicht")).toBe(existing);
  });
});
```

```ts
// test/integration/pdf-theme.test.ts — anhaengen (Testjahr 2056 dieser Datei; Nummernkreis-Praefix "PT56-" setzen, falls noch nicht vorhanden)
it("Festschreiben friert das Layout ein; spaetere Organisationsaenderung wirkt nicht mehr", async () => {
  const orgId = await makeOrg();
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveBrandingSettings(orgId, { layoutId: "schlicht" });
  const customer = await dbInternal.customer.create({ data: { orgId, name: "Freeze AG", addressLine1: "A 1", postalCode: "1", city: "B", type: "BUSINESS" } });
  const draft = await createDraftInvoice(orgId, { ...invoiceInput(customer.id) });
  const fin = await finalizeInvoice(draft.id, { now: new Date("2056-06-01T12:00:00Z"), actor: "test" });
  expect(JSON.parse(fin.printOptionsJson!).layoutId).toBe("schlicht");
  await saveBrandingSettings(orgId, { layoutId: "modern" });
  const theme = await loadPdfTheme(orgId, fin.printOptionsJson, "INVOICE");
  expect(theme.layoutId).toBe("schlicht");
  const draft2 = await createDraftInvoice(orgId, { ...invoiceInput(customer.id) });
  const theme2 = await loadPdfTheme(orgId, draft2.printOptionsJson, "INVOICE");
  expect(theme2.layoutId).toBe("modern");
});
```

(`invoiceInput` aus `test/integration/scheduler.test.ts` übernehmen; `createDraftInvoice`/`finalizeInvoice` importieren; `finalizeInvoice` liefert die Zeile inkl. `printOptionsJson` — sonst per `dbInternal.invoice.findUnique` nachladen.)

Vorschau-Routentest:

```ts
it("Vorschau: layoutId-Parameter, 400 bei unbekanntem Layout, DUNNING-Vorschau rendert", async () => {
  const ok = await previewGet(new Request("http://localhost/api/settings/branding/preview?docType=INVOICE&layoutId=schlicht"));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("application/pdf");
  const bad = await previewGet(new Request("http://localhost/api/settings/branding/preview?layoutId=premium"));
  expect(bad.status).toBe(400);
  const du = await previewGet(new Request("http://localhost/api/settings/branding/preview?docType=DUNNING"));
  expect(du.status).toBe(200);
});
```

- [ ] **Step 2: Fehlschlag prüfen** — Run die drei Testdateien; Expected: FAIL (Signatur/Parameter fehlen).

- [ ] **Step 3: Implementieren**

`print.ts`:

```ts
export function freezePrintOptionsJson(global: PrintSettingsInput, existingOverrideJson: string | null | undefined, layoutId: LayoutId): string {
  let override: PrintOptionsOverride = {};
  if (existingOverrideJson) { /* wie bisher */ }
  const isComplete = PRINT_OPTION_KEYS.every((key) => key in override);
  if (isComplete && override.layoutId) return existingOverrideJson as string;
  const merged = { ...global, ...override, layoutId: override.layoutId ?? layoutId };
  return JSON.stringify(merged);
}
```

`finalize.ts` Zeilen 217–218: Branding laden, `resolveLayoutId` wie oben, `freezePrintOptionsJson(globalPrintSettings, invoice.printOptionsJson, layoutId)`.

Aufrufstellen: `loadPdfTheme(orgId, doc.printOptionsJson, <docType>)` mit `invoiceTypeToLayoutDocType(invoice.type)` (Rechnungen), `invoiceTypeToLayoutDocType(quote.kind)` (Dokumente, öffentlicher Angebotslink), `"DELIVERY_NOTE"`, `"DUNNING"`. `grep -rn "loadPdfTheme(" src/` muss danach überall drei Argumente zeigen (Ausnahme: Vorschau-Route mit explizitem Layout).

`preview.ts`: `PREVIEW_DOC_TYPES = ["INVOICE", "CREDIT_NOTE", "ANGEBOT", "DELIVERY_NOTE", "DUNNING"]`; `buildSampleInvoiceData(org, "CREDIT_NOTE")` setzt `type = "CREDIT_NOTE"` und negative Beträge gemäß Bestandskonvention (siehe `invoice-pdf.ts` Kommentar Zeile 316); `buildSampleDunningData(org): DunningPdfData` mit Level 1, offener Betrag 119,00 €, Zinsen 1,23 €, Pauschale 40 €. Vorschau-Route: Query per Zod parsen; `loadPdfTheme(org.id, null, docTypeToLayoutDocType)`, dann `theme.layoutId = query.layoutId ?? theme.layoutId`; Rendering nach Typ (INVOICE/CREDIT_NOTE/ANGEBOT → `renderInvoicePdf`, DELIVERY_NOTE, DUNNING). `cache-control: no-store`.

- [ ] **Step 4: Tests, Gate, Commit**

Run: `npx vitest run test/unit/layout-resolve.test.ts test/integration/pdf-theme.test.ts <preview-test> test/integration/gobd.test.ts test/integration/invoice-route.test.ts && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add src/domain src/app/api src/api src/mcp test
git commit -s -m "feat(layouts): Layout-Aufloesung an allen PDF-Pfaden, Einfrieren beim Festschreiben, Vorschau mit layoutId (Phase 11b, Task 6)"
```

---

### Task 7: Briefpapier-Seite mit drei Reitern, Layout-Galerie, Live-Vorschau, Editor-Auswahl

**Files:**
- Create: `src/components/settings/BriefpapierTabs.tsx`, `src/components/settings/LayoutGallery.tsx`
- Modify: `src/app/einstellungen/briefpapier/page.tsx`, `src/app/einstellungen/druckoptionen/page.tsx` (Redirect), `src/components/settings/BrandingForm.tsx` (Fußzeilenmodus-Umschalter AUTO/CUSTOM vor den drei Freitextfeldern; Vorschau-Link → Reiter Layouts), `src/components/SettingsTabs.tsx` + `src/lib/nav.ts` (Tabs aus `SETTINGS_ITEMS`, Eintrag `druckoptionen` entfernen, `/einstellungen/dokumente` mit dem Titel der Seite ergänzen — `grep -n "<h1\|PageHeader" src/app/einstellungen/dokumente/page.tsx`), `src/components/PrintOptionsPanel.tsx` (Select „Layout" mit „Organisationsstandard" + sieben Layouts, schreibt `layoutId` in den Override)
- Test: `test/unit/nav.test.ts` (SettingsTabs-Ableitung: `SETTINGS_ITEMS` enthält kein `/einstellungen/druckoptionen`), manueller Check + Playwright-Smoke im Abschluss-Review

**Interfaces:**
- `BriefpapierTabs({ active: "briefpapier"|"layouts"|"druckoptionen" })` rendert Reiter mit Links `?tab=…`.
- `LayoutGallery({ initial: BrandingSettingsInput; layouts: { id, name, description }[] })` (Client): Belegtyp-Select (`LAYOUT_DOC_TYPE_LABEL`), Kacheln (`/layouts/<id>.svg`, Name, Beschreibung, Badge „Standard" für die aktuell für den Typ wirksame Auswahl), rechts `<iframe src="/api/settings/branding/preview?docType=<mapped>&layoutId=<selected>">` (Mapping QUOTE→ANGEBOT, ORDER_CONFIRMATION/PROFORMA→ANGEBOT, sonst gleich), Buttons „Für <Typ> übernehmen" (setzt `layoutByType[typ]`) und „Als Standard für alle" (setzt `layoutId`, leert `layoutByType`), „Speichern" → `PUT /api/settings/branding` mit dem vollständigen Branding-Objekt (bestehender Vertrag), Erfolgs-/Fehlermeldung wie `BrandingForm`.

- [ ] **Step 1: Seite und Reiter**

```tsx
// src/app/einstellungen/briefpapier/page.tsx
import { redirect } from "next/navigation";
import { loadBrandingSettings } from "@/domain/settings/branding";
import { loadPrintSettings } from "@/domain/settings/print";
import { getActiveOrg } from "@/lib/org";
import { listLayouts } from "@/lib/pdf/layouts/registry";
import { SettingsTabs } from "@/components/SettingsTabs";
import { PageHeader } from "@/components/PageHeader";
import { BriefpapierTabs, type BriefpapierTab } from "@/components/settings/BriefpapierTabs";
import { BrandingForm } from "@/components/settings/BrandingForm";
import { LayoutGallery } from "@/components/settings/LayoutGallery";
import { PrintSettingsForm } from "@/components/settings/PrintSettingsForm";

export const dynamic = "force-dynamic";
const TABS: BriefpapierTab[] = ["briefpapier", "layouts", "druckoptionen"];

export default async function BriefpapierPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active: BriefpapierTab = TABS.includes(tab as BriefpapierTab) ? (tab as BriefpapierTab) : "briefpapier";
  if (tab && tab !== active) redirect("/einstellungen/briefpapier");
  const org = await getActiveOrg();
  const [branding, print] = await Promise.all([loadBrandingSettings(org.id), loadPrintSettings(org.id)]);
  return (
    <div className="space-y-6">
      <SettingsTabs active="briefpapier" />
      <PageHeader title="Briefpapier" subtitle="Layout, Logo, Farben und Druckoptionen für alle Belege." />
      <BriefpapierTabs active={active} />
      {active === "briefpapier" && <BrandingForm initial={branding} />}
      {active === "layouts" && <LayoutGallery initial={branding} layouts={listLayouts()} />}
      {active === "druckoptionen" && <PrintSettingsForm initial={print} />}
    </div>
  );
}
```

`druckoptionen/page.tsx` wird zu `export default function Page() { redirect("/einstellungen/briefpapier?tab=druckoptionen"); }`.

- [ ] **Step 2: LayoutGallery** — Client-Komponente mit `useState(initial)`, `docType` State (Default `INVOICE`), `selected = values.layoutByType[docType] ?? values.layoutId`; Grid `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, Kachel = `<button>` mit `<img src={`/layouts/${id}.svg`} alt="" className="w-full rounded border" />`, Name fett, Beschreibung `text-xs text-slate-500`, aktive Kachel `ring-2 ring-indigo-600` + Badge „Standard"; Klick setzt nur die lokale Auswahl (kein sofortiges Speichern — Ruling Spec). Vorschau rechts `aspect-[1/1.414] w-full` iframe mit `key={`${docType}-${selected}`}`. Speichern-Handler wie in `BrandingForm.save()` (PUT komplettes Objekt, `setSaved`). Fehlertexte aus der Antwort anzeigen.

- [ ] **Step 3: BrandingForm, SettingsTabs, PrintOptionsPanel**

`BrandingForm`: in der Sektion „Absenderzeile & Fußzeile" ein Radio „Fußzeile: automatisch aus den Stammdaten (vierspaltig) / eigene Texte (drei Spalten)" → `footerMode`; die drei Textfelder nur bei CUSTOM aktiv (`disabled` sonst). Vorschau-Link zeigt auf `?tab=layouts`.

`SettingsTabs.tsx`: `TABS` durch `SETTINGS_ITEMS.map((i) => ({ href: i.href, key: keyFromHref(i.href), label: i.label }))` ersetzen; `SettingsTabKey` als `(typeof SETTINGS_KEYS)[number]` aus einem in `nav.ts` exportierten `SETTINGS_KEYS`-Tupel (`"stammdaten" | "belege" | …`) — d. h. `SETTINGS_ITEMS` bekommt ein Feld `key`. `druckoptionen` entfernen, `dokumente` ergänzen (Label aus der Seite). Alle `<SettingsTabs active="druckoptionen">`-Vorkommen entfernen (`grep -rn 'active="druckoptionen"' src/`).

`PrintOptionsPanel.tsx`: oberhalb der Schalter ein `<select>` „Layout" mit Option „Organisationsstandard" (Wert leer ⇒ `layoutId` aus dem Override entfernen) und den sieben Layouts (`LAYOUT_IDS` + Namen aus `listLayouts()` — Namen als Prop vom Server übergeben oder `LAYOUT_NAME`-Konstante in `ids.ts` ergänzen: `export const LAYOUT_NAME: Record<LayoutId, string>`); Auswahl geht mit in den bestehenden `PUT .../print-options`-Body (`printOptionsOverrideSchema` kennt `layoutId` seit Task 1).

- [ ] **Step 4: Prüfen**

Run: `npm run typecheck && npm run lint && npm run build && npx vitest run test/unit/nav.test.ts`. Manuell (`npm run dev`, Login): `/einstellungen/briefpapier?tab=layouts` zeigt sieben Kacheln, Wechsel des Belegtyps ändert Badge und Vorschau, „Speichern" persistiert (Reload zeigt Auswahl), `/einstellungen/druckoptionen` leitet um, Rechnungsentwurf → Druckoptionen-Panel → Layout „Schlicht" → PDF der Rechnung zeigt das Schlicht-Layout.

- [ ] **Step 5: Commit**

```bash
git add src/app/einstellungen src/components src/lib/nav.ts src/lib/pdf/layouts/ids.ts test/unit/nav.test.ts
git commit -s -m "feat(layouts): Briefpapier-Seite mit Reitern, Layout-Galerie mit Live-Vorschau, Layout je Beleg (Phase 11b, Task 7)"
```

---

### Task 8: API v1 `Layout`, OpenAPI, MCP, Doku, Gesamtprüfung

**Files:**
- Create: `src/app/api/v1/Layout/route.ts`, `src/api/serializers/layout.ts`
- Modify: `src/api/openapi.ts` (`Layout: layoutSchema`), `openapi/openapi.json` (regenerieren), `src/mcp/tools/settings.ts` (`list_pdf_layouts`; Beschreibung von `set_print_options` um `layoutId`), `README.md` (Abschnitt „PDF layouts" unter „Features"), `docs/LIMITATIONEN.md` (Abschnitt Phase 7 → Nachtrag 11b), `docs/COMPLIANCE.md` (Hinweis Darstellung ≠ Inhalt, Einfrieren), `docs/ARCHITEKTUR.md` (Unterabschnitt „PDF-Layouts (Phase 11b)"), `docs/api/*.md` falls vorhanden (`ls docs/api`)
- Test: `test/integration/api-resources.test.ts` (bestehende v1-Tests, Muster übernehmen) oder neu `test/integration/api-layout.test.ts`; `test/integration/mcp-settings.test.ts`

**Interfaces:**
- `GET /api/v1/Layout` (scope `read`): `{ data: [{ objectName: "Layout", id, name, description, thumbnailUrl: "/layouts/<id>.svg" }], meta }` über `apiList` ohne Paginierung (alle sieben; `apiList(rows, { total: 7, limit: 7, offset: 0 })` — Signatur in `src/api/response.ts` prüfen).
- MCP `list_pdf_layouts` (ohne Input) → JSON-Liste wie oben; `get_settings {area:"branding"}` liefert `layoutId`, `layoutByType`, `footerMode` automatisch (Schema-Erweiterung aus Task 1); `update_branding_settings` akzeptiert sie automatisch (`.partial()` des Schemas) — im Test prüfen.

- [ ] **Step 1: Failing tests**

```ts
// test/integration/api-layout.test.ts (Muster: vorhandene api-*.test.ts fuer API-Key/withApi-Setup uebernehmen)
it("GET /api/v1/Layout listet sieben Layouts", async () => {
  const res = await layoutGet(authedRequest("http://localhost/api/v1/Layout"));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { id: string; objectName: string; thumbnailUrl: string }[] };
  expect(json.data.map((l) => l.id)).toEqual(["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"]);
  expect(json.data[0]!.objectName).toBe("Layout");
  expect(json.data[1]!.thumbnailUrl).toBe("/layouts/schlicht.svg");
});
```

```ts
// test/integration/mcp-settings.test.ts — anhaengen
it("list_pdf_layouts und Branding-Layoutfelder ueber MCP", async () => {
  const list = JSON.parse(text(await callTool("list_pdf_layouts", {}))) as { id: string }[];
  expect(list.map((l) => l.id)).toContain("schlicht");
  await callTool("update_branding_settings", { layoutId: "schlicht", layoutByType: { DUNNING: "kompakt" }, footerMode: "CUSTOM" });
  const branding = JSON.parse(text(await callTool("get_settings", { area: "branding" }))) as { layoutId: string; layoutByType: Record<string, string>; footerMode: string };
  expect(branding.layoutId).toBe("schlicht");
  expect(branding.layoutByType).toEqual({ DUNNING: "kompakt" });
  expect(branding.footerMode).toBe("CUSTOM");
  const bad = await callTool("update_branding_settings", { layoutId: "premium" });
  expect(bad.isError).toBe(true);
});
```

- [ ] **Step 2: Fehlschlag prüfen** — Run beide Dateien; Expected: FAIL (Route/Tool fehlen).

- [ ] **Step 3: Implementieren**

```ts
// src/api/serializers/layout.ts
import "../openapi-zod-init";
import { z } from "zod";
import { LAYOUT_IDS, type LayoutId } from "@/lib/pdf/layouts/ids";

export function serializeLayout(l: { id: LayoutId; name: string; description: string }) {
  return { objectName: "Layout" as const, id: l.id, name: l.name, description: l.description, thumbnailUrl: `/layouts/${l.id}.svg` };
}

export const layoutSchema = z.object({
  objectName: z.literal("Layout"),
  id: z.enum(LAYOUT_IDS),
  name: z.string(),
  description: z.string(),
  thumbnailUrl: z.string(),
});
```

```ts
// src/app/api/v1/Layout/route.ts
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeLayout } from "@/api/serializers/layout";
import { listLayouts } from "@/lib/pdf/layouts/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Phase 11b — feste Liste der PDF-Layouts (keine Paginierung, sieben Eintraege). */
export const GET = withApi(async () => {
  const rows = listLayouts().map(serializeLayout);
  return apiList(rows, { total: rows.length, limit: rows.length, offset: 0 });
}, { scope: "read" });

export const spec = {
  list: { path: "/api/v1/Layout", method: "GET", summary: "PDF-Layouts auflisten", scope: "read", response: apiListResponseSchema(z.unknown()), errors: [401, 403, 429] },
} satisfies Record<string, RouteSpec>;
```

(`apiList`-Signatur und `RouteSpec`-Form gegen `src/api/response.ts`/`src/api/spec.ts` und `Product/route.ts` abgleichen; `response: apiListResponseSchema(layoutSchema)` verwenden, wenn `openapi.ts` typisierte Ressourcen über `RAW_TO_RESOURCE_NAME` erkennt — dazu `Layout: layoutSchema` in `RESOURCE_SCHEMAS` eintragen.) Dann `npm run api:check -- --write` und die Änderung an `openapi/openapi.json` prüfen (nur `Layout`-Pfad + Branding-Felder).

MCP in `registerSettingsTools`:

```ts
  server.registerTool(
    "list_pdf_layouts",
    { title: "PDF-Layouts auflisten", description: "Liste der waehlbaren PDF-Layouts (id, name, description). Auswahl je Belegtyp ueber update_branding_settings {layoutId, layoutByType}, je Beleg ueber set_print_options {options: {layoutId}}.", inputSchema: {} },
    async (): Promise<Result> => ctx.ok(JSON.stringify(listLayouts(), null, 2)),
  );
```

`set_print_options`-Beschreibung um `layoutId` ergänzen (Schema kommt aus `printOptionsOverrideSchema`).

- [ ] **Step 4: Doku**

README (Features, Englisch): „**PDF layouts** — seven built-in layouts (Standard, Schlicht, Klassik, Modern, Blau, Schwarz, Kompakt), selectable per document type under Settings → Letterhead → Layouts with live preview, overridable per draft document. The layout is frozen when an invoice is finalized. Footer is generated from company master data (four columns) or from three custom text fields." LIMITATIONEN (Abschnitt Phase 7, Nachtrag): feste Layoutliste ohne Baukasten; Mahnungen ohne Beleg-Override (nur Typ-/Organisationslayout); Schriften nur pdfkit-Standard (Helvetica); Hintergrundbild wird bei `modern` vom Kopfbalken überdeckt. COMPLIANCE: Absatz „PDF-Layouts sind Darstellung: der festgeschriebene Beleginhalt bleibt unverändert; die Layout-Kennung wird beim Festschreiben in den Druckoptionen eingefroren (Nachvollziehbarkeit des Reprints)". ARCHITEKTUR: Unterabschnitt mit Engine/Layout-Hook-Beschreibung, Auflösungsreihenfolge, Dateien.

- [ ] **Step 5: Gesamtprüfung und Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check
git add src/app/api/v1/Layout src/api src/mcp openapi README.md docs test
git commit -s -m "feat(layouts): API v1 Layout, MCP list_pdf_layouts, OpenAPI, Doku (Phase 11b, Task 8)"
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. `standard`-Layout: Text der bestehenden PDF-Tests unverändert; Geometrie des Tabellenkopfs identisch.
2. Einfrieren: festgeschriebene Rechnung behält Layout bei Organisationsänderung; Entwurf folgt ihr.
3. Kein Layout druckt interne Notizen; Fußzeile AUTO enthält nur Stammdaten.
4. Migrationen SQLite + Postgres additiv, Schemadateien deckungsgleich (`schema-drift`), `postgres-migrations`-CI grün nach Push.
5. Zod an Vorschau-Route, Branding-PUT, API v1 PATCH Settings, MCP: unbekannte Layout-Id ⇒ 400/Fehler.
6. ZUGFeRD-Route rendert mit Layout; `validate:erechnung` grün.
7. Galerie: Speichern explizit (kein Sofortumschalten), Badge zeigt die für den Typ wirksame Auswahl, Vorschau wechselt mit Typ und Layout.
8. Visuelle Abnahme durch den Betreiber: `schlicht` gegen AN-1094/RE-41362 (Logo rechts, Infoblock, fette Titel, vierspaltige farbige Fußzeile, GiroCode unter der Summe) — Screenshots der Vorschau für Rechnung und Angebot als Dateien ablegen (`SendUserFile`), nicht nur beschreiben.
9. Playwright-Smoke: Login → Einstellungen → Briefpapier → Layouts → Schlicht für Rechnung übernehmen → Speichern → Rechnungsentwurf öffnen → PDF-Vorschau zeigt Schlicht → Festschreiben → Organisation auf Modern → PDF der festgeschriebenen Rechnung bleibt Schlicht.
