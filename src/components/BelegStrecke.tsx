import type { BelegStep } from "@/domain/timeline/belegstrecke";

/**
 * Belegstrecke (Signatur der Oberflaeche): Stufenleiste des Rechnungs-Lebenslaufs.
 * `lg`: alle Schritte mit Text; `sm`: nur der aktuelle Schritt sichtbar, die uebrigen als sr-only.
 */
export function BelegStrecke({ steps, size, hideText = false }: { steps: BelegStep[]; size: "lg" | "sm"; hideText?: boolean }) {
  const small = size === "sm";
  return (
    <ol aria-label="Belegstrecke" className={`m-0 flex list-none flex-wrap items-center p-0 ${small ? "gap-1.5" : "gap-x-2 gap-y-2"}`}>
      {steps.map((s, i) => {
        const current = s.state === "current";
        const marker =
          s.key === "CANCELLED"
            ? "bg-stamp"
            : s.state === "todo"
              ? "bg-rule-strong"
              : s.stamp
                ? "bg-pen ring-2 ring-pen/30"
                : "bg-pen";
        const textClass = current
          ? `font-semibold ${s.key === "CANCELLED" ? "text-stamp" : "text-ink"}`
          : s.state === "done"
            ? "text-ink-soft"
            : "text-ink-muted";
        const showText = !small || (current && !hideText);
        return (
          <li key={s.key} aria-current={current ? "step" : undefined} className="flex items-center gap-1.5">
            {!small && i > 0 && <span aria-hidden="true" className={`h-px w-4 sm:w-8 ${s.state === "todo" ? "bg-rule-strong" : "bg-pen"}`} />}
            <span aria-hidden="true" className={`${small ? "size-1.5" : "size-2.5"} shrink-0 rounded-full ${marker}`} />
            <span className={`${showText ? "" : "sr-only"} ${small ? "text-xs" : "text-sm"} ${textClass}`}>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
