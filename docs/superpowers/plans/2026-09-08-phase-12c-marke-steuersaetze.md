# Phase 12c — Marke (White-Label) und org-eigene Steuersätze

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zwei Betreiberwünsche aus dem Phase-12-Auftrag: (1) „Man soll den Namen OpenInvoice Germany in den Einstellungen überschreiben können durch eigenen Namen mit Favicon" — ein neuer Einstellungen-Reiter „Marke" ersetzt Produktname, Kurzname, Favicon und Sidebar-Logo, während die AGPL-Herkunftszeile fest in beiden App-Hüllen bleibt. (2) „Steuersätze sollte man in Einstellungen ändern können" — eine org-eigene Liste ganzzahliger Prozentsätze (Default `[19,7,0]`) ersetzt die fest verdrahtete Union `19|7|0` in Zod, Editor, MCP und API; bereits ausgestellte Belege behalten ihren Satz.

**Architecture:** Vier voneinander unabhängige Eingriffe. (1) `BrandingSettings` bekommt vier nullable Spalten — `null` bedeutet überall „heutiger Wert", es gibt keine Datenmigration. (2) Der Upload-Endpunkt kennt zwei neue `kind`-Werte; ausgeliefert wird über zwei **öffentliche** GET-Routen, weil Login-Seite und `<link rel=icon>` vor der Session greifen. (3) Name/Kurzname/Logo wandern als Server-Props durch die bestehende Hüllenkette (`RootLayout → AppShell → Sidebar/Topbar`, `RootLayout → SlimShell`) — kein neuer Query je Komponente, kein React-Kontext. (4) `TaxRate` wird von einer Literal-Union zu `z.number().int().min(0).max(100)` gelockert; die Durchsetzung passiert **ausschließlich** in einer neuen Domain-Funktion `assertAllowedTaxRates`, die in den `…WithinTx`-Kernfunktionen sitzt (dort laufen UI, API und MCP zusammen) — kein Bypass über Route oder Formular.

**Tech Stack:** Next.js App Router (Server-Komponenten), Tailwind v4 (CSS-first), Prisma (SQLite + Postgres, keine Enums), Zod, Vitest (`environment: "node"`, **kein RTL** ⇒ keine Komponententests), Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-08-phase-12-feinschliff-design.md` — Pakete **C** und **D** (Abschnitt 2: „Marke: Felder/Upload/Metadaten/AGPL-Zeile/Ort", „Steuersätze: Speicher/Lockerung/Durchsetzung/UI"), Struktur Abschnitt 3 Blöcke C+D, Tests Abschnitt 4 C+D, Teilphase 3 in Abschnitt 5, Ruling am Dateiende („Steuersätze ganzzahlig 0–100 %").

## Global Constraints

- Branch `phase-12c/marke-steuersaetze` aus Fork-`main` (nach dem Merge von 12b). Jeder Commit mit `git commit -s`.
- **Keine neue Abhängigkeit**, keine Binärdatei im Repository (`find . -name "*.png" -not -path "./node_modules/*"` ist leer; `src/app/favicon.ico` ist die einzige Bilddatei und bleibt der Fallback).
- **GoBD (§51):** Steuersatz-Listen wirken nur auf neue/geänderte **Entwürfe**. Ein festgeschriebener Beleg behält seinen Satz, auch wenn die Organisation ihn später aus der Liste nimmt — abgebildet über den `existing`-Parameter von `assertAllowedTaxRates`. Kein Guard in `src/lib/db.ts` wird umgangen; `saveBrandingSettings`/`saveDocumentSettings` schreiben nur Organisationseinstellungen.
- **AGPL (§13 COMPLIANCE.md):** Die Zeile „powered by OpenInvoice Germany · AGPL-3.0 · Quellcode" ist in `AppShell` und `SlimShell` fest verdrahtet und hat **keinen** Schalter. `src/api/openapi.ts:459`, `src/app/api/docs/route.ts:23`, `src/mcp/server.ts:3` und die Marketing-Seite `src/app/page.tsx:40` bleiben unverändert (Protokoll-Identität + `openapi.json`-Drift-Check).
- **Zod an jeder Grenze (§50):** `appName`/`appShortName`/`faviconPath`/`appLogoPath` nur über `brandingSettingsInputSchema`; `taxRates` nur über `documentSettingsInputSchema`; `assertAllowedTaxRates` ist eine Domain-Funktion, keine UI-Prüfung.
- TypeScript strict, kein `any`. Dateien ≤ ~250 Zeilen. Deutsche UI-Texte mit echten Umlauten.
- **Nichts doppelt bauen (§1.4):** `BrandingForm`, `DocumentSettingsForm`, `SettingsTabs` (leitet aus `SETTINGS_ITEMS` ab), `storeFile`/`readFile`, `loadBrandingSettings`, `partialInputShape` werden erweitert, nicht kopiert.
- **Migrationen (§53):** zwei Paare `prisma/migrations/…` **und** `prisma/migrations-postgres/…`; beide Schemadateien gepflegt (CI `schema-drift`); `scripts/test-postgres-migrations.sh` bekommt zwei neue Fälle **und** beide neuen Migrationen in die Ausschluss-Regex von Fall 9 (Zeile 243) — sie ändern `BrandingSettings`/`DocumentSettings`, zwei Phase-7-Tabellen, die dort noch nicht existieren (sonst P1014). Anwenden mit `npx prisma migrate deploy` (nicht `npm run db:migrate` — interaktiv). **Keine neue Tabelle** ⇒ die Tabellenzahl bleibt 43.
- Prüfkette vor jedem Commit **im Vordergrund**: `npm run typecheck && npm run lint && TZ=UTC npm test`. Vor dem letzten Commit zusätzlich `npm run build`, `npm run validate:erechnung`, `npm run api:check`. Alle Bestandstests bleiben grün (§1.7).

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `prisma/schema.prisma`, `prisma/schema.postgres.prisma` | `BrandingSettings` +4 (`appName`, `appShortName`, `faviconPath`, `appLogoPath`), `DocumentSettings.taxRatesJson` |
| `prisma/migrations{,-postgres}/…_phase12c_branding_marke/migration.sql` | DDL Marke |
| `prisma/migrations{,-postgres}/…_phase12c_tax_rates/migration.sql` | DDL Steuersätze |
| `src/schemas/settings.ts` | `appName`/`appShortName`/`faviconPath`/`appLogoPath` in `brandingSettingsInputSchema` |
| `src/schemas/quote-share.ts` | `taxRatesSchema`, `taxRates` in `documentSettingsInputSchema`, `normalizeTaxRates` |
| `src/schemas/index.ts` | `TaxRate` → `z.number().int().min(0).max(100)` |
| `src/domain/settings/branding.ts` | vier neue Felder in `loadBrandingSettings`/`saveBrandingSettings` |
| `src/domain/document/settings.ts` | `taxRatesJson` ⇄ `taxRates` (Muster: `layoutByTypeJson` in branding.ts) |
| `src/domain/settings/brand.ts` | neu — `loadBrand(orgId)`: aufgelöster Marken-Datensatz für die Hüllen |
| `src/domain/settings/tax-rates.ts` | neu — `assertAllowedTaxRates`, `TaxRateNotAllowedError`, `ratesOfLines` |
| `src/lib/images/png-size.ts` | neu — `pngSize(buffer)` (IHDR-Lesen, keine Abhängigkeit) |
| `src/app/api/settings/branding/upload/route.ts` | `kind` += `favicon`/`applogo`, eigene Limits, Quadrat-Prüfung |
| `src/app/api/branding/icon/route.ts`, `.../appLogo/route.ts` | neu, **öffentlich** — Auslieferung mit Fallback |
| `src/proxy.ts` | `PUBLIC_PREFIXES` += `/api/branding` |
| `src/app/layout.tsx` | `metadata` → `generateMetadata()`, Marken-Props an beide Hüllen |
| `src/components/shell/{AppShell,Sidebar,Topbar,SlimShell}.tsx` | `brand`-Prop statt Literalen, AGPL-Zeile |
| `src/components/AuthForm.tsx` | `appName`-Prop statt „OpenInvoice-Instanz" |
| `src/domain/email/settings.ts`, `src/domain/webhook/actions.ts`, `src/domain/notifications/job.ts` | Betreff/Text aus `appName` |
| `src/lib/nav.ts` | `SETTINGS_KEYS`/`SETTINGS_ITEMS` += `marke` |
| `src/app/einstellungen/marke/page.tsx`, `src/components/settings/MarkeForm.tsx` | neuer Reiter |
| `src/lib/editor/constants.ts` | `TAX_RATE_OPTIONS` → `taxRateOptions(rates)` |
| `src/lib/editor/draft.ts` | `DraftLine.taxRate: number`, `narrowTaxRate` → `clampTaxRate(n, allowed)` |
| `src/components/editor/{DocumentEditor,blocks/LineItemsEditor,blocks/LineRow,blocks/RecipientBlock,NewProductDialog}.tsx` | `taxRates`-Prop bis in die Zeile |
| `src/app/{rechnungen/neu,rechnungen/[id]/bearbeiten,dokumente/neu,dokumente/[id]/bearbeiten,lieferscheine/neu}/page.tsx` | `taxRates` als Server-Prop |
| `src/domain/{invoice/create,invoice/update,document/create,document/update,document/convert,document/duplicate,delivery-note/create,recurring/create,recurring/update,product/save}.ts`, `src/domain/invoice/{partial,downpayment,final}.ts` | `assertAllowedTaxRates` bzw. `inheritedTaxRates` |
| `src/components/settings/TaxRatesField.tsx`, `src/components/forms/DocumentSettingsForm.tsx`, `src/app/actions/document-settings.ts` | Abschnitt „Steuersätze" |
| `src/mcp/tools/{context,invoices,products,settings}.ts` | Lockerung + Beschreibungen |
| `scripts/test-postgres-migrations.sh` | Fall-9-Regex, Fälle 18 + 19 |
| `openapi/openapi.json` | regeneriert (`taxRates`, Marken-Felder in `/api/v1/Settings`) |
| `docs/{ANLEITUNG,LIMITATIONEN,ARCHITEKTUR,MCP,API}.md`, `COMPLIANCE.md` | Doku |

---

### Task 1: Marke — Datenmodell, Zod, Domain, Postgres-Fall

**Files:**
- Modify: `prisma/schema.prisma:971-995` (`model BrandingSettings`) + `prisma/schema.postgres.prisma` (gleiche Stelle), `src/schemas/settings.ts:87-109`, `src/domain/settings/branding.ts:19-49`, `scripts/test-postgres-migrations.sh:243` + Dateiende
- Create: `prisma/migrations/20260910090000_phase12c_branding_marke/migration.sql`, `prisma/migrations-postgres/20260910090100_phase12c_branding_marke/migration.sql`, `src/domain/settings/brand.ts`, `test/unit/brand-schemas.test.ts`

**Befund (verifiziert):** `BrandingSettings` (Zeilen 971–995) hat heute 18 Spalten und keine Marken-Felder; `loadBrandingSettings` listet jedes Feld einzeln auf (kein Spread), `saveBrandingSettings` zieht `layoutByType` heraus und schreibt `layoutByTypeJson` — dasselbe Muster brauchen die neuen Felder **nicht** (reine Strings). `DEFAULT_BRANDING_SETTINGS = brandingSettingsInputSchema.parse({})` ist die Selbstheilung ohne DB-Zeile.

**Interfaces:**
```ts
// src/schemas/settings.ts (in brandingSettingsInputSchema)
appName: z.string().trim().min(1).max(40).nullable().default(null),
appShortName: z.string().trim().min(1).max(12).nullable().default(null),
faviconPath: z.string().nullable().default(null),
appLogoPath: z.string().nullable().default(null),

