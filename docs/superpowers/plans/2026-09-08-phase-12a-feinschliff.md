# Phase 12a — Feinschliff: Eingabefelder, Vorschau, Logo, GiroCode, Dialoge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die vom Betreiber benannten Bedienungsmängel beheben: Kopf-/Fußtext-Felder zu klein, Vorschau zu schmal, Firmenlogo im PDF zu klein und ohne Höhenbegrenzung, GiroCode zu groß (30 mm fest verdrahtet), Bestätigungsdialoge nicht mittig. Keine Fachlogik, keine Rechtsfolge — Oberfläche plus ein neues, einfrierbares Druckoptionen-Feld `giroSizeMm`.

**Architecture:** Vier isolierte Eingriffe. (1) Eine CSS-Regel in `src/app/globals.css` repariert **alle** nativen `<dialog>` gleichzeitig (Ursache: Tailwind-v4-Preflight `*{margin:0}` schlägt die UA-Regel `dialog{margin:auto}`), dazu eine gemeinsame `ConfirmDialog`-Komponente für die zwei echten Bestätigungsdialoge. (2) Kopf-/Fußtext bekommen volle Breite, acht Zeilen und einen Zeichenzähler aus reinen Helfern in `src/lib/editor/constants.ts`. (3) Logo: die drei Zeichenorte nutzen `fit` statt `width`/fester Höhe, Zod-Obergrenze 100 → 140 mm, `BrandingForm` bekommt einen Schieberegler. (4) `giroSizeMm` wird ein echtes Druckoptionen-Feld (Prisma, Zod, `printOptionFields` ⇒ automatisch Teil von Override **und** `freezePrintOptionsJson`).

**Tech Stack:** Next.js App Router, Tailwind v4 (CSS-first, keine `tailwind.config.*`), Prisma (SQLite + Postgres), Zod, pdfkit, Vitest (`environment: "node"`, **kein RTL** ⇒ keine Komponententests), Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-08-phase-12-feinschliff-design.md` — Paket **A** (Abschnitt 2: „Kopf-/Fußtext-Felder", „Vorschau-Breite", „Logo-Größe", „GiroCode-Größe", „Dialog-Zentrierung"), Struktur Abschnitt 3 Block A, Tests Abschnitt 4 A, Teilphase 1 in Abschnitt 5, Ruling am Dateiende (GiroCode-Standard 22 mm gilt auch für festgeschriebene Belege ohne eingefrorenen Wert).

## Global Constraints

- Branch `phase-12a/feinschliff` aus Fork-`main` (9420a20 oder neuer). Jeder Commit mit `git commit -s`.
- Keine neue Abhängigkeit, keine Binärdatei im Repository (es gibt heute keine: `find . -name "*.png" -not -path "./node_modules/*"` ist leer).
- GoBD: `giroSizeMm` wird über `printOptionFields` automatisch von `freezePrintOptionsJson` eingefroren. Bestandsbelege ohne eingefrorenen Wert rendern künftig mit 22 mm statt 30 mm (Spec-Ruling: Druckoptionen sind Darstellung) — gehört nach `docs/LIMITATIONEN.md`. `setPrintOptions` bleibt unverändert (nur DRAFT).
- Zod an der Boundary: `giroSizeMm` nur über `printSettingsInputSchema`/`printOptionsOverrideSchema`, `logoWidthMm` nur über `brandingSettingsInputSchema` (beide `src/schemas/settings.ts`). Keine UI-eigene Validierung als einzige Schranke.
- TypeScript strict, kein `any`. Dateien ≤ ~250 Zeilen. Deutsche UI-Texte mit echten Umlauten.
- Nichts doppelt bauen (§1.4): `inputCls`, `EditorField`, `PrintSettingsForm`, `PrintOptionsPanel`, `BrandingForm`, `effectivePrintOptions`, `freezePrintOptionsJson` werden erweitert, nicht kopiert.
- Migration (§53): Paar `prisma/migrations/…_phase12a_giro_size` **und** `prisma/migrations-postgres/…_phase12a_giro_size`; beide Schemadateien gepflegt (CI `schema-drift`); `scripts/test-postgres-migrations.sh` erweitert. Anwenden mit `npx prisma migrate deploy` (nicht `npm run db:migrate` — interaktiv).
- Prüfkette vor jedem Commit **im Vordergrund**: `npm run typecheck && npm run lint && TZ=UTC npm test`. Vor dem letzten Commit zusätzlich `npm run build`, `npm run validate:erechnung`, `npm run api:check`. Alle Bestandstests bleiben grün (§1.7).

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/app/globals.css` | `dialog:modal { margin:auto; max-height; max-width }` — repariert alle neun `<dialog>`-Dateien |
| `src/components/ui/ConfirmDialog.tsx` | neu — gemeinsame Bestätigung (`onConfirm`- oder `confirmHref`-Variante) |
| `src/components/editor/blocks/EditorHeader.tsx` | Verlassen-Bestätigung über `ConfirmDialog` (Href-Variante) |
| `src/components/AttachmentPanel.tsx` | Löschen-Bestätigung über `ConfirmDialog` (Callback-Variante) |
| `SendEmailDialog`, `ConvertMenu` (2×), `ShareLinkPanelClient`, `DocumentActions`, `dunning/PauseDialog`, `editor/NewProductDialog`, `editor/NewCustomerDialog` | Formular-Dialoge: nur `w-full max-w-*` vereinheitlicht |
| `test/unit/dialogs.test.ts` | Strukturtest: CSS-Regel vorhanden, jeder `<dialog>` trägt `w-full max-w-` |
| `src/lib/editor/constants.ts` | `LONG_TEXT_MAX`, `charCountLabel`, `charCountTone`, `previewPanelClass`, `PREVIEW_WIDE_KEY` |
| `src/components/editor/CharCount.tsx` | neu — Zeichenzähler-Zeile |
| `src/components/editor/blocks/{HeadTextBlock,FootTextBlock}.tsx` | `w-full`, `rows={8}`, `min-h-40 resize-y leading-relaxed`, `CharCount` |
| `src/components/editor/blocks/PreviewSheet.tsx` | Panelbreite 1100 px + Umschalter „Breit/Schmal" (`localStorage`) |
| `src/lib/pdf/layout.ts` | `LOGO_MAX_HEIGHT_MM`, `drawLogo` mit `fit` (genutzt von standard, schlicht, blau, schwarz, kompakt) |
| `src/lib/pdf/layouts/modern.ts` | Logo skaliert mit `logoWidthMm` statt fester 12 mm |
| `src/lib/pdf/layouts/klassik.ts` | dritter Logo-Zeichenort — ebenfalls auf `fit` |
| `src/schemas/settings.ts` | `logoWidthMm` max 140, `giroSizeMm` in `printOptionFields`/`PRINT_OPTION_DEFAULTS`, `PrintBooleanKey` |
| `prisma/schema.prisma`, `prisma/schema.postgres.prisma` | `PrintSettings.giroSizeMm Int @default(22)` |
| `prisma/migrations{,-postgres}/…_phase12a_giro_size/migration.sql` | DDL |
| `src/domain/settings/print.ts` | `loadPrintSettings` liest `giroSizeMm` |
| `src/lib/pdf/invoice-pdf.ts` | `GIRO_SIZE_MM` entfällt, beide Stellen lesen `theme.options.giroSizeMm` |
| `src/components/settings/{PrintSettingsForm,BrandingForm}.tsx`, `src/components/PrintOptionsPanel.tsx` | Zahlenfeld `giroSizeMm`, Logo-Schieberegler |
| `src/mcp/tools/settings.ts:91` | Beschreibung `update_print_settings` |
| `test/helpers/pdf-theme.ts` | `testPngBuffer(w, h)` — Test-Logo ohne neue Abhängigkeit |
| `scripts/test-postgres-migrations.sh` | Fall 9 Ausschluss-Regex, neuer Fall 16 |
| `test/unit/print-options.test.ts`, `test/integration/pdf-theme.test.ts` | Zod/Freeze/Effective + PDF |
| `docs/{ANLEITUNG,LIMITATIONEN,ARCHITEKTUR,MCP}.md` | Doku |

