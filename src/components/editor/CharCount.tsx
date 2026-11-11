"use client";

import { charCountLabel, charCountTone, LONG_TEXT_MAX } from "@/lib/editor/constants";

const TONE_CLS = { ok: "text-ink-muted", warn: "text-seal", over: "text-stamp" } as const;

/** Zeichenzaehler unter einem Langtextfeld (Phase 12a). Rein anzeigend — die harte
 *  Grenze setzt Zod beim Speichern (headerText/footerText max. 5000).
 *  Fix-Welle 12a (M4): kein `aria-live` — der Zaehler aktualisiert bei jedem
 *  Tastendruck, ein `aria-live="polite"` liesse Screenreader jeden Zeichenstand
 *  vorlesen. Der Zaehler ist visuelles Beiwerk; die harte Grenze meldet Zod. */
export function CharCount({ value, max = LONG_TEXT_MAX }: { value: string; max?: number }) {
  return (
    <p className={`text-right text-xs ${TONE_CLS[charCountTone(value, max)]}`}>
      {charCountLabel(value, max)}
    </p>
  );
}