// src/domain/settings/brand.ts
export const DEFAULT_APP_NAME = "OpenInvoice Germany";
export const DEFAULT_APP_SHORT_NAME = "OI";
export const SOURCE_URL = process.env.SOURCE_URL ?? "https://github.com/automationsmanufaktur-labs/open-invoice-germany";
export interface Brand { appName: string; appShortName: string; hasAppLogo: boolean }
export function resolveBrand(b: Pick<BrandingSettingsInput, "appName" | "appShortName" | "appLogoPath">): Brand;
export async function loadBrand(orgId: string): Promise<Brand>;
export const DEFAULT_BRAND: Brand;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/brand-schemas.test.ts
/** Phase 12c, Task 1 — Marken-Felder in brandingSettingsInputSchema + resolveBrand. */
import { describe, it, expect } from "vitest";
import { brandingSettingsInputSchema as S } from "@/schemas/settings";
import { resolveBrand, DEFAULT_APP_NAME, DEFAULT_APP_SHORT_NAME, DEFAULT_BRAND } from "@/domain/settings/brand";

describe("Marken-Felder (Phase 12c)", () => {
  it("Default ist ueberall null — ohne Eintrag gilt der Produktname", () => {
    expect(S.parse({})).toMatchObject({ appName: null, appShortName: null, faviconPath: null, appLogoPath: null });
  });

  it("appName getrimmt 1..40, appShortName 1..12", () => {
    expect(S.parse({ appName: "  Muster Rechnungen  " }).appName).toBe("Muster Rechnungen");
    expect(S.parse({ appShortName: "MR" }).appShortName).toBe("MR");
    for (const bad of [{ appName: "a".repeat(41) }, { appName: "   " }, { appShortName: "a".repeat(13) }]) {
      expect(S.safeParse(bad).success).toBe(false);
    }
  });

  it("resolveBrand faellt auf die Produktnamen zurueck", () => {
    expect(resolveBrand({ appName: null, appShortName: null, appLogoPath: null })).toEqual({
      appName: DEFAULT_APP_NAME, appShortName: DEFAULT_APP_SHORT_NAME, hasAppLogo: false,
    });
    expect(DEFAULT_BRAND.appName).toBe(DEFAULT_APP_NAME);
    expect(resolveBrand({ appName: "Muster", appShortName: "MU", appLogoPath: "org/ab/cd" })).toEqual({
      appName: "Muster", appShortName: "MU", hasAppLogo: true,
    });
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/brand-schemas.test.ts`.

- [ ] **Step 3: Prisma + beide Migrationen**

In **beiden** Schemadateien in `model BrandingSettings` nach `footerMode`:
```prisma
  /// Phase 12c — White-Label. NULL bedeutet ueberall "Produktvorgabe" (appName
  /// "OpenInvoice Germany", appShortName "OI", src/app/favicon.ico, kein Sidebar-Logo).
  /// Die AGPL-Herkunftszeile in AppShell/SlimShell ist davon NICHT betroffen (§13 AGPL).
  appName          String?
  appShortName     String?
  faviconPath      String?
  appLogoPath      String?
```
Beide `migration.sql` (SQLite und Postgres, inhaltsgleich):
```sql
-- Phase 12c — White-Label: eigener Produktname, Kurzname, Favicon, Sidebar-Logo.
-- Additiv, alle vier NULL-bar; NULL = heutiges Verhalten, keine Datenmigration noetig.
-- AlterTable
ALTER TABLE "BrandingSettings" ADD COLUMN "appName" TEXT;
ALTER TABLE "BrandingSettings" ADD COLUMN "appShortName" TEXT;
ALTER TABLE "BrandingSettings" ADD COLUMN "faviconPath" TEXT;
ALTER TABLE "BrandingSettings" ADD COLUMN "appLogoPath" TEXT;
```
Anwenden: `npx prisma migrate deploy`, danach `npx prisma generate`.

- [ ] **Step 4: Zod + Domain**
  - `src/schemas/settings.ts`: die vier Felder aus „Interfaces" ans Ende von `brandingSettingsInputSchema` (vor der schließenden Klammer), mit dem Kommentar „Phase 12c — White-Label; null = Produktvorgabe".
  - `src/domain/settings/branding.ts`: in `loadBrandingSettings` die vier Zeilen `appName: row.appName,` … ergänzen (die Funktion listet jedes Feld einzeln auf). `saveBrandingSettings` braucht **keine** Änderung (`...rest` deckt sie ab).
  - Neu `src/domain/settings/brand.ts`:

```ts
/**
 * Aufgeloeste Markenangaben fuer die App-Huellen (Phase 12c). NULL-Felder in
 * BrandingSettings bedeuten "Produktvorgabe" — diese Datei ist die EINZIGE Stelle, an der
 * die Vorgabewerte stehen. Die AGPL-Herkunftszeile ist bewusst NICHT Teil von `Brand`:
 * sie ist in AppShell/SlimShell fest verdrahtet und durch keine Einstellung abschaltbar
 * (§13 AGPL, COMPLIANCE.md).
 */
import { loadBrandingSettings } from "@/domain/settings/branding";
import type { BrandingSettingsInput } from "@/schemas/settings";

export const DEFAULT_APP_NAME = "OpenInvoice Germany";
export const DEFAULT_APP_SHORT_NAME = "OI";

/** Quellcode-Link der AGPL-Zeile. Ein Fork darf hier seine eigene Quelle eintragen — die
 *  Herkunftsangabe selbst bleibt (AGPL §13: Zugang zum Quellcode, nicht Namensverzicht). */
export const SOURCE_URL = process.env.SOURCE_URL ?? "https://github.com/automationsmanufaktur-labs/open-invoice-germany";

export interface Brand {
  appName: string;
  appShortName: string;
  hasAppLogo: boolean;
}

export const DEFAULT_BRAND: Brand = { appName: DEFAULT_APP_NAME, appShortName: DEFAULT_APP_SHORT_NAME, hasAppLogo: false };

export function resolveBrand(b: Pick<BrandingSettingsInput, "appName" | "appShortName" | "appLogoPath">): Brand {
  return {
    appName: b.appName ?? DEFAULT_APP_NAME,
    appShortName: b.appShortName ?? DEFAULT_APP_SHORT_NAME,
    hasAppLogo: Boolean(b.appLogoPath),
  };
}

/** Laedt die Marke einer Organisation; ohne gespeicherte Zeile gelten die Produktvorgaben. */
export async function loadBrand(orgId: string): Promise<Brand> {
  return resolveBrand(await loadBrandingSettings(orgId));
}
```

- [ ] **Step 5: Postgres-Fall 18 und Fall-9-Regex**
  1. `scripts/test-postgres-migrations.sh:243`: die neue Migration in die Ausschluss-Regex aufnehmen (sie ändert `BrandingSettings`, eine Phase-7-Tabelle, die in Fall 9 noch nicht existiert):
     ```sh
     for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260904044136_phase7_settings|20260904140030_phase8b_fixwave|20260907075900_phase11b_layouts|20260907090333_phase11b_footermode_backfill|20260908090100_phase12a_giro_size|20260910090100_phase12c_branding_marke)$' | sort); do
     ```
     Den Kommentar darüber um einen Satz zu Phase 12c ergänzen.
  2. Neuer **Fall 18** am Dateiende (vor `echo "ALLE TESTS BESTANDEN"`), Muster von Fall 16: alle Migrationen außer `20260910090100_phase12c_branding_marke` einzeln einspielen, `org18` + `BrandingSettings`-Zeile `bs18` anlegen, `npx prisma migrate deploy`, dann prüfen:
     ```sh
     echo "==> Fall 18 (Phase 12c): Marken-Spalten NULL auf Bestandszeile"
     APPNAME=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select coalesce(\"appName\",'<null>') from \"BrandingSettings\" where id='bs18'")
     [ "$APPNAME" = "<null>" ] || fail "Bestandszeile bs18: appName ist '$APPNAME', erwartet NULL"
     MARKECOLS=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
       "select count(*) from information_schema.columns where table_name='BrandingSettings' and column_name in ('appName','appShortName','faviconPath','appLogoPath')")
     [ "$MARKECOLS" = "4" ] || fail "erwartet 4 Marken-Spalten auf BrandingSettings, gefunden $MARKECOLS"
     COUNT18=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
       "select count(*) from information_schema.tables where table_schema='public'")
     [ "$COUNT18" = "43" ] || fail "erwartet weiterhin 43 Tabellen nach Phase 12c/Marke (nur Spalten), gefunden $COUNT18"
     echo "    ok — vier Marken-Spalten NULL-bar, Bestandszeile unveraendert, 43 Tabellen"
     ```

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run api:check`
`api:check` schlägt an (Marken-Felder stecken über `brandingSettingsInputSchema` in `/api/v1/Settings`) ⇒ `npm run api:check -- --write`, `openapi/openapi.json` mitcommitten, dann erneut prüfen (grün).
```bash
git add prisma src/schemas/settings.ts src/domain/settings scripts/test-postgres-migrations.sh openapi/openapi.json test/unit/brand-schemas.test.ts
git commit -s -m "feat(marke): BrandingSettings um appName/appShortName/faviconPath/appLogoPath erweitert (Phase 12c, Task 1)"
```

---

### Task 2: Favicon-/Logo-Upload und öffentliche Auslieferung

**Files:**
- Modify: `src/app/api/settings/branding/upload/route.ts:9-14,20-32,52-68,83-97`, `src/proxy.ts:22`, `test/unit/proxy-public.test.ts:11` (exakte Listenprüfung)
- Create: `src/lib/images/png-size.ts`, `src/app/api/branding/icon/route.ts`, `src/app/api/branding/appLogo/route.ts`, `test/unit/png-size.test.ts`, `test/integration/branding-assets.test.ts`

**Befund (verifiziert):** Der Upload-Endpunkt prüft `kind` per `z.enum(["logo","background"])`, das Größenlimit über `KIND_LIMITS_BYTES`, den MIME-Typ manuell auf `image/png`/`image/jpeg` und legt die Datei über `storeFile(orgId, buffer, mime, filename)` (SHA-256-Pfad unter `ATTACHMENTS_DIR`) ab; in `BrandingSettings` landet nur der Pfad. `readFile(storagePath)` (`src/lib/attachments/storage.ts:100`) ist die Gegenrichtung. `PUBLIC_PREFIXES` (`src/proxy.ts:22`) wird von `matchesPublicPrefix` exakt-oder-mit-Slash geprüft.

**Ruling (Ergänzung zur Spec):** Die Spec verlangt für das Favicon „quadratisch 32–512 px". Dafür genügt der PNG-IHDR-Kopf (Breite/Höhe in Byte 16–23) — eine eigene Mini-Funktion `pngSize` ohne neue Abhängigkeit. **JPEG-Favicons werden abgelehnt** (400 mit Begründung): die Größe eines JPEG steckt im SOF-Marker, dessen Parsen für einen Randfall keine 40 Zeilen wert ist, und ein Favicon als JPEG ist ohnehin unüblich. `applogo` bleibt PNG **und** JPEG.

**Interfaces:**
```ts
// src/lib/images/png-size.ts
export function pngSize(buf: Buffer): { width: number; height: number } | null;
// upload/route.ts
const kindSchema = z.enum(["logo", "background", "favicon", "applogo"]);
const KIND_LIMITS_BYTES: Record<z.infer<typeof kindSchema>, number>;
const KIND_FIELD: Record<z.infer<typeof kindSchema>, "logoPath" | "backgroundPath" | "faviconPath" | "appLogoPath">;
```

- [ ] **Step 1: Failing tests schreiben**

```ts
// test/unit/png-size.test.ts
/** Phase 12c, Task 2 — PNG-Kopf lesen (IHDR), ohne neue Abhaengigkeit. */
import { describe, it, expect } from "vitest";
import { pngSize } from "@/lib/images/png-size";
import { testPngBuffer } from "../helpers/pdf-theme";

describe("pngSize", () => {
  it("liest Breite und Hoehe aus dem IHDR", () => {
    expect(pngSize(testPngBuffer(64, 64))).toEqual({ width: 64, height: 64 });
    expect(pngSize(testPngBuffer(120, 40))).toEqual({ width: 120, height: 40 });
  });
  it("liefert null fuer Nicht-PNG oder zu kurze Puffer", () => {
    expect(pngSize(Buffer.from("nicht png"))).toBeNull();
    expect(pngSize(Buffer.alloc(8))).toBeNull();
  });
});
```

```ts
// test/integration/branding-assets.test.ts
/**
 * Phase 12c, Task 2 — Upload-Validierung (favicon/applogo) und die beiden OEFFENTLICHEN
 * Auslieferungsrouten. Eigenes Jahr 2079 (Testjahr-Konvention) — kein Rechnungsbezug.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { testPngBuffer } from "../helpers/pdf-theme";
import { POST } from "@/app/api/settings/branding/upload/route";
import { GET as iconGet } from "@/app/api/branding/icon/route";
import { GET as logoGet } from "@/app/api/branding/appLogo/route";
import { PUBLIC_PREFIXES } from "@/proxy";

let orgId: string;
vi.mock("@/lib/org", () => ({ getActiveOrg: () => Promise.resolve({ id: orgId }) }));

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Marke Test GmbH", addressLine1: "Markenweg 1", postalCode: "10115", city: "Berlin" },
  });
  orgId = org.id;
});

function upload(kind: string, buf: Buffer, name: string, mime: string) {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(buf)], name, { type: mime }));
  return new Request(`http://x/api/settings/branding/upload?kind=${kind}`, { method: "POST", body: fd });
}