---

### Task 1: Dialog-Zentrierung (`dialog:modal`) und `ConfirmDialog`

**Files:**
- Create: `src/components/ui/ConfirmDialog.tsx`, `test/unit/dialogs.test.ts`
- Modify: `src/app/globals.css`, `src/components/editor/blocks/EditorHeader.tsx:95,146-172`, `src/components/AttachmentPanel.tsx:151`, `src/components/editor/NewProductDialog.tsx:75`, `src/components/editor/NewCustomerDialog.tsx:88` (Breiten prüfen/ergänzen)

**Ruling (Abweichung von der Spec, begründet):** Die Spec nennt `EditorHeader`, `dunning/PauseDialog`, `ConvertMenu` und `DocumentActions` als `ConfirmDialog`-Kandidaten. Im Code sind aber nur **zwei** echte Bestätigungsdialoge: `EditorHeader` (Text + Abbrechen/Verlassen-Link) und `AttachmentPanel:151` (Löschen-Bestätigung, Modulkommentar Z. 5: „Loeschen ueber ein <dialog>-Confirm"). `PauseDialog` (Datum + Notiz), `DocumentActions:137` (Notiz-Textarea) und beide `ConvertMenu`-Dialoge (`:346`, `:417`, Mengen-/Betragsformulare) sind Formulardialoge — eine Umstellung würde Eingabefelder verlieren. Sie behalten ihr `<dialog>`; damit gilt die Spec-Regel „Dialoge mit eigenem Formular behalten ihr `<dialog>`" konsistent für alle sieben.

**Interfaces:**
```tsx
export interface ConfirmDialogHandle { open: () => void; close: () => void }
type ConfirmDialogProps = { title?: string; message: string; confirmLabel: string; cancelLabel?: string; tone?: "default" | "danger" }
  & ({ onConfirm: () => void; confirmHref?: never } | { confirmHref: string; onConfirm?: never });
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/dialogs.test.ts
/**
 * Phase 12a, Task 1 — Strukturtest (kein RTL, vitest environment "node"; Muster:
 * test/unit/dockerfile.test.ts). (1) Die Regel, die das Tailwind-v4-Preflight
 * (`*{margin:0}`) fuer `dialog:modal` zuruecknimmt, muss in globals.css stehen.
 * (2) Jedes native <dialog> traegt eine Breitenklasse.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("Dialog-Zentrierung (Phase 12a)", () => {
  it("globals.css nimmt das Preflight fuer dialog:modal zurueck", () => {
    const css = readFileSync(path.join(SRC, "app/globals.css"), "utf8");
    expect(css).toMatch(/dialog:modal\s*\{[^}]*margin:\s*auto/);
    expect(css).toMatch(/dialog:modal\s*\{[^}]*max-height:\s*calc\(100dvh - 2rem\)/);
    expect(css).toMatch(/dialog:modal\s*\{[^}]*max-width:\s*calc\(100vw - 2rem\)/);
  });

  it("jedes <dialog> traegt w-full und eine max-w-Klasse", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(/<dialog\b[\s\S]{0,400}?>/g)) {
        const tag = m[0];
        if (!/className="[^"]*\bw-full\b/.test(tag) || !/className="[^"]*\bmax-w-/.test(tag)) {
          offenders.push(`${path.relative(SRC, file)}: ${tag.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/dialogs.test.ts`; erwartet FAIL (CSS-Regel fehlt; `AttachmentPanel`/`EditorHeader` ohne Breitenklasse).

- [ ] **Step 3: CSS-Regel** — an `src/app/globals.css` (heute 13 Zeilen) anhängen:

```css
/*
 * Phase 12a — native <dialog> wieder zentrieren. Das Tailwind-v4-Preflight
 * (node_modules/tailwindcss/preflight.css, Z. 7-16) setzt `margin: 0` auf
 * `*, ::after, ::before, ::backdrop, ::file-selector-button` und ueberschreibt damit
 * die UA-Regel `dialog { margin: auto }` — jeder showModal()-Dialog klebte oben links.
 * `dialog:modal` (0,1,1) schlaegt den Universalselektor (0,0,0).
 */
dialog:modal {
  margin: auto;
  max-height: calc(100dvh - 2rem);
  max-width: calc(100vw - 2rem);
}
```

- [ ] **Step 4: `ConfirmDialog` schreiben**

```tsx
// src/components/ui/ConfirmDialog.tsx
"use client";

/**
 * Gemeinsame Bestaetigung fuer <dialog>-Dialoge OHNE eigenes Formular (Phase 12a).
 * Zwei per Typ-Union getrennte Varianten: `onConfirm` (Rueckruf) oder `confirmHref`
 * (next/link-Ziel, Editor "Trotzdem verlassen?"). Die Zentrierung kommt aus der
 * globalen Regel `dialog:modal { margin: auto }` — hier nicht nachgebaut.
 * Escape schliesst nativ; der Fokus landet beim Oeffnen auf "Abbrechen".
 */
import Link from "next/link";
import { forwardRef, useImperativeHandle, useRef } from "react";

export interface ConfirmDialogHandle {
  open: () => void;
  close: () => void;
}

type ConfirmDialogProps = {
  title?: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
} & ({ onConfirm: () => void; confirmHref?: never } | { confirmHref: string; onConfirm?: never });

const TONE_CLS: Record<"default" | "danger", string> = {
  default: "bg-indigo-600 hover:bg-indigo-700",
  danger: "bg-rose-600 hover:bg-rose-700",
};

export const ConfirmDialog = forwardRef<ConfirmDialogHandle, ConfirmDialogProps>(function ConfirmDialog(
  { title, message, confirmLabel, cancelLabel = "Abbrechen", tone = "default", onConfirm, confirmHref },
  ref,
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    open: () => {
      dialogRef.current?.showModal();
      cancelRef.current?.focus();
    },
    close: () => dialogRef.current?.close(),
  }));

  const confirmCls = `rounded-md px-3 py-1.5 text-sm font-medium text-white ${TONE_CLS[tone]}`;

  return (
    <dialog ref={dialogRef} className="w-full max-w-sm rounded-lg border border-slate-200 p-0 backdrop:bg-slate-900/40">
      <div className="space-y-3 p-5">
        {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
        <p className="text-sm text-slate-700">{message}</p>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={() => dialogRef.current?.close()} className="text-sm text-slate-500 hover:text-slate-800">
            {cancelLabel}
          </button>
          {confirmHref ? (
            <Link href={confirmHref} className={confirmCls} onClick={() => dialogRef.current?.close()}>
              {confirmLabel}
            </Link>
          ) : (
            <button type="button" className={confirmCls} onClick={() => { dialogRef.current?.close(); onConfirm?.(); }}>
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
});
```

- [ ] **Step 5: Die zwei echten Bestätigungen umstellen**
  - `EditorHeader.tsx`: `dialogRef` wird `useRef<ConfirmDialogHandle>(null)`; `dialogRef.current?.showModal()` (Z. 95) → `.open()`; der Block Z. 146–172 wird ersetzt durch
    ```tsx
    <ConfirmDialog ref={dialogRef} message="Es gibt ungespeicherte Änderungen. Trotzdem verlassen?" confirmLabel="Verlassen" tone="danger" confirmHref={pendingHref ?? backHref} />
    ```
    `setPendingHref(null)` beim Abbrechen entfällt (beim nächsten Abfangen wird neu gesetzt; ohne Abfangen gilt `backHref`). Der Klick-Abfangjäger Z. 81 (`if (target.closest("dialog")) return;`) greift weiter, weil `ConfirmDialog` ein echtes `<dialog>` rendert — der „Verlassen"-Link fängt sich nicht selbst ab.
  - `AttachmentPanel.tsx:151`: derselbe Austausch mit `onConfirm={() => void remove(pendingId)}`, `tone="danger"`, `confirmLabel="Löschen"`; `message` wortgleich aus dem heutigen Dialogtext übernehmen.

- [ ] **Step 6: Breiten der sieben Formular-Dialoge** — bereits konform (nichts zu tun): `PauseDialog:55` `max-w-sm`, `DocumentActions:137` `max-w-md`, `ConvertMenu:346/417` `max-w-2xl`, `SendEmailDialog:240` `max-w-2xl`, `ShareLinkPanelClient:167` `max-w-lg` — jeweils mit `w-full`. Zu prüfen und ggf. um `w-full max-w-lg` zu ergänzen: `NewProductDialog:75` und `NewCustomerDialog:88` (mehrzeiliges `className`, tatsächlichen Wert lesen). Der Test aus Step 1 ist die Abnahme.

- [ ] **Step 7: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/app/globals.css src/components/ui/ConfirmDialog.tsx src/components/AttachmentPanel.tsx src/components/editor test/unit/dialogs.test.ts
git commit -s -m "fix(ui): Dialoge wieder mittig (Tailwind-Preflight), gemeinsamer ConfirmDialog (Phase 12a, Task 1)"
```

---

### Task 2: Kopf-/Fußtext-Felder und Vorschau-Breite

**Files:**
- Modify: `src/lib/editor/constants.ts`, `src/components/editor/blocks/HeadTextBlock.tsx:60`, `.../FootTextBlock.tsx:38`, `.../PreviewSheet.tsx:229`
- Create: `src/components/editor/CharCount.tsx`, `test/unit/editor-text-fields.test.ts`

**Befund (verifiziert):** Beide Blöcke rendern `<textarea className={inputCls} rows={3}>` in einem `div.space-y-1` — **nicht** in `EditorField` (dessen `flex flex-col` die Kinder streckt). `inputCls` (`src/components/forms/fields.tsx:5-6`) enthält **kein** `w-full`, die Textareas sind deshalb nur so breit wie das Browser-Default (`cols=20`). Das ist die eigentliche Ursache von „Kopftext Fußtext der Input zu klein"; `rows` allein hätte es nicht behoben.

**Interfaces:**
```ts
export const LONG_TEXT_MAX = 5000;
export function charCountLabel(value: string, max?: number): string;              // "123 / 5000"
export function charCountTone(value: string, max?: number): "ok" | "warn" | "over";
export function previewPanelClass(wide: boolean): string;
export const PREVIEW_WIDE_KEY = "oig.preview.wide";
```

- [ ] **Step 1: Failing tests schreiben**

```ts
// test/unit/editor-text-fields.test.ts
import { describe, it, expect } from "vitest";
import { LONG_TEXT_MAX, charCountLabel, charCountTone, previewPanelClass, PREVIEW_WIDE_KEY } from "@/lib/editor/constants";

describe("Zeichenzaehler und Vorschau-Breite (Phase 12a)", () => {
  it("Grenze entspricht dem Zod-Maximum von headerText/footerText", () => {
    expect(LONG_TEXT_MAX).toBe(5000); // src/schemas/index.ts:352/353 z.string().max(5000)
  });
  it("Label zeigt Laenge und Grenze", () => {
    expect(charCountLabel("abc")).toBe("3 / 5000");
    expect(charCountLabel("abcde", 10)).toBe("5 / 10");
  });
  it("Ton wechselt ab 90 % und ueber der Grenze", () => {
    expect(charCountTone("a".repeat(10), 100)).toBe("ok");
    expect(charCountTone("a".repeat(90), 100)).toBe("warn");
    expect(charCountTone("a".repeat(101), 100)).toBe("over");
  });
  it("Panelbreite: schmal 1100 px, breit volle Overlay-Breite, beide w-full", () => {
    expect(previewPanelClass(false)).toBe("w-full max-w-[1100px]");
    expect(previewPanelClass(true)).toBe("w-full max-w-none");
    expect(PREVIEW_WIDE_KEY).toBe("oig.preview.wide");
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/editor-text-fields.test.ts`; Exporte fehlen.

- [ ] **Step 3: Helfer in `src/lib/editor/constants.ts` ergänzen**

```ts
/** Phase 12a — Grenze fuer Kopf-/Fusstext. Keine eigene Regel, sondern Spiegel von
 *  `z.string().max(5000)` in `invoiceHeaderFields` (headerText/footerText,
 *  src/schemas/index.ts:352/353); dieselbe Zahl gilt fuer Quote und DeliveryNote. */
export const LONG_TEXT_MAX = 5000;

export function charCountLabel(value: string, max: number = LONG_TEXT_MAX): string {
  return `${value.length} / ${max}`;
}

export function charCountTone(value: string, max: number = LONG_TEXT_MAX): "ok" | "warn" | "over" {
  if (value.length > max) return "over";
  if (value.length >= max * 0.9) return "warn";
  return "ok";
}

/** Panelbreite des Vorschau-Overlays: schmal = eine A4-Seite bei 96 dpi (794 px) mit Rand,
 *  breit = volle Overlay-Breite. `w-full` in beiden Faellen, sonst faellt das Panel auf
 *  schmalen Fenstern auf fit-content zusammen. */
export function previewPanelClass(wide: boolean): string {
  return wide ? "w-full max-w-none" : "w-full max-w-[1100px]";
}

export const PREVIEW_WIDE_KEY = "oig.preview.wide";
```

- [ ] **Step 4: `CharCount` schreiben und beide Textblöcke umstellen**

```tsx
// src/components/editor/CharCount.tsx
"use client";
import { charCountLabel, charCountTone, LONG_TEXT_MAX } from "@/lib/editor/constants";

const TONE_CLS = { ok: "text-slate-400", warn: "text-amber-600", over: "text-rose-600" } as const;

/** Zeichenzaehler unter einem Langtextfeld (Phase 12a). Rein anzeigend — die harte
 *  Grenze setzt Zod beim Speichern (headerText/footerText max. 5000). */
export function CharCount({ value, max = LONG_TEXT_MAX }: { value: string; max?: number }) {
  return (
    <p className={`text-right text-xs ${TONE_CLS[charCountTone(value, max)]}`} aria-live="polite">
      {charCountLabel(value, max)}
    </p>
  );
}
```

`HeadTextBlock.tsx:60` (und `FootTextBlock.tsx:38` mit `field: "footerText"`):
```tsx
<textarea
  id={id}
  className={`${inputCls} w-full min-h-40 resize-y leading-relaxed`}
  rows={8}
  maxLength={LONG_TEXT_MAX}
  value={value}
  onChange={(e) => dispatch({ type: "set", field: "headerText", value: e.target.value })}
/>
<CharCount value={value} />
```
Importe: `LONG_TEXT_MAX` aus `@/lib/editor/constants`, `CharCount` aus `../CharCount`. Kein `field-sizing-content` (nur Chromium).

- [ ] **Step 5: `PreviewSheet` verbreitern und Umschalter ergänzen**

```tsx
import { previewPanelClass, PREVIEW_WIDE_KEY } from "@/lib/editor/constants";

const [wide, setWide] = useState(false);
useEffect(() => {
  try { setWide(window.localStorage.getItem(PREVIEW_WIDE_KEY) === "1"); } catch { /* privater Modus: Default schmal */ }
}, []);
function toggleWide() {
  setWide((w) => {
    const next = !w;
    try { window.localStorage.setItem(PREVIEW_WIDE_KEY, next ? "1" : "0"); } catch { /* ignorieren */ }
    return next;
  });
}
```
Z. 229 `className="relative flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl"` →
`` className={`relative flex h-full flex-col bg-white shadow-2xl ${previewPanelClass(wide)}`} ``.
In der Kopfzeile neben „Neu laden", vor dem Schließen-Knopf:
```tsx
<button type="button" onClick={toggleWide} aria-pressed={wide} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
  {wide ? "Schmal" : "Breit"}
</button>
```
Der `iframe` bleibt unverändert; `wide` kommt **nicht** in den Deps-Array des Vorschau-Fetch-Effekts (Z. 216) — die Breite löst kein Neuladen aus.

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/lib/editor/constants.ts src/components/editor test/unit/editor-text-fields.test.ts
git commit -s -m "feat(editor): Kopf-/Fusstext ueber volle Breite mit Zeichenzaehler, breitere Vorschau mit Umschalter (Phase 12a, Task 2)"
```

---

### Task 3: Logo-Höhenbegrenzung und konfigurierbarer GiroCode

**Files:**
- Modify: `prisma/schema.prisma:999-1015` + `prisma/schema.postgres.prisma` (`model PrintSettings`), `src/schemas/settings.ts:26-52,82`, `src/domain/settings/print.ts:16-31`, `src/lib/pdf/layout.ts:41-45`, `src/lib/pdf/layouts/modern.ts:22`, `src/lib/pdf/layouts/klassik.ts:14`, `src/lib/pdf/invoice-pdf.ts:68,463,469,555,561,564`, `src/components/settings/{PrintSettingsForm,BrandingForm}.tsx`, `src/components/PrintOptionsPanel.tsx`, `src/mcp/tools/settings.ts:91`, `test/helpers/pdf-theme.ts`, `test/integration/pdf-theme.test.ts`, `scripts/test-postgres-migrations.sh:241` + Ende
- Create: `prisma/migrations/20260908090000_phase12a_giro_size/migration.sql`, `prisma/migrations-postgres/20260908090100_phase12a_giro_size/migration.sql`, `test/unit/print-options.test.ts`

**Befund (verifiziert):** Das Logo wird an **drei** Stellen gezeichnet, nicht an zweien wie in der Spec: `layout.ts:44` (`drawLogo`, genutzt von `standard`, `schlicht` und den drei `styledLayout`-Varianten `blau`/`schwarz`/`kompakt` über `shared.ts:152`), `modern.ts:22` (feste `height: mm(12)`, ignoriert `logoWidthMm`), `klassik.ts:14` (eigenes `doc.image(..., { width })` ohne Höhengrenze). `styled.ts` zeichnet selbst kein Logo (es spreadet `standardLayout`).

**Interfaces:**
```ts
export const LOGO_MAX_HEIGHT_MM = 35;                                   // src/lib/pdf/layout.ts
// src/schemas/settings.ts: printOptionFields.giroSizeMm = z.coerce.number().int().min(15).max(40)
//                          PRINT_OPTION_DEFAULTS.giroSizeMm = 22, logoWidthMm .min(10).max(140)
export type PrintBooleanKey = Exclude<keyof PrintSettingsInput, "giroSizeMm">;
```

- [ ] **Step 1: Failing tests schreiben**

```ts
// test/unit/print-options.test.ts
/** Phase 12a, Task 3 — giroSizeMm als vollwertige Druckoption (Zod, Merge, Einfrieren). */
import { describe, it, expect } from "vitest";
import { printSettingsInputSchema, printOptionsOverrideSchema, brandingSettingsInputSchema } from "@/schemas/settings";
import { DEFAULT_PRINT_SETTINGS, effectivePrintOptions, freezePrintOptionsJson } from "@/domain/settings/print";

describe("giroSizeMm (Phase 12a)", () => {
  it("Default 22, Spanne 15..40, nur ganzzahlig", () => {
    expect(printSettingsInputSchema.parse({}).giroSizeMm).toBe(22);
    expect(DEFAULT_PRINT_SETTINGS.giroSizeMm).toBe(22);
    expect(printSettingsInputSchema.parse({ giroSizeMm: 15 }).giroSizeMm).toBe(15);
    expect(printSettingsInputSchema.parse({ giroSizeMm: 40 }).giroSizeMm).toBe(40);
    for (const bad of [14, 41, 22.5]) expect(printSettingsInputSchema.safeParse({ giroSizeMm: bad }).success).toBe(false);
  });
  it("ist ein optionaler Beleg-Override und schlaegt die Organisation", () => {
    expect(printOptionsOverrideSchema.parse({}).giroSizeMm).toBeUndefined();
    const global = { ...DEFAULT_PRINT_SETTINGS, giroSizeMm: 25 };
    expect(effectivePrintOptions(global, null).giroSizeMm).toBe(25);
    expect(effectivePrintOptions(global, JSON.stringify({ giroSizeMm: 35 })).giroSizeMm).toBe(35);
  });
  it("wird beim Festschreiben eingefroren", () => {
    const frozen = JSON.parse(freezePrintOptionsJson({ ...DEFAULT_PRINT_SETTINGS, giroSizeMm: 33 }, null, "standard")) as { giroSizeMm: number };
    expect(frozen.giroSizeMm).toBe(33);
  });
  it("logoWidthMm erlaubt jetzt bis 140 mm, Default bleibt 40", () => {
    expect(brandingSettingsInputSchema.parse({}).logoWidthMm).toBe(40);
    expect(brandingSettingsInputSchema.parse({ logoWidthMm: 140 }).logoWidthMm).toBe(140);
    for (const bad of [9, 141]) expect(brandingSettingsInputSchema.safeParse({ logoWidthMm: bad }).success).toBe(false);
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/print-options.test.ts`.

- [ ] **Step 3: Prisma + beide Migrationen**

In **beiden** Schemadateien in `model PrintSettings` nach `showGiroCode`:
```prisma
  /// Phase 12a — Kantenlaenge des GiroCode in mm (15..40, Zod). Teil der Druckoptionen,
  /// wird beim Festschreiben mit eingefroren (freezePrintOptionsJson).
  giroSizeMm         Int          @default(22)
```
Beide `migration.sql` (SQLite und Postgres, inhaltsgleich):
```sql
-- Phase 12a — GiroCode-Groesse als Druckoption (bisher fest 30 mm im Renderer).
-- AlterTable
ALTER TABLE "PrintSettings" ADD COLUMN "giroSizeMm" INTEGER NOT NULL DEFAULT 22;
```
Anwenden: `npx prisma migrate deploy`, danach `npx prisma generate`.

- [ ] **Step 4: Zod, Domain und Renderer**

`src/schemas/settings.ts`:
- `printOptionFields` += `giroSizeMm: z.coerce.number().int().min(15).max(40),` (Kommentar: „unter 15 mm ist der EPC-QR nicht mehr zuverlässig scanbar").
- `PRINT_OPTION_DEFAULTS` += `giroSizeMm: 22,`; `printSettingsInputSchema` += `giroSizeMm: printOptionFields.giroSizeMm.default(PRINT_OPTION_DEFAULTS.giroSizeMm),`.
- Kommentar „Die zehn Druckoptionen-Schalter" → „Die zehn Schalter + die GiroCode-Groesse" (Code schlägt Doku).
- `logoWidthMm: z.coerce.number().int().min(10).max(140).default(40)`.
- Neu: `export type PrintBooleanKey = Exclude<keyof PrintSettingsInput, "giroSizeMm">;`

`printOptionsOverrideSchema` und `freezePrintOptionsJson` brauchen **keine** Änderung (leiten sich aus `printOptionFields` bzw. `Object.keys(DEFAULT_PRINT_SETTINGS)` ab). `src/domain/settings/print.ts`: in `loadPrintSettings` das Objekt um `giroSizeMm: row.giroSizeMm,` ergänzen (`savePrintSettings` spreizt `input`, unverändert).

`src/lib/pdf/layout.ts` Z. 41–45:
```ts
/** Maximale Logo-Hoehe in mm (Phase 12a). `drawLogo` zeichnete bisher nur mit `{ width }`
 *  — ein hohes, schmales Logo wuchs unbegrenzt nach unten und lief in den Adressblock.
 *  `fit` skaliert proportional in die Box [Breite x LOGO_MAX_HEIGHT_MM]; breite/flache
 *  Logos (der Normalfall) rendern unveraendert. */
export const LOGO_MAX_HEIGHT_MM = 35;

export function drawLogo(doc: PDFKit.PDFDocument, theme: PdfTheme, right: number, top: number): void {
  if (!theme.logoBuffer) return;
  const width = mm(theme.brand.logoWidthMm);
  doc.image(theme.logoBuffer, right - width, top, { fit: [width, mm(LOGO_MAX_HEIGHT_MM)], align: "right" });
}
```
`src/lib/pdf/layouts/modern.ts` Z. 22 (bisher `{ height: mm(12) }`, `logoWidthMm` ignoriert):
```ts
      const logoW = mm(theme.brand.logoWidthMm);
      const logoH = barH - mm(4);
      doc.image(theme.logoBuffer, left, (margins.top + barH - logoH) / 2, { fit: [logoW, logoH] });
```
`src/lib/pdf/layouts/klassik.ts` Z. 14 (Import `LOGO_MAX_HEIGHT_MM` aus `../layout` ergänzen):
```ts
    if (theme.logoBuffer) doc.image(theme.logoBuffer, left, margins.top, { fit: [mm(theme.brand.logoWidthMm), mm(LOGO_MAX_HEIGHT_MM)] });
```
`src/lib/pdf/invoice-pdf.ts`: `const GIRO_SIZE_MM = 30;` (Z. 68) löschen; an beiden Fundstellen (Z. 463 ff. „below-totals", Z. 555 ff. Zahlungsblock) `const giroSizeMm = theme.options.giroSizeMm;`, `const giroSize = mm(giroSizeMm);` und `renderGiroCode(doc, payload, { …, sizeMm: giroSizeMm })`. `grep -n "GIRO_SIZE_MM" src/` muss danach leer sein.

- [ ] **Step 5: Oberflächen (drei Formulare)**
  - `PrintSettingsForm.tsx`: `LABELS` auf `Record<PrintBooleanKey, string>` einengen (Import aus `@/schemas`, das `./settings` re-exportiert), `FIELDS` bleibt `Object.keys(LABELS) as PrintBooleanKey[]`. Unter dem Schalter-Raster ein eigenes Feld:
    ```tsx
    <label className="flex max-w-xs flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">GiroCode-Größe (mm)</span>
      <input type="number" min={15} max={40} value={values.giroSizeMm}
        onChange={(e) => setValues((v) => ({ ...v, giroSizeMm: Number(e.target.value) }))}
        className="w-24 rounded border border-slate-300 px-2 py-1" />
      <span className="text-xs text-slate-400">15–40 mm. Unter 15 mm wird der Code unzuverlässig scanbar.</span>
    </label>
    ```
  - `PrintOptionsPanel.tsx`: `LABELS`/`FIELDS` ebenfalls auf `PrintBooleanKey`; `toggleOverride`/`setOverrideValue` bekommen `key: PrintBooleanKey` (Signatur bleibt `boolean`). Darunter eine eigene „abweichend"-Zeile für `giroSizeMm` mit `type="number"` (15–40) und `delete next.giroSizeMm` beim Abwählen.
  - `BrandingForm.tsx:113-121`: Zahlenfeld um einen Schieberegler ergänzen, beide auf denselben Wert gebunden:
    ```tsx
    <div className="flex items-center gap-3">
      <input type="range" min={10} max={140} step={1} value={values.logoWidthMm}
        onChange={(e) => setField("logoWidthMm", Number(e.target.value))} className="w-56" aria-label="Logobreite in Millimeter" />
      <input type="number" min={10} max={140} value={values.logoWidthMm}
        onChange={(e) => setField("logoWidthMm", Number(e.target.value))} className="w-24 rounded border border-slate-300 px-2 py-1" />
    </div>
    <span className="text-xs text-slate-400">10–140 mm; die Höhe wird auf 35 mm begrenzt, damit hohe Logos nicht in den Adressblock laufen.</span>
    ```
    Die bestehende Vorschau (`GET /api/settings/branding/preview`) bleibt unverändert.
  - `src/mcp/tools/settings.ts:91` → `"Aktualisiert die globalen Druckoptionen (§36): zehn Schalter plus die GiroCode-Groesse giroSizeMm (15-40 mm). Nicht angegebene Felder bleiben unveraendert (Merge mit dem aktuellen Stand)."` (`inputSchema` ist `partialInputShape(printSettingsInputSchema)` — das Feld kommt automatisch mit.)

- [ ] **Step 6: Test-Logo-Helfer und PDF-Integrationstests**

An `test/helpers/pdf-theme.ts` anhängen (kein Fixture-Binary, keine neue Abhängigkeit):
```ts
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Einfarbig graues RGB-PNG (Farbtyp 2, 8 bit) — Test-Logo fuer PDF-Renderer-Tests.
 *  Selbst erzeugt statt als Fixture committet: das Projekt hat keine Binaerdateien.
 *  pdfkit (png.js) liest Farbtyp 2 direkt. */
export function testPngBuffer(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 2; // Farbtyp 2 = Truecolour (RGB)
  const stride = 1 + width * 3;             // je Zeile ein Filter-Byte 0 ("None")
  const raw = Buffer.alloc(height * stride, 0x80);
  for (let y = 0; y < height; y++) raw[y * stride] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
```

In `test/integration/pdf-theme.test.ts` Importe erweitern (`testPngBuffer` aus `../helpers/pdf-theme`, `DEFAULT_PRINT_SETTINGS` aus `@/domain/settings/print`, `DEFAULT_BRANDING_SETTINGS` aus `@/domain/settings/branding`) und drei Fälle ergänzen. `baseInvoiceData()` (dort Z. ~51) setzt bereits `iban` und `giroAmountCents = grossTotal`, der GiroCode wird also gezeichnet.
```ts
it("GiroCode folgt giroSizeMm (Phase 12a): 40 mm rendert auf einer Seite", async () => {
  const theme = testPdfTheme({ options: { ...DEFAULT_PRINT_SETTINGS, giroSizeMm: 40 } });
  const parsed = await parsePdf(await renderInvoicePdf(baseInvoiceData(), theme));
  expect(parsed.text).toContain("GiroCode");
  expect(parsed.numpages).toBe(1);
});

it("hohes Logo bei logoWidthMm=140 sprengt die Seite nicht (fit auf 35 mm Hoehe)", async () => {
  const theme = testPdfTheme({ brand: { ...DEFAULT_BRANDING_SETTINGS, logoWidthMm: 140 }, logoBuffer: testPngBuffer(60, 180) });
  const parsed = await parsePdf(await renderInvoicePdf(baseInvoiceData(), theme));
  expect(parsed.numpages).toBe(1);
  expect(parsed.text).toContain("Kunde AG"); // Adressblock nicht vom Logo verdeckt
});

it("modern und klassik skalieren das Logo mit logoWidthMm", async () => {
  for (const layoutId of ["modern", "klassik"] as const) {
    const theme = testPdfTheme({ brand: { ...DEFAULT_BRANDING_SETTINGS, logoWidthMm: 120 }, logoBuffer: testPngBuffer(300, 100), layoutId });
    const parsed = await parsePdf(await renderInvoicePdf(baseInvoiceData(), theme));
    expect(parsed.numpages).toBe(1);
    expect(parsed.text).toContain("Kunde AG");
  }
});
```

- [ ] **Step 7: Postgres-Migrationstest**
  1. Fall 9 (`scripts/test-postgres-migrations.sh:241`): die neue Migration in die Ausschluss-Regex aufnehmen — sie ändert `PrintSettings`, eine Phase-7-Tabelle, die dort absichtlich noch nicht existiert (sonst P1014):
     ```sh
     for MIG in $(ls prisma/migrations-postgres | grep -v -E '^(0_init|migration_lock\.toml|20260904044136_phase7_settings|20260904140030_phase8b_fixwave|20260907075900_phase11b_layouts|20260907090333_phase11b_footermode_backfill|20260908090100_phase12a_giro_size)$' | sort); do
     ```
     Den Kommentar darüber um einen Satz zu Phase 12a ergänzen.
  2. Neuer **Fall 16** am Dateiende (vor `echo "ALLE TESTS BESTANDEN"`), Muster von Fall 15: alle Migrationen außer `20260908090100_phase12a_giro_size` einzeln einspielen, Organisation `org16` + `PrintSettings`-Zeile `ps16` im alten Spaltenumfang anlegen, dann `npx prisma migrate deploy` und prüfen:
     ```sh
     GIRO=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select \"giroSizeMm\" from \"PrintSettings\" where id='ps16'")
     [ "$GIRO" = "22" ] || fail "Bestandszeile ps16: giroSizeMm ist '$GIRO', erwartet Default 22"
     COUNT16=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc "select count(*) from information_schema.tables where table_schema='public'")
     [ "$COUNT16" = "43" ] || fail "erwartet weiterhin 43 Tabellen nach Phase 12a (nur eine Spalte), gefunden $COUNT16"
     echo "    ok — giroSizeMm mit Default 22 auf Bestandszeile, 43 Tabellen"
     ```

- [ ] **Step 8: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run api:check`
`api:check` schlägt an, weil `printSettingsInputSchema` in `/api/v1/Settings` steckt ⇒ `npm run api:check -- --write`, `openapi/openapi.json` mitcommitten, dann `npm run api:check` erneut (grün). Mit Docker zusätzlich `bash scripts/test-postgres-migrations.sh`; sonst im Commit-Text vermerken und im Abschluss-Review nachholen.
```bash
git add prisma src/schemas/settings.ts src/domain/settings/print.ts src/lib/pdf src/components/settings src/components/PrintOptionsPanel.tsx src/mcp/tools/settings.ts scripts/test-postgres-migrations.sh openapi/openapi.json test
git commit -s -m "feat(pdf): GiroCode-Groesse als Druckoption, Logo bis 140 mm mit Hoehenbegrenzung (Phase 12a, Task 3)"
```

---

### Task 4: Doku, Playwright-Smoke, Gesamtprüfung

**Files:** `docs/ANLEITUNG.md` (§ 6), `docs/LIMITATIONEN.md` (Abschnitt „Briefpapier, Druckoptionen, Nummernkreise & GiroCode (Phase 7)"), `docs/ARCHITEKTUR.md` (PDF-Abschnitt), `docs/MCP.md:197`

- [ ] **Step 1: Doku schreiben** (Code schlägt Doku — jede Formulierung gegen die Implementierung prüfen)
  - ANLEITUNG § 6: Absatz „GiroCode-Größe" (Einstellungen → Briefpapier → Druckoptionen, 15–40 mm, Standard 22 mm, je Beleg im Entwurf überschreibbar) und „Logogröße" (Schieberegler 10–140 mm, Höhe automatisch auf 35 mm begrenzt).
  - LIMITATIONEN, Phase-7-Abschnitt, drei Sätze: (1) „GiroCode-Standard 22 mm wirkt auch auf bereits festgeschriebene Belege, sofern beim Festschreiben noch kein Wert eingefroren wurde (Druckoptionen sind Darstellung, Phase-7-Ruling) — vor Phase 12a gedruckte Belege hatten 30 mm." (2) „Die Logohöhe ist auf 35 mm begrenzt; höhere Logos werden proportional verkleinert." (3) „Die Vorschau-Breite (Breit/Schmal) liegt im `localStorage` des Browsers und gilt nicht geräteübergreifend."
  - ARCHITEKTUR: `LOGO_MAX_HEIGHT_MM` und `theme.options.giroSizeMm` erwähnen; `grep -n "30 mm" docs/ARCHITEKTUR.md` und jede Fundstelle korrigieren.
  - MCP.md:197: `update_print_settings`-Zeile um „GiroCode-Größe (15–40 mm)" ergänzen.

- [ ] **Step 2: Playwright-Smoke** (Skill `webapp-testing`; `npm run dev` im Vordergrund, Seed-Login `admin@example.com` / `demo1234`; Screenshots nach `<scratchpad>/ui-previews/12a-*.png`):
  1. `/rechnungen/neu` → Kopf-/Fußtextfeld füllt die Kartenbreite, acht Zeilen, Zeichenzähler zählt mit.
  2. Vorschau öffnen → deutlich breiteres Panel; „Breit" umschalten → volle Breite; Seite neu laden → Zustand bleibt.
  3. Im Editor etwas ändern, Sidebar-Link klicken → Bestätigungsdialog **mittig** (Abstand oben ≈ unten ± 8 px, per `boundingBox()` gegen `viewportSize()` messen und protokollieren).
  4. `/mahnwesen` → „Pausieren" → mittig. Beleg-Detailseite → „Mehr" → „Lieferschein erzeugen" → mittig.
  5. Einstellungen → Briefpapier: Logobreite 140, GiroCode 40, speichern; Rechnungs-PDF öffnen → Logo groß, aber nicht im Adressblock; GiroCode sichtbar größer.
  Konsolenfehler protokollieren; kein CI-Gate.

- [ ] **Step 3: Gesamtprüfung** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check`, dazu `bash scripts/test-postgres-migrations.sh`.

- [ ] **Step 4: Commit**
```bash
git add docs
git commit -s -m "docs(feinschliff): GiroCode-Groesse, Logogrenzen, Vorschau-Breite, Dialoge (Phase 12a, Task 4)"
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. **Dialoge:** `grep -rn "<dialog" src/` — neun Dateien, jede mit `w-full max-w-*`; `dialog:modal`-Regel in `globals.css`; die zwei echten Bestätigungen nutzen `ConfirmDialog`, die sieben Formular-Dialoge haben kein Eingabefeld verloren (Diff gegen `git show 9420a20:src/components/dunning/PauseDialog.tsx` usw.). Der Klick-Abfangjäger in `EditorHeader` (`target.closest("dialog")`) greift auch für den neuen Dialog.
2. **Eingabefelder:** `HeadTextBlock`/`FootTextBlock` haben `w-full` (die eigentliche Ursache), `rows={8}`, `maxLength={LONG_TEXT_MAX}`; `LONG_TEXT_MAX = 5000` deckt sich mit `src/schemas/index.ts:352/353`. Der Zähler ist rein anzeigend, die harte Grenze bleibt Zod.
3. **Vorschau:** `previewPanelClass` an genau einer Stelle benutzt; alle `localStorage`-Zugriffe in `try/catch`; `wide` **nicht** in den Deps des Vorschau-Fetch-Effekts.
4. **Logo:** alle **drei** Zeichenorte (`layout.ts`, `modern.ts`, `klassik.ts`) nutzen `fit`; ein breites/flaches Logo rendert byte-gleich wie vorher (bestehende `pdf-theme`-Tests grün); `modern` skaliert mit `logoWidthMm` statt fester 12 mm und läuft nicht aus dem Kopfbalken.
5. **GiroCode:** `grep -rn "GIRO_SIZE_MM" src/` leer; beide Platzierungen lesen `theme.options.giroSizeMm`; das Feld steckt in `printOptionFields` ⇒ automatisch in `printOptionsOverrideSchema` und in `freezePrintOptionsJson`. **Achtung:** `PRINT_OPTION_KEYS` (aus `DEFAULT_PRINT_SETTINGS`) enthält es jetzt, die `isComplete`-Prüfung in `freezePrintOptionsJson` ist damit strenger — prüfen, dass `test/integration/settings-consumption.test.ts:253` grün bleibt.
6. **Typen:** kein `any`; `PrintBooleanKey` verhindert, dass `giroSizeMm` in einer Checkbox landet — `PrintSettingsForm` und `PrintOptionsPanel` kompilieren ohne Cast auf `boolean`.
7. **Migration:** beide `migration.sql` wirkungsgleich; `schema.prisma` und `schema.postgres.prisma` unterscheiden sich weiterhin nur in der `provider`-Zeile (CI `schema-drift`); Fall 9 schließt die neue Migration aus, Fall 16 prüft Default 22 auf einer Bestandszeile und 43 Tabellen.
8. **Schnittstellen:** `openapi/openapi.json` regeneriert (`npm run api:check` grün); MCP-Beschreibung und `docs/MCP.md` nennen `giroSizeMm`.
9. **Doku:** LIMITATIONEN nennt die 30→22-mm-Verschiebung für Altbelege ohne eingefrorenen Wert — die einzige sichtbare Verhaltensänderung an bestehenden Belegen.
10. **Smoke:** Screenshots zeigen mittige Dialoge, breite Vorschau, volle Textfeldbreite. Betreiberfrage: „Sind Kopf-/Fußtext, Vorschau, Logo und GiroCode jetzt in der richtigen Größe?"
