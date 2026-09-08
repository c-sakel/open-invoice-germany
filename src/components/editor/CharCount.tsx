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