describe("Branding-Upload: favicon/applogo", () => {
  it("quadratisches 64x64-PNG als Favicon -> 201 und Pfad gespeichert", async () => {
    expect((await POST(upload("favicon", testPngBuffer(64, 64), "icon.png", "image/png"))).status).toBe(201);
    expect((await dbInternal.brandingSettings.findUnique({ where: { orgId } }))?.faviconPath).toBeTruthy();
  });

  it("weist nicht quadratische, zu kleine, JPEG- und unbekannt-kind-Uploads mit 400 ab", async () => {
    const cases: [string, Buffer, string, string][] = [
      ["favicon", testPngBuffer(100, 200), "icon.png", "image/png"],   // nicht quadratisch
      ["favicon", testPngBuffer(16, 16), "icon.png", "image/png"],     // < 32 px
      ["favicon", testPngBuffer(64, 64), "icon.jpg", "image/jpeg"],    // Favicon nur PNG
      ["banner", testPngBuffer(64, 64), "x.png", "image/png"],         // unbekanntes kind
    ];
    for (const [kind, buf, name, mime] of cases) {
      expect((await POST(upload(kind, buf, name, mime))).status).toBe(400);
    }
  });
});

describe("Oeffentliche Auslieferung", () => {
  it("GET /api/branding/icon liefert das hochgeladene Favicon mit Cache-Header", async () => {
    const res = await iconGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age=300");
  });

  it("GET /api/branding/appLogo ohne Upload -> 404 (Huelle zeigt dann das Kuerzel)", async () => {
    await dbInternal.brandingSettings.update({ where: { orgId }, data: { appLogoPath: null } });
    expect((await logoGet()).status).toBe(404);
  });

  it("/api/branding ist proxy-oeffentlich", () => {
    expect(PUBLIC_PREFIXES).toContain("/api/branding");
  });
});
```
> `src/proxy.ts` exportiert **kein** `isPublicPath`, nur `PUBLIC_PREFIXES` (Z. 90) — `matchesPublicPrefix` ist modulintern. **`test/unit/proxy-public.test.ts:11` prüft die Liste auf exakte Gleichheit** und muss im selben Commit um `"/api/branding"` erweitert werden, sonst bricht ein Bestandstest.

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/png-size.test.ts test/integration/branding-assets.test.ts`.

- [ ] **Step 3: `pngSize` schreiben**

```ts
// src/lib/images/png-size.ts
/**
 * Liest Breite/Hoehe aus dem IHDR-Chunk eines PNG (Phase 12c). Bewusst KEINE
 * Bildbibliothek: fuer die eine Favicon-Regel ("quadratisch, 32..512 px") genuegen die
 * acht Bytes ab Offset 16 der festen PNG-Struktur (8 Byte Signatur + 4 Byte Laenge +
 * 4 Byte "IHDR" + 4 Byte Breite + 4 Byte Hoehe).
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
```

- [ ] **Step 4: Upload-Route erweitern**
  - `kindSchema` → `z.enum(["logo", "background", "favicon", "applogo"])`; Fehlertext auf „kind muss logo, background, favicon oder applogo sein." ändern (beide Vorkommen, POST **und** DELETE).
  - `KIND_LIMITS_BYTES` → `{ logo: 2*1024*1024, background: 5*1024*1024, favicon: 512*1024, applogo: 1024*1024 }`, Typ `Record<Kind, number>`.
  - Neu `const KIND_FIELD: Record<Kind, "logoPath" | "backgroundPath" | "faviconPath" | "appLogoPath">` — ersetzt den ternären Ausdruck `[kind === "logo" ? "logoPath" : "backgroundPath"]` an **beiden** Stellen (POST Z. 67, DELETE Z. 96).
  - Favicon-Sonderregel direkt nach der MIME-Prüfung (die manuelle PNG/JPEG-Prüfung bleibt):
    ```ts
    const buffer = Buffer.from(await file.arrayBuffer());
    if (kind === "favicon") {
      if (mime !== "image/png") {
        return NextResponse.json({ error: "Das Favicon muss ein PNG sein." }, { status: 400 });
      }
      const size = pngSize(buffer);
      if (!size) return NextResponse.json({ error: "PNG konnte nicht gelesen werden." }, { status: 400 });
      if (size.width !== size.height) {
        return NextResponse.json({ error: `Das Favicon muss quadratisch sein (${size.width}x${size.height} px).` }, { status: 400 });
      }
      if (size.width < 32 || size.width > 512) {
        return NextResponse.json({ error: "Das Favicon muss zwischen 32 und 512 px gross sein." }, { status: 400 });
      }
    }
    ```
    `const buffer = …` wandert damit **vor** den `try`-Block; im `try` wird der bereits gelesene Puffer an `storeFile` gereicht (kein zweites `arrayBuffer()`).
  - Modulkommentar um Phase 12c ergänzen (vier `kind`-Werte, Favicon-Regel, kein SVG wegen XSS).

- [ ] **Step 5: Zwei öffentliche Auslieferungsrouten + Proxy**

```ts
// src/app/api/branding/icon/route.ts
import { NextResponse } from "next/server";
import { readFile as readAppFile } from "node:fs/promises";
import path from "node:path";
import { getActiveOrg } from "@/lib/org";
import { loadBrandingSettings } from "@/domain/settings/branding";
import { readFile } from "@/lib/attachments/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE = { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } as const;

/**
 * Favicon der Instanz (Phase 12c) — OEFFENTLICH (in PUBLIC_PREFIXES): der Browser fordert
 * das Icon bereits fuer die Login-Seite an, also vor jeder Session. Ohne eigenen Upload
 * liefert die Route das mitgelieferte src/app/favicon.ico.
 */
export async function GET() {
  try {
    const branding = await loadBrandingSettings((await getActiveOrg()).id);
    if (branding.faviconPath) {
      const buffer = await readFile(branding.faviconPath);
      return new NextResponse(new Uint8Array(buffer), { status: 200, headers: { "content-type": "image/png", ...CACHE } });
    }
  } catch {
    // keine Organisation / Datei nicht lesbar -> mitgeliefertes Icon
  }
  const fallback = await readAppFile(path.join(process.cwd(), "src/app/favicon.ico"));
  return new NextResponse(new Uint8Array(fallback), { status: 200, headers: { "content-type": "image/x-icon", ...CACHE } });
}
```
`src/app/api/branding/appLogo/route.ts` analog, aber **ohne** Fallback: ohne `appLogoPath` → `NextResponse.json({ error: "Kein Logo hinterlegt." }, { status: 404 })`. Der MIME-Typ kommt über `sniffMime` (`@/lib/attachments/storage`, re-exportiert Z. 116) aus dem Puffer und ist auf `image/png`/`image/jpeg` beschränkt (sonst 404) — der gespeicherte Pfad trägt keinen Typ.

`src/proxy.ts:22`: `"/api/branding"` in `PUBLIC_PREFIXES` aufnehmen (exakt-oder-Slash-Semantik von `matchesPublicPrefix` genügt; `/api/brandingfoo` bleibt geschützt), Kommentar darüber um einen Satz ergänzen: „`/api/branding` liefert nur Favicon/Logo der Instanz — keine personenbezogenen Daten, wird aber vor der Session gebraucht."

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/lib/images src/app/api/branding src/app/api/settings/branding/upload/route.ts src/proxy.ts test/unit/png-size.test.ts test/unit/proxy-public.test.ts test/integration/branding-assets.test.ts
git commit -s -m "feat(marke): Favicon-/App-Logo-Upload und zwei oeffentliche Auslieferungsrouten (Phase 12c, Task 2)"
```

---

### Task 3: Metadaten, App-Hüllen und AGPL-Zeile

**Files:**
- Modify: `src/app/layout.tsx:1-74`, `src/components/shell/AppShell.tsx:8-45`, `src/components/shell/Sidebar.tsx:16-78`, `src/components/shell/Topbar.tsx` (Kopfzeile ~Z. 95-101 + `Sidebar`-Aufruf), `src/components/shell/SlimShell.tsx:17-34`, `src/components/AuthForm.tsx:40`, `src/domain/email/settings.ts:114-115`, `src/domain/webhook/actions.ts:40`, `src/domain/notifications/job.ts:191`
- Create: `test/integration/brand-shell.test.tsx`

**Befund (verifiziert):** Das Root-Layout ist bereits `async`, ruft `getActiveOrg()` in einem `try` auf und reicht `orgName`/`unreadCount`/`appVersion` als Props an `AppShell` weiter — die Marke passt in dieselbe Kette, ohne zusätzlichen Query je Komponente. Die Literale stehen an genau sieben Stellen: `layout.tsx:17` (statisches `metadata`), `:55` (`orgName`-Fallback „OpenInvoice"), `Sidebar.tsx:66,69`, `Topbar.tsx:99`, `SlimShell.tsx:24,25,31`, `AppShell.tsx:38`, `AuthForm.tsx:40`. Dazu drei Textstellen im Versand: `email/settings.ts:114-115`, `webhook/actions.ts:40`, `notifications/job.ts:191` (Letztere nennt die Spec nicht, ist aber derselbe Fall).

**Interfaces:**
```tsx
// AppShell / SlimShell / Sidebar / Topbar
brand: Brand                      // aus @/domain/settings/brand
// AuthForm
appName?: string                  // Default DEFAULT_APP_NAME (Login rendert ohne Org-Kontext)
// layout.tsx
export async function generateMetadata(): Promise<Metadata>
```

- [ ] **Step 1: Failing test schreiben**

```tsx
// test/integration/brand-shell.test.tsx
/**
 * Phase 12c, Task 3 — generateMetadata + AGPL-Zeile. Kein RTL im Projekt: die Huellen
 * werden ueber renderToStaticMarkup (react-dom/server, bereits als Next-Abhaengigkeit
 * vorhanden) zu HTML gerendert und im String geprueft. Eigenes Jahr 2080.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dbInternal } from "@/lib/db";
import { saveBrandingSettings, loadBrandingSettings } from "@/domain/settings/branding";
import { loadBrand, DEFAULT_APP_NAME, DEFAULT_BRAND } from "@/domain/settings/brand";
import { SlimShell } from "@/components/shell/SlimShell";

let orgId: string;
vi.mock("@/lib/org", () => ({ getActiveOrg: () => Promise.resolve({ id: orgId }) }));

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Huellen Test GmbH", addressLine1: "Huellenweg 1", postalCode: "10115", city: "Berlin" },
  });
  orgId = org.id;
});

describe("Marke in den Huellen", () => {
  it("ohne Einstellung gilt der Produktname", async () => {
    expect((await loadBrand(orgId)).appName).toBe(DEFAULT_APP_NAME);
  });

  it("generateMetadata nutzt appName als Titel und die Icon-Route", async () => {
    // Ab hier ist die Marke gesetzt — die drei folgenden Faelle bauen darauf auf.
    const current = await loadBrandingSettings(orgId);
    await saveBrandingSettings(orgId, { ...current, appName: "Muster Rechnungen", appShortName: "MR" });
    const { generateMetadata } = await import("@/app/layout");
    const meta = await generateMetadata();
    expect(String(meta.title)).toContain("Muster Rechnungen");
    expect(String(meta.title)).not.toContain("OpenInvoice");
    expect(meta.applicationName).toBe("Muster Rechnungen");
    expect(JSON.stringify(meta.icons)).toContain("/api/branding/icon");
  });

  it("die AGPL-Herkunftszeile bleibt auch bei gesetztem appName sichtbar", () => {
    const html = renderToStaticMarkup(<SlimShell brand={{ appName: "Muster Rechnungen", appShortName: "MR", hasAppLogo: false }}>x</SlimShell>);
    expect(html).toContain("Muster Rechnungen");
    expect(html).toContain("powered by OpenInvoice Germany");
    expect(html).toContain("AGPL-3.0");
  });

  it("ohne Marke zeigt die Huelle die Produktvorgabe", () => {
    const html = renderToStaticMarkup(<SlimShell brand={DEFAULT_BRAND}>x</SlimShell>);
    expect(html).toContain("OpenInvoice Germany");
  });
});
```
> **Dies ist die erste `.tsx`-Testdatei des Projekts** (`ls test/**/*.tsx` ist heute leer). `tsconfig.json` hat `"jsx": "react-jsx"`, das esbuild von Vitest übernimmt die Einstellung — es ist keine Konfigurationsänderung nötig; scheitert der Lauf dennoch an JSX, `esbuild: { jsx: "automatic" }` in `vitest.config.ts` ergänzen. `environment: "node"` genügt, `renderToStaticMarkup` braucht kein DOM. Falls der Import von `@/app/layout` an `next/headers` scheitert, `headers` in derselben Datei per `vi.mock("next/headers", …)` auf ein leeres `Headers`-Objekt mocken (Muster: bestehende Route-Tests).

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/brand-shell.test.tsx`.

- [ ] **Step 3: `layout.tsx` umbauen**

```tsx
export async function generateMetadata(): Promise<Metadata> {
  // Phase 12c: der Produktname ist ueberschreibbar (Einstellungen -> Marke). Ohne
  // Organisation (Setup-Zustand) gelten die Produktvorgaben — generateMetadata darf die
  // Seite nie reissen.
  let brand = DEFAULT_BRAND;
  try {
    const org = await getActiveOrg();
    brand = await loadBrand(org.id);
  } catch {
    // keine Organisation eingerichtet
  }
  const isDefault = brand.appName === DEFAULT_APP_NAME;
  return {
    title: isDefault ? `${DEFAULT_APP_NAME} — kostenlose, rechtssichere Rechnungssoftware` : brand.appName,
    applicationName: brand.appName,
    description:
      "Kostenlose, self-hostbare Open-Source-Rechnungssoftware für Deutschland: E-Rechnung (XRechnung/ZUGFeRD), GoBD, § 14 UStG, Kleinunternehmer § 19.",
    icons: { icon: "/api/branding/icon" },
  };
}
```
Das statische `export const metadata` (Z. 16–20) entfällt. Im Rumpf von `RootLayout`:
- öffentlicher Zweig und unauthentifizierter Zweig: `const brand = await safeBrand();` und `<SlimShell brand={brand} …>`.
- angemeldeter Zweig: der bestehende `try`-Block lädt zusätzlich `brand = await loadBrand(org.id)` (ein Aufruf, `loadBrandingSettings` liest eine Zeile) und reicht `brand` an `AppShell`.
- Der Fallback `let orgName = "OpenInvoice"` (Z. 55) wird zu `let orgName = ""` — die Sidebar zeigt den Organisationsnamen, nicht den Produktnamen; ein leerer Wert blendet die Zeile aus (`{orgName && …}`).
- Kleiner Helfer in derselben Datei:
  ```tsx
  async function safeBrand(): Promise<Brand> {
    try {
      return await loadBrand((await getActiveOrg()).id);
    } catch {
      return DEFAULT_BRAND;
    }
  }
  ```

- [ ] **Step 4: Hüllen umstellen**
  - `AppShell.tsx`: Prop `brand: Brand` statt nichts; an `Sidebar` und `Topbar` durchreichen; Fußzeile (Z. 37–39):
    ```tsx
    <footer className="mx-auto w-full max-w-6xl px-6 py-6 text-xs text-slate-400">
      {brand.appName} · powered by OpenInvoice Germany · AGPL-3.0 ·{" "}
      <a href={SOURCE_URL} className="underline hover:text-slate-600">Quellcode</a> · Keine Steuer-/Rechtsberatung — siehe COMPLIANCE.md
    </footer>
    ```
  - `SlimShell.tsx`: Prop `brand: Brand`; Kopfzeile zeigt `brand.appShortName` im Quadrat und `brand.appName` daneben (kein „DE"-Suffix mehr — es steckt im Namen); dieselbe Fußzeile wie oben. Bei `brand.hasAppLogo` rendert die Kopfzeile stattdessen `<img src="/api/branding/appLogo" alt={brand.appName} className="h-7 w-auto" />` (kein `next/image`: die Route liefert kein optimierbares statisches Asset).
  - `Sidebar.tsx`: Prop `brand: Brand` ergänzen; Z. 66 zeigt `brand.appShortName`, Z. 68–71 `brand.appName`; bei `hasAppLogo` dasselbe `<img>` wie in `SlimShell` (im eingeklappten Zustand nur das Logo/Kürzel).
  - `Topbar.tsx`: Prop `brand: Brand`; Z. 99 zeigt `brand.appName`; `brand` an die Drawer-`Sidebar` weiterreichen.
  - `AuthForm.tsx:40`: Prop `appName: string = DEFAULT_APP_NAME`; Text „Melde dich an deiner {appName}-Instanz an." Die Login-Seite reicht den Wert aus `safeBrand()` durch (`src/app/login/page.tsx` prüfen und ergänzen).

- [ ] **Step 5: Drei Versandtexte**
  - `src/domain/email/settings.ts:114-115`: `const brand = await loadBrand(orgId);`, Betreff `Testnachricht von ${brand.appName}`, Text „Dies ist eine Testnachricht der Mail-Einstellungen von ${brand.appName}." (`sendTestMail` kennt `orgId` bereits).
  - `src/domain/webhook/actions.ts:40`: `dataJson: JSON.stringify({ message: \`Dies ist eine Test-Zustellung von ${brand.appName}.\` })` mit `const brand = await loadBrand(orgId);` davor.
  - `src/domain/notifications/job.ts:191`: Betreff `Tagesuebersicht ${brand.appName}` (die Funktion arbeitet je `orgId`, `loadBrand` passt in denselben Block wie `mailSettings`).

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build`
```bash
git add src/app/layout.tsx src/app/login src/components/shell src/components/AuthForm.tsx src/domain/email/settings.ts src/domain/webhook/actions.ts src/domain/notifications/job.ts test/integration/brand-shell.test.tsx
git commit -s -m "feat(marke): dynamische Metadaten, Marke in beiden Huellen, feste AGPL-Herkunftszeile (Phase 12c, Task 3)"
```

---

### Task 4: Einstellungen → Marke

**Files:**
- Modify: `src/lib/nav.ts:34-49,97-112`, `test/unit/nav.test.ts` (Duplikat-/Key-Prüfung bleibt grün)
- Create: `src/app/einstellungen/marke/page.tsx`, `src/components/settings/MarkeForm.tsx`

**Befund (verifiziert):** `SettingsTabs` leitet seine Reiter vollständig aus `SETTINGS_ITEMS` ab — ein neuer Eintrag genügt, es gibt keine zweite Liste. `SETTINGS_KEYS` ist die Typquelle (`SettingsKey`). `BrandingForm` speichert per `fetch("/api/settings/branding", { method: "PUT" })` und lädt Dateien über `/api/settings/branding/upload?kind=…` hoch — `MarkeForm` benutzt dieselben zwei Endpunkte, es kommt **keine** neue Route dazu.

- [ ] **Step 1: `nav.ts` erweitern**
  - `SETTINGS_KEYS`: `"marke"` nach `"briefpapier"` einfügen.
  - `SETTINGS_ITEMS`: `{ href: "/einstellungen/marke", label: "Marke", key: "marke" }` zwischen „Briefpapier" und „E-Mail-Versand" (Spec: genau diese Position).

- [ ] **Step 2: Seite und Formular**

```tsx
// src/app/einstellungen/marke/page.tsx
import { getActiveOrg } from "@/lib/org";
import { SettingsTabs } from "@/components/SettingsTabs";
import { loadBrandingSettings } from "@/domain/settings/branding";
import { MarkeForm } from "@/components/settings/MarkeForm";
import { DEFAULT_APP_NAME, DEFAULT_APP_SHORT_NAME } from "@/domain/settings/brand";

export const dynamic = "force-dynamic";

export default async function MarkeSettingsPage() {
  const org = await getActiveOrg();
  const branding = await loadBrandingSettings(org.id);

  return (
    <div className="space-y-6">
      <SettingsTabs active="marke" />
      <h1 className="text-2xl font-bold tracking-tight">Marke</h1>
      <p className="text-sm text-slate-600">
        Name, Kurzname, Favicon und Logo dieser Instanz. Ohne Eintrag gilt „{DEFAULT_APP_NAME}" (Kurzname „{DEFAULT_APP_SHORT_NAME}").
        Die Herkunftszeile „powered by OpenInvoice Germany · AGPL-3.0" bleibt in der Fußzeile — sie ist Bedingung der AGPL-3.0-Lizenz
        und lässt sich nicht abschalten (siehe COMPLIANCE.md).
      </p>
      <MarkeForm initial={branding} />
    </div>
  );
}
```

`MarkeForm.tsx` (Client, ≤ 160 Zeilen, Muster `BrandingForm`): zwei Textfelder (`appName` max. 40, `appShortName` max. 12, leer ⇒ `null`), zwei Datei-Uploads (`kind=favicon`, `kind=applogo`) mit „entfernen"-Knopf (`DELETE /api/settings/branding/upload?kind=…`), Live-Vorschau der Kopfzeile (Kürzel-Quadrat bzw. `<img src="/api/branding/appLogo">` plus Name) und ein Speichern-Knopf, der `PUT /api/settings/branding` mit dem **vollständigen** `BrandingSettingsInput` sendet (wie `BrandingForm.save()` — die Route erwartet das ganze Objekt). Nach Erfolg `router.refresh()`, damit Sidebar/Topbar den neuen Namen zeigen. Der Hinweis unter den Uploads nennt die Grenzen wörtlich: „Favicon: quadratisches PNG, 32–512 px, max. 512 KB." / „Logo: PNG oder JPEG, max. 1 MB, wird auf 28 px Höhe angezeigt."

- [ ] **Step 3: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/lib/nav.ts src/app/einstellungen/marke src/components/settings/MarkeForm.tsx
git commit -s -m "feat(marke): Einstellungen-Reiter Marke mit Name, Kurzname, Favicon und Logo (Phase 12c, Task 4)"
```

---

### Task 5: Steuersätze — Speicher, Zod-Lockerung, Durchsetzung

**Files:**
- Modify: `prisma/schema.prisma:940-966` + `prisma/schema.postgres.prisma` (`model DocumentSettings`), `src/schemas/quote-share.ts:18-60`, `src/schemas/index.ts:29`, `src/domain/document/settings.ts:14-50`, `src/domain/invoice/create.ts:23-31,232-238`, `src/domain/invoice/update.ts:34`, `src/domain/document/create.ts:37,208`, `src/domain/document/update.ts:20`, `src/domain/delivery-note/create.ts:43,209`, `src/domain/recurring/create.ts:18`, `src/domain/recurring/update.ts:15`, `src/domain/product/save.ts:32,43`, `src/domain/document/duplicate.ts:205`, `src/domain/document/convert.ts:199,229,299`, `src/domain/invoice/partial.ts:519`, `src/domain/invoice/downpayment.ts:168`, `src/domain/invoice/final.ts:106`, `src/api/errors.ts:41-59`, `scripts/test-postgres-migrations.sh:243` + Dateiende
- Create: `prisma/migrations/20260910091000_phase12c_tax_rates/migration.sql`, `prisma/migrations-postgres/20260910091100_phase12c_tax_rates/migration.sql`, `src/domain/settings/tax-rates.ts`, `test/unit/tax-rates.test.ts`, `test/integration/tax-rates-enforcement.test.ts`

**Befund (verifiziert):** Alle sieben `taxRate`-Spalten sind `Int` (Prozent als ganze Zahl): `Product:162`, `QuoteLine:268`, `FinalInvoiceDeduction:408`, `InvoiceLine:429`, `RecurringInvoiceLine:550`, `DeliveryNoteLine:639`. `TaxRate` (`src/schemas/index.ts:29`) wird an drei Stellen benutzt (`:212` `productSchema`, `:232` `invoiceLineInputSchema`, `:527` `partialCreditSchema`); `createRecurringSchema`/`updateRecurringSchema` nutzen `invoiceLineInputSchema` und sind damit automatisch abgedeckt. `deliveryNoteLineInputSchema:673` hat bereits `z.number().int().optional()`. `saveDocumentSettings` spreizt `input` direkt in `create`/`update` — ein Array-Feld muss deshalb wie `layoutByType` in `branding.ts` herausgezogen werden.

**Ruling (Ergänzung zur Spec):** `taxRatesSchema` enthält **kein** `.transform` — sonst wird das Feld ein `ZodPipe`, das `partialInputShape` (`src/mcp/tools/partial-input.ts`, unwrappt nur `ZodDefault`) und `zod-to-openapi` nur unsauber abbilden. Sortierung und Deduplizierung übernimmt die reine Funktion `normalizeTaxRates`, aufgerufen in `saveDocumentSettings`.

**Ruling (Ableitungen):** `createDraftInvoiceWithinTx`/`createBusinessDocumentWithinTx`/`createDeliveryNoteWithinTx` sind die gemeinsamen Kerne von UI, API und MCP — dort sitzt die Prüfung. Fünf Aufrufer erzeugen einen Beleg **aus einem bestehenden** (Duplikat, Konvertierung, Teil-, Abschlags-, Schlussrechnung); sie reichen die Sätze des Quellbelegs als `opts.inheritedTaxRates` durch. Das ist kein Bypass, sondern genau die in der Spec vorgesehene „bereits auf dem Beleg gespeichert"-Ausnahme.

**Interfaces:**
```ts
// src/schemas/quote-share.ts
export const taxRatesSchema = z.array(z.number().int().min(0).max(100)).min(1).max(10);
export function normalizeTaxRates(rates: readonly number[]): number[];   // dedupliziert, aufsteigend
// documentSettingsInputSchema += taxRates: taxRatesSchema.default([19, 7, 0])

// src/schemas/index.ts
export const TaxRate = z.number().int().min(0).max(100);

// src/domain/settings/tax-rates.ts
export class TaxRateNotAllowedError extends Error {}
export function ratesOfLines(lines: readonly { taxRate?: number | null }[]): number[];
export async function assertAllowedTaxRates(
  tx: Prisma.TransactionClient | typeof dbInternal,
  orgId: string,
  rates: readonly number[],
  opts?: { existing?: readonly number[] },
): Promise<void>;

// src/domain/invoice/create.ts (CreateOptions) und die beiden anderen …WithinTx
inheritedTaxRates?: readonly number[];
```

- [ ] **Step 1: Failing tests schreiben**

```ts
// test/unit/tax-rates.test.ts
/** Phase 12c, Task 5 — Steuersatz-Liste: Zod, Normalisierung, TaxRate-Lockerung. */
import { describe, it, expect } from "vitest";
import { taxRatesSchema, normalizeTaxRates, documentSettingsInputSchema } from "@/schemas/quote-share";
import { TaxRate } from "@/schemas";

describe("taxRatesSchema (Phase 12c)", () => {
  it("Default ist [19,7,0]", () => {
    expect(documentSettingsInputSchema.parse({}).taxRates).toEqual([19, 7, 0]);
  });
  it("1..10 Eintraege, 0..100, ganzzahlig", () => {
    for (const bad of [[], [19, 7, 0, 5, 10, 12, 13, 16, 20, 21, 22], [101], [-1], [5.5]]) {
      expect(taxRatesSchema.safeParse(bad).success).toBe(false);
    }
    expect(taxRatesSchema.parse([19, 7, 0])).toEqual([19, 7, 0]);
  });
  it("normalizeTaxRates dedupliziert und sortiert aufsteigend", () => {
    expect(normalizeTaxRates([19, 19, 7])).toEqual([7, 19]);
    expect(normalizeTaxRates([0, 19, 7])).toEqual([0, 7, 19]);
  });
});

describe("TaxRate ist keine Union mehr", () => {
  it("akzeptiert jeden ganzzahligen Satz 0..100", () => {
    for (const ok of [0, 7, 10, 19, 100]) expect(TaxRate.parse(ok)).toBe(ok);
    for (const bad of [-1, 101, 5.5]) expect(TaxRate.safeParse(bad).success).toBe(false);
  });
});
```

```ts
// test/integration/tax-rates-enforcement.test.ts
/**
 * Phase 12c, Task 5 — assertAllowedTaxRates in den Domain-Kernen. Eigenes Jahr 2081
 * (Testjahr-Konvention) und eigener Nummernkreis-Praefix, weil hier festgeschrieben wird.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings, loadDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createProduct } from "@/domain/product/save";
import { assertAllowedTaxRates, TaxRateNotAllowedError } from "@/domain/settings/tax-rates";
import type { CreateInvoiceInput } from "@/schemas";

let orgId: string;
let customerId: string;
const NOW = new Date(2081, 2, 10, 10, 0, 0);

function line(taxRate: number) {
  return { description: `Position ${taxRate}%`, quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate, taxCategory: "S" as const, discountPermille: 0 };
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Steuersatz Test GmbH", addressLine1: "Satzweg 1", postalCode: "10115", city: "Berlin", vatId: "DE811111111", taxNumber: "81/111/11111" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Satzkunde AG", addressLine1: "Kundenweg 2", postalCode: "10117", city: "Berlin", type: "BUSINESS" },
  });
  customerId = customer.id;
});

describe("assertAllowedTaxRates", () => {
  it("Satz aus der Liste ist erlaubt, unbekannter nicht, 0 immer", async () => {
    await expect(assertAllowedTaxRates(dbInternal, orgId, [19, 7])).resolves.toBeUndefined();
    await expect(assertAllowedTaxRates(dbInternal, orgId, [0])).resolves.toBeUndefined();
    await expect(assertAllowedTaxRates(dbInternal, orgId, [10])).rejects.toBeInstanceOf(TaxRateNotAllowedError);
  });

  it("ein bereits auf dem Beleg gespeicherter Satz bleibt erlaubt (GoBD)", async () => {
    await expect(assertAllowedTaxRates(dbInternal, orgId, [10], { existing: [10] })).resolves.toBeUndefined();
  });

  it("die Fehlermeldung nennt Satz und Ort der Einstellung", async () => {
    await expect(assertAllowedTaxRates(dbInternal, orgId, [10])).rejects.toThrow(
      "Steuersatz 10 % ist für diese Organisation nicht freigegeben (Einstellungen → Belege).",
    );
  });
});

describe("Durchsetzung in den Domain-Kernen", () => {
  const inv10 = () =>
    createDraftInvoice(orgId, { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: NOW, lines: [line(10)] } as CreateInvoiceInput, { now: NOW });
  const setRates = async (taxRates: number[]) => saveDocumentSettings(orgId, { ...(await loadDocumentSettings(orgId)), taxRates });

  it("Rechnung mit nicht freigegebenem Satz wird abgelehnt", async () => {
    await expect(inv10()).rejects.toBeInstanceOf(TaxRateNotAllowedError);
  });

  it("nach Freigabe anlegbar und festschreibbar; das spaetere Entfernen aendert den Beleg nicht", async () => {
    await setRates([19, 7, 0, 10]);
    const inv = await inv10();
    await finalizeInvoice(inv.id, { now: NOW });

    await setRates([19, 7, 0]);
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
    expect(after.lines[0].taxRate).toBe(10);
    expect(after.status).toBe("FINALIZED");
    // Ein NEUER Beleg mit 10 % ist jetzt nicht mehr speicherbar.
    await expect(inv10()).rejects.toBeInstanceOf(TaxRateNotAllowedError);
  });

  it("ein Entwurf mit 10 % bleibt aenderbar, solange sein Satz unveraendert bleibt", async () => {
    await setRates([19, 7, 0, 10]);
    const draft = await inv10();
    await setRates([19, 7, 0]);
    const updated = await updateDraftInvoice(orgId, draft.id, { subject: "Betreff neu" }, "test");
    expect(updated.lines[0].taxRate).toBe(10);
  });

  it("Produkt mit nicht freigegebenem Satz wird abgelehnt", async () => {
    await expect(createProduct(orgId, { name: "Sonderware", unit: "C62", netPriceCents: 1000, taxRate: 10, taxCategory: "S" })).rejects.toBeInstanceOf(
      TaxRateNotAllowedError,
    );
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/tax-rates.test.ts test/integration/tax-rates-enforcement.test.ts`.

- [ ] **Step 3: Prisma + beide Migrationen**

In **beiden** Schemadateien in `model DocumentSettings` nach `recurringAutoSendDefault`:
```prisma
  /// Phase 12c — freigegebene Steuersaetze der Organisation als JSON-Array ganzer
  /// Prozentwerte (taxRatesSchema, 1..10 Eintraege, 0..100). Wirkt nur auf neue/geaenderte
  /// Entwuerfe: ein festgeschriebener Beleg behaelt seinen Satz (GoBD, §51).
  taxRatesJson                 String       @default("[19,7,0]")
```
Beide `migration.sql`:
```sql
-- Phase 12c — org-eigene Steuersaetze. Bestandszeilen bekommen per Default die bisher
-- fest verdrahtete Liste [19,7,0]; kein Beleg wird angefasst.
-- AlterTable
ALTER TABLE "DocumentSettings" ADD COLUMN "taxRatesJson" TEXT NOT NULL DEFAULT '[19,7,0]';
```
Anwenden: `npx prisma migrate deploy`, danach `npx prisma generate`.

- [ ] **Step 4: Zod + Settings-Domain**
  - `src/schemas/quote-share.ts`: `taxRatesSchema` + `normalizeTaxRates` exportieren, Feld `taxRates: taxRatesSchema.default([19, 7, 0])` ans Ende von `documentSettingsInputSchema` (Kommentar: „Phase 12c, §33 — nur ganze Prozentwerte; alle taxRate-Spalten sind Int und die Rechenkette arbeitet mit net * rate / 100").
    ```ts
    export function normalizeTaxRates(rates: readonly number[]): number[] {
      return Array.from(new Set(rates)).sort((a, b) => a - b);
    }
    ```
  - `src/schemas/index.ts:29`: `export const TaxRate = z.number().int().min(0).max(100);` mit Kommentar („Phase 12c: keine Literal-Union mehr — die zulaessige Menge ist org-abhaengig und wird von assertAllowedTaxRates geprueft, nicht von Zod").
  - `src/domain/document/settings.ts`: `loadDocumentSettings` bekommt `taxRates: parseTaxRates(row.taxRatesJson)`; `saveDocumentSettings`:
    ```ts
    const input = documentSettingsInputSchema.parse(rawInput);
    const { taxRates, ...rest } = input;
    const normalized = normalizeTaxRates(taxRates);
    const data = { ...rest, taxRatesJson: JSON.stringify(normalized) };
    await dbInternal.documentSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: { ...data } });
    return { ...input, taxRates: normalized };
    ```
    `parseTaxRates(json)` liegt in derselben Datei: `JSON.parse` in `try/catch`, Ergebnis durch `taxRatesSchema.safeParse`, bei Misserfolg `[19, 7, 0]` (Selbstheilung wie `parseLayoutByType`).

- [ ] **Step 5: `assertAllowedTaxRates` schreiben**

```ts
// src/domain/settings/tax-rates.ts
/**
 * Durchsetzung der org-eigenen Steuersatz-Liste (Phase 12c, §33/§50). Sitzt in den
 * Domain-Kernen (…WithinTx / update… / saveProduct), NIE in einer Route oder einem
 * Formular — UI, REST-API und MCP laufen dort zusammen, es gibt keinen Bypass.
 *
 * Ein Satz ist zulaessig, wenn er
 *   (a) in der Liste der Organisation steht, ODER
 *   (b) bereits auf dem zu aendernden/abgeleiteten Beleg gespeichert ist (GoBD, §51:
 *       ein Beleg verliert seinen Satz nicht, weil die Organisation die Liste aendert), ODER
 *   (c) 0 ist — Gliederungszeilen (HEADING/TEXT/SUBTOTAL) und die Nullsatz-Schemata
 *       (KLEINUNTERNEHMER, DIFFERENZ, REVERSE_CHARGE, IG_*, AUSFUHR) brauchen ihn immer.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { loadDocumentSettings } from "@/domain/document/settings";

export class TaxRateNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxRateNotAllowedError";
  }
}

/** Die tatsaechlich vorkommenden Saetze einer Positionsliste (undefined/null -> ignoriert). */
export function ratesOfLines(lines: readonly { taxRate?: number | null }[]): number[] {
  const out = new Set<number>();
  for (const l of lines) if (typeof l.taxRate === "number") out.add(l.taxRate);
  return [...out];
}

export async function assertAllowedTaxRates(
  _tx: Prisma.TransactionClient | typeof dbInternal,
  orgId: string,
  rates: readonly number[],
  opts: { existing?: readonly number[] } = {},
): Promise<void> {
  const candidates = [...new Set(rates)].filter((r) => r !== 0);
  if (candidates.length === 0) return;
  const allowed = new Set((await loadDocumentSettings(orgId)).taxRates);
  for (const r of opts.existing ?? []) allowed.add(r);
  for (const rate of candidates) {
    if (!allowed.has(rate)) {
      throw new TaxRateNotAllowedError(`Steuersatz ${rate} % ist für diese Organisation nicht freigegeben (Einstellungen → Belege).`);
    }
  }
}
```
> `_tx` bleibt in der Signatur (Spec), wird aber bewusst nicht benutzt: `loadDocumentSettings` liest eine org-weite Einstellungszeile, die nicht Teil der Beleg-Transaktion ist. Der Parameter hält die Aufrufstellen einheitlich und lässt eine spätere Umstellung auf den Transaktionsclient zu, ohne jede Aufrufstelle anzufassen. **Der Kommentar dazu gehört in den Code.**

- [ ] **Step 6: Aufrufstellen**
  - `src/domain/invoice/create.ts`: `CreateOptions` += `inheritedTaxRates?: readonly number[]`; in `createDraftInvoiceWithinTx` direkt nach `const normalized = normalizeLines(input.lines);`:
    ```ts
    await assertAllowedTaxRates(tx, orgId, ratesOfLines(normalized), { existing: opts.inheritedTaxRates });
    ```
  - `src/domain/document/create.ts#createBusinessDocumentWithinTx` und `src/domain/delivery-note/create.ts#createDeliveryNoteWithinTx`: dieselbe Zeile an der entsprechenden Stelle (nach `normalizeLines` bzw. nach dem Aufbau der Positionsliste), jeweils mit `inheritedTaxRates` in ihren Options-Typen.
  - `src/domain/invoice/update.ts#updateDraftInvoice` und `src/domain/document/update.ts#updateDraftDocument`: wenn `input.lines !== undefined`, innerhalb der Transaktion **vor** dem `deleteMany`/`create`:
    ```ts
    await assertAllowedTaxRates(tx, orgId, ratesOfLines(input.lines), { existing: ratesOfLines(invoice.lines) });
    ```
    (`invoice`/`quote` ist dort bereits mit `lines` geladen.)
  - `src/domain/recurring/create.ts#createRecurring` und `src/domain/recurring/update.ts#updateRecurringInvoice`: analog; beim Update liefert der geladene Bestand die `existing`-Sätze.
  - `src/domain/product/save.ts`: in `createProduct` nach `productSchema.parse` und in `updateProduct` nur, wenn `taxRate` tatsächlich im Rohobjekt steht — `existing: [existing.taxRate]`.
  - **Fünf abgeleitete Aufrufer** reichen die Quellsätze durch: `document/duplicate.ts:205`, `document/convert.ts:199` (+ `:299` für den Lieferschein), `invoice/partial.ts:519`, `invoice/downpayment.ts:168`, `invoice/final.ts:106` — jeweils `{ actor, now, inheritedTaxRates: ratesOfLines(<Quellpositionen>) }`. In `convert.ts:229` entfällt zugleich der Cast `l.taxRate as 19 | 7 | 0` (TaxRate ist jetzt `number`).
  - `src/api/errors.ts`: `TaxRateNotAllowedError` in `DOMAIN_CONFLICT_ERROR_CLASSES` aufnehmen (Import ergänzen) — die REST-API antwortet damit 409 CONFLICT statt 500.

- [ ] **Step 7: Postgres-Fall 19 und Fall-9-Regex**
  1. Fall-9-Regex (Zeile 243) zusätzlich um `20260910091100_phase12c_tax_rates` erweitern (ändert `DocumentSettings`).
  2. **Fall 19** am Dateiende, Muster Fall 18: alle Migrationen außer `20260910091100_phase12c_tax_rates`, `org19` + `DocumentSettings`-Zeile `ds19` anlegen, `migrate deploy`, dann:
     ```sh
     TAXJSON=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"taxRatesJson\" from \"DocumentSettings\" where id='ds19'")
     [ "$TAXJSON" = "[19,7,0]" ] || fail "Bestandszeile ds19: taxRatesJson ist '$TAXJSON', erwartet Default [19,7,0]"
     COUNT19=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
       "select count(*) from information_schema.tables where table_schema='public'")
     [ "$COUNT19" = "43" ] || fail "erwartet weiterhin 43 Tabellen nach Phase 12c/Steuersaetze, gefunden $COUNT19"
     echo "    ok — taxRatesJson mit Default [19,7,0] auf Bestandszeile, 43 Tabellen"
     ```

- [ ] **Step 8: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run api:check`
`api:check` schlägt an (`taxRates` in `/api/v1/Settings`) ⇒ `npm run api:check -- --write`, Diff mitcommitten, erneut prüfen. Mit Docker zusätzlich `bash scripts/test-postgres-migrations.sh`.
```bash
git add prisma src/schemas src/domain src/api/errors.ts scripts/test-postgres-migrations.sh openapi/openapi.json test/unit/tax-rates.test.ts test/integration/tax-rates-enforcement.test.ts
git commit -s -m "feat(steuersaetze): org-eigene Steuersatz-Liste mit assertAllowedTaxRates in den Domain-Kernen (Phase 12c, Task 5)"
```

---

### Task 6: Steuersätze in Editor, Einstellungen, MCP

**Files:**
- Modify: `src/lib/editor/constants.ts:21-25`, `src/lib/editor/draft.ts:31,124-126,260,556`, `src/components/editor/blocks/{LineRow,LineItemsEditor,RecipientBlock}.tsx`, `src/components/editor/{DocumentEditor,NewProductDialog}.tsx`, `src/app/{rechnungen/neu,rechnungen/[id]/bearbeiten,dokumente/neu,dokumente/[id]/bearbeiten,lieferscheine/neu}/page.tsx`, `src/components/forms/DocumentSettingsForm.tsx`, `src/app/actions/document-settings.ts`, `src/mcp/tools/{context,invoices,products,settings}.ts`
- Create: `src/components/settings/TaxRatesField.tsx`, `test/unit/editor-tax-rates.test.ts`

**Befund (verifiziert):** `TAX_RATE_OPTIONS` ist eine Konstante mit dem Typ `readonly { value: 19 | 7 | 0; label: string }[]`, benutzt ausschließlich in `LineRow.tsx:214`. `toTaxRate` (`LineRow.tsx:52`) und `narrowTaxRate` (`draft.ts:124`, benutzt in `draft.ts:260,556` und `RecipientBlock.tsx:66`) zwingen jeden Wert auf 19/7/0. `DraftLine.taxRate` ist `19 | 7 | 0` (`draft.ts:31`). `NewProductDialog.tsx:112` hat ein eigenes `<select>` mit denselben drei Werten. Die fünf Editor-Seiten laden bereits `loadDocumentSettings(orgId)` (bzw. können es ohne Zusatzquery, `rechnungen/neu/page.tsx:47`).

**Interfaces:**
```ts
// src/lib/editor/constants.ts
export function taxRateOptions(rates: readonly number[]): { value: number; label: string }[];
export const FALLBACK_TAX_RATES: readonly number[] = [19, 7, 0];
// src/lib/editor/draft.ts
export function clampTaxRate(n: number, allowed: readonly number[]): number;   // ersetzt narrowTaxRate
// Prop-Kette
DocumentEditor({ …, taxRates }: { taxRates: number[] })
  → LineItemsEditor({ …, taxRates }) → LineRow({ …, taxRates })
  → NewProductDialog({ …, taxRates })
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/editor-tax-rates.test.ts
/** Phase 12c, Task 6 — Editor-Optionen und Clamping aus der Org-Liste. */
import { describe, it, expect } from "vitest";
import { taxRateOptions, FALLBACK_TAX_RATES } from "@/lib/editor/constants";
import { clampTaxRate } from "@/lib/editor/draft";

describe("taxRateOptions", () => {
  it("erzeugt absteigende Optionen mit Prozentbeschriftung", () => {
    expect(taxRateOptions([0, 7, 19])).toEqual([
      { value: 19, label: "19%" },
      { value: 7, label: "7%" },
      { value: 0, label: "0%" },
    ]);
  });
  it("kommt mit einer erweiterten Liste zurecht", () => {
    expect(taxRateOptions([0, 7, 10, 19]).map((o) => o.value)).toEqual([19, 10, 7, 0]);
  });
  it("faellt auf [19,7,0] zurueck, wenn die Liste leer ankommt", () => {
    expect(taxRateOptions([]).map((o) => o.value)).toEqual([...FALLBACK_TAX_RATES]);
  });
});

describe("clampTaxRate", () => {
  it("laesst freigegebene Saetze durch", () => {
    expect(clampTaxRate(10, [0, 7, 10, 19])).toBe(10);
  });
  it("faellt auf den hoechsten freigegebenen Satz zurueck, wenn der Wert unbekannt ist", () => {
    expect(clampTaxRate(10, [0, 7, 19])).toBe(19);
    expect(clampTaxRate(Number.NaN, [0, 7, 19])).toBe(19);
  });
  it("ohne Liste gilt weiterhin 19/7/0", () => {
    expect(clampTaxRate(7, [])).toBe(7);
    expect(clampTaxRate(10, [])).toBe(19);
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/editor-tax-rates.test.ts`.

- [ ] **Step 3: Editor-Helfer**

```ts
// src/lib/editor/constants.ts (ersetzt TAX_RATE_OPTIONS)
/** Phase 12c — die Auswahl kommt aus DocumentSettings.taxRates (Server-Prop bis in die
 *  Zeile), nicht mehr aus einer festen Union. `FALLBACK_TAX_RATES` deckt nur den Fall ab,
 *  dass eine Seite die Liste (noch) nicht durchreicht. */
export const FALLBACK_TAX_RATES: readonly number[] = [19, 7, 0];

export function taxRateOptions(rates: readonly number[]): { value: number; label: string }[] {
  const source = rates.length > 0 ? rates : FALLBACK_TAX_RATES;
  return [...new Set(source)].sort((a, b) => b - a).map((value) => ({ value, label: `${value}%` }));
}
```
```ts
// src/lib/editor/draft.ts (ersetzt narrowTaxRate)
/** Phase 12c — haelt einen Satz in der org-eigenen Liste. Unbekannte Werte (z. B. aus einem
 *  Produktstamm, dessen Satz inzwischen entfernt wurde) fallen auf den hoechsten
 *  freigegebenen Satz zurueck; Zod/assertAllowedTaxRates entscheiden beim Speichern. */
export function clampTaxRate(n: number, allowed: readonly number[]): number {
  const list = allowed.length > 0 ? allowed : FALLBACK_TAX_RATES;
  return list.includes(n) ? n : Math.max(...list);
}
```
`DraftLine.taxRate` wird `number`. `draft.ts:260` (`applyProduct`) und `:556` (`draftFrom…`) bekommen die erlaubten Sätze: der Reducer kennt sie nicht, deshalb wandern beide Aufrufe auf `clampTaxRate(value, state.allowedTaxRates)` — `DraftState` bekommt dafür das Feld `allowedTaxRates: number[]`, gesetzt von `emptyDraft(mode, opts)` und den `draftFrom…`-Funktionen. `RecipientBlock.tsx:66` nutzt `clampTaxRate(l.taxRate, draft.allowedTaxRates)`.

- [ ] **Step 4: Prop-Kette und Formulare**
  - `DocumentEditor`: Prop `taxRates: number[]`; beim Aufbau des Anfangszustands in `allowedTaxRates` schreiben und an `LineItemsEditor` weiterreichen.
  - `LineItemsEditor` → `LineRow`: Prop durchreichen; `LineRow` ersetzt `TAX_RATE_OPTIONS` durch `taxRateOptions(taxRates)` und `toTaxRate(v)` durch `clampTaxRate(Number(v), taxRates)`.
  - `NewProductDialog.tsx:112`: `<select>` aus `taxRateOptions(taxRates)`; `useState(taxRate)` startet auf `Math.max(...taxRates)`.
  - Die fünf Editor-Seiten reichen `taxRates={documentSettings.taxRates}` durch (in `rechnungen/neu/page.tsx` liegt `documentSettings` bereits vor, Z. 47; in den übrigen vier ggf. `loadDocumentSettings(orgId)` zum bestehenden `Promise.all` hinzufügen — **erst prüfen, ob es schon geladen wird**).
  - `TaxRatesField.tsx` (Client, ~70 Zeilen): Chip-Liste mit „×"-Knopf je Satz, Zahlenfeld (0–100, `step={1}`) + „Hinzufügen", 1–10 Einträge, Hinweistext „Bereits ausgestellte Belege behalten ihren Satz." Der Zustand landet in einem `<input type="hidden" name="taxRates" value={JSON.stringify(rates)} />` innerhalb des bestehenden `<form action={action}>` von `DocumentSettingsForm`.
  - `DocumentSettingsForm.tsx`: neue `<section>` „Steuersätze" nach „Rechnungen" mit `<TaxRatesField initial={settings.taxRates} />`.
  - `src/app/actions/document-settings.ts`: `taxRates: parseTaxRatesField(fd.get("taxRates"))` im `raw`-Objekt — ein kleiner Helfer in derselben Datei, der den JSON-String liest und bei Fehler `undefined` zurückgibt (dann greift der Zod-Default). Die Fehlermeldung aus `taxRatesSchema` erreicht das Formular über den bestehenden `firstError`-Pfad.

- [ ] **Step 5: MCP**
  - `src/mcp/tools/invoices.ts:63` und `:582`, `src/mcp/tools/products.ts:122`, `src/mcp/tools/context.ts:258`: `z.union([z.literal(19), z.literal(7), z.literal(0)]).optional()` → `TaxRate.optional()` (Import aus `@/schemas` ergänzen, in `products.ts` bereits vorhanden).
  - `src/mcp/tools/context.ts:177,243` und `invoices.ts:115`: der Fallback `?? 19` bleibt (Regelsatz), bekommt aber den Kommentar „Phase 12c: Fallback bleibt 19 — assertAllowedTaxRates entscheidet, ob der Satz freigegeben ist".
  - `src/mcp/tools/products.ts:78,92`: `TaxRate.default(19)` bleibt gültig (Typ ist jetzt `number`).
  - `src/mcp/tools/settings.ts`: Beschreibung von `update_document_settings` um „…, freigegebene Steuersaetze (taxRates, ganze Prozentwerte 0-100, 1-10 Eintraege)" ergänzen. `partialInputShape(documentSettingsInputSchema)` nimmt das neue Feld automatisch auf; `get_settings {area:"documents"}` liefert es ebenfalls ohne Änderung.

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build`
```bash
git add src/lib/editor src/components/editor src/components/settings/TaxRatesField.tsx src/components/forms/DocumentSettingsForm.tsx src/app src/mcp test/unit/editor-tax-rates.test.ts
git commit -s -m "feat(steuersaetze): Editor, Einstellungen -> Belege und MCP nutzen die org-eigene Liste (Phase 12c, Task 6)"
```

---

### Task 7: Doku, Playwright-Smoke, Gesamtprüfung

**Files:** `docs/ANLEITUNG.md`, `docs/LIMITATIONEN.md`, `docs/ARCHITEKTUR.md`, `docs/MCP.md`, `docs/API.md`, `COMPLIANCE.md`, `.env.example` (`SOURCE_URL`)

- [ ] **Step 1: Doku schreiben** (Code schlägt Doku — jede Formulierung gegen die Implementierung prüfen)
  - **ANLEITUNG:** neuer Abschnitt „Marke" (Einstellungen → Marke: Name max. 40, Kurzname max. 12, Favicon quadratisches PNG 32–512 px/max. 512 KB, Logo PNG/JPEG max. 1 MB; die Herkunftszeile bleibt) und im Belege-Abschnitt „Steuersätze" (Liste 1–10 ganze Prozentwerte, Default 19/7/0, bereits ausgestellte Belege behalten ihren Satz, Fehlermeldung beim Speichern eines Entwurfs mit gesperrtem Satz).
  - **LIMITATIONEN:** vier Sätze — (1) „Steuersätze sind auf ganze Prozentwerte 0–100 beschränkt; Dezimalsätze (z. B. 5,5 % FR) sind nicht abbildbar, weil alle `taxRate`-Spalten `Int` sind." (2) „Kundenspezifische Steuersätze gibt es nicht — die Liste gilt org-weit." (3) „Das Favicon muss ein quadratisches PNG sein; SVG ist bewusst nicht erlaubt (same-origin ausgeliefertes SVG ist ein XSS-Vektor)." (4) „Die AGPL-Herkunftszeile ist nicht abschaltbar."
  - **ARCHITEKTUR:** `src/domain/settings/brand.ts` und `src/domain/settings/tax-rates.ts` in die Modulübersicht; den Satz zur festen `19|7|0`-Union streichen (`grep -n "19|7|0\|19/7/0" docs/ARCHITEKTUR.md` und jede Fundstelle prüfen).
  - **MCP.md:** `update_document_settings` um `taxRates` ergänzen.
  - **API.md:** `/api/v1/Settings` — `documents.taxRates` und `branding.appName/appShortName/faviconPath/appLogoPath` nennen; Hinweis, dass ein nicht freigegebener Satz mit 409 CONFLICT abgelehnt wird.
  - **COMPLIANCE.md:** im AGPL-Abschnitt (§13) einen „Umsetzung dieser Software"-Absatz: Produktname überschreibbar, Herkunftsangabe + Quellcode-Link fest, Quelle `SOURCE_URL`.
  - `.env.example`: `SOURCE_URL=` mit Kommentar.

- [ ] **Step 2: Playwright-Smoke** (Skill `webapp-testing`; `npm run dev` im Vordergrund, Seed-Login `admin@example.com` / `demo1234`; Screenshots nach `<scratchpad>/ui-previews/12c-*.png`):
  1. Einstellungen → Marke: Name „Muster Rechnungen", Kurzname „MR", Favicon 128×128-PNG hochladen, speichern → Sidebar, Topbar und Browser-Tab zeigen den neuen Namen, das Icon wechselt (Tab-Titel per `page.title()` protokollieren).
  2. Abmelden → Login-Seite zeigt „Muster Rechnungen" **und** in der Fußzeile „powered by OpenInvoice Germany · AGPL-3.0" mit funktionierendem Quellcode-Link.
  3. Einstellungen → Belege → Steuersätze: 10 hinzufügen, speichern; neue Rechnung → USt-Auswahl enthält 19/10/7/0; Position mit 10 % speichern und festschreiben.
  4. 10 wieder entfernen; den festgeschriebenen Beleg öffnen → PDF zeigt weiterhin 10 %; einen neuen Entwurf mit 10 % anlegen → Fehlermeldung „Steuersatz 10 % ist für diese Organisation nicht freigegeben (Einstellungen → Belege)."
  5. Konsolenfehler protokollieren; kein CI-Gate.

- [ ] **Step 3: Gesamtprüfung** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check`, dazu `bash scripts/test-postgres-migrations.sh`.

- [ ] **Step 4: Commit**
```bash
git add docs COMPLIANCE.md .env.example
git commit -s -m "docs(marke,steuersaetze): Anleitung, Limitationen, Architektur, MCP/API und COMPLIANCE nachgefuehrt (Phase 12c, Task 7)"
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. **Marke vollständig:** `grep -rn "OpenInvoice" src/ --exclude-dir=generated` liefert nur noch die bewusst festen Stellen — `api/openapi.ts:459/462`, `app/api/docs/route.ts:23`, `mcp/server.ts:3`, `mcp/tools/context.ts:2`, `app/page.tsx:40` (Marketing) sowie die AGPL-Zeile und die Vorgabewerte in `domain/settings/brand.ts`. Kein Literal mehr in `layout.tsx`, `Sidebar`, `Topbar`, `SlimShell`, `AppShell`, `AuthForm`, `email/settings.ts`, `webhook/actions.ts`, `notifications/job.ts`.
2. **AGPL:** Die Herkunftszeile steht in **beiden** Hüllen im gerenderten HTML, auch mit gesetztem `appName` (Testfall vorhanden), und hat keinen Schalter. `SOURCE_URL` ist konfigurierbar, die Zeile selbst nicht.
3. **Öffentliche Routen:** `/api/branding/icon` und `/api/branding/appLogo` liefern **nur** Favicon/Logo; kein Pfad, keine Org-Kennung, keine Personendaten in der Antwort. `isPublicPath("/api/brandingfoo")` ist `false` (exakt-oder-Slash). `cache-control: public, max-age=300` — bewusst kein `private`, weil die Assets nicht personenbezogen sind.
4. **Upload:** `favicon` akzeptiert ausschließlich quadratisches PNG 32–512 px ≤ 512 KB; `applogo` PNG/JPEG ≤ 1 MB; kein SVG. `KIND_FIELD` ersetzt beide ternären Feldzuweisungen (POST **und** DELETE) — ein `kind=favicon`-DELETE setzt `faviconPath` und nicht `backgroundPath`.
5. **Steuersätze — kein Bypass:** `grep -rn "assertAllowedTaxRates" src/` zeigt Aufrufe **nur** in `src/domain/**`, nirgends in `src/app/api/**` oder `src/components/**`. Alle drei `…WithinTx`-Kerne, beide `update…`-Funktionen, `createRecurring`/`updateRecurringInvoice` und `createProduct`/`updateProduct` sind abgedeckt.
6. **Steuersätze — GoBD:** Der Integrationstest belegt, dass ein festgeschriebener Beleg mit einem später entfernten Satz unverändert bleibt und dass ein Entwurf mit diesem Satz weiter bearbeitbar ist (`existing`), während ein **neuer** Beleg abgelehnt wird. Die fünf abgeleiteten Aufrufer reichen `inheritedTaxRates` durch — Duplizieren/Konvertieren eines Altbelegs schlägt nicht fehl.
7. **Typen:** kein `any`; `DraftLine.taxRate` ist `number`, `narrowTaxRate`/`toTaxRate`/`TAX_RATE_OPTIONS` existieren nicht mehr (`grep -rn "narrowTaxRate\|TAX_RATE_OPTIONS\|19 | 7 | 0" src/` ist leer); der Cast in `convert.ts:229` ist weg.
8. **Zod:** `taxRatesSchema` ist ein reines `z.array(...)` ohne `.transform` (sonst bricht `partialInputShape`/zod-to-openapi); die Normalisierung passiert in `saveDocumentSettings`. `saveDocumentSettings` spreizt `taxRates` **nicht** in Prisma (`taxRatesJson`).
9. **Migrationen:** beide Paare wirkungsgleich; `schema.prisma` und `schema.postgres.prisma` unterscheiden sich weiterhin nur in der `provider`-Zeile (CI `schema-drift`); Fall 9 schließt **beide** neuen Migrationen aus; Fälle 18/19 prüfen NULL-Marken-Spalten bzw. Default `[19,7,0]` und je 43 Tabellen (keine neue Tabelle in 12c).
10. **Schnittstellen:** `openapi/openapi.json` regeneriert (`npm run api:check` grün); `/api/v1/Settings` liefert `documents.taxRates` und die vier Marken-Felder; MCP `get_settings`/`update_document_settings` ebenso; ein gesperrter Satz kommt als 409 CONFLICT (Registry-Eintrag in `errors.ts`).
11. **Bestandstests:** die 74 Testdateien mit `taxRate: 19|7|0` laufen unverändert (die neue `TaxRate` ist eine Obermenge); `test/unit/nav.test.ts` (Duplikat-/Key-Prüfung) und `test/integration/settings-consumption.test.ts` bleiben grün.
12. **Smoke:** Screenshots zeigen den geänderten Namen in Sidebar/Topbar/Tab, das neue Favicon, die sichtbare AGPL-Zeile und die Steuersatz-Chips. Betreiberfrage: „Stimmen Name, Favicon und die freigegebenen Steuersätze?"
