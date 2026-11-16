import type { serializeIncomingValidation } from "@/api/serializers/incoming";
import { formatReceivedAt, validationLabel } from "./incoming-ui";

export type ValidationView = ReturnType<typeof serializeIncomingValidation>;

type Finding = ValidationView["findings"]["format"][number];

function Group({ title, items, tone }: { title: string; items: Finding[]; tone: "error" | "note" }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-1">
      <h4 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
        {title} ({items.length})
      </h4>
      <ul className="space-y-1">
        {items.map((f, i) => (
          <li key={`${f.ruleId}-${i}`} className={`rounded-md border px-3 py-2 text-sm ${tone === "error" ? "border-red-300 bg-red-50 text-red-900" : "border-seal/30 bg-seal/10 text-ink"}`}>
            <p className="font-mono text-xs break-all">{f.ruleId}</p>
            <p className="break-words">{f.text}</p>
            {f.location ? <p className="font-mono text-xs break-all text-ink-muted">{f.location}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Prüfergebnis in drei Gruppen (Formatfehler, Regelverstöße, Hinweise) mit Regel-Id. Die Prüfung bewertet nur das
 * Format und die Regeln der Norm; Texte aus dem Prüfbericht erscheinen nur als Text.
 */
export function ValidationResult({ status, validation }: { status: string; validation: ValidationView | null }) {
  return (
    <section aria-label="Prüfergebnis" className="space-y-3 rounded-md border border-rule bg-paper p-4 text-sm">
      <p className="font-medium text-ink">Prüfung: {validationLabel(status)}</p>
      {validation ? (
        <>
          <p className="text-ink-soft">
            {formatReceivedAt(validation.at)} · {validation.engine} {validation.artefactVersion} · {validation.formatErrors} Formatfehler, {validation.ruleErrors} Regelverstöße,{" "}
            {validation.warnings} Hinweise
          </p>
          {validation.reasonText ? <p className="text-ink">{validation.reasonText}</p> : null}
          <Group title="Formatfehler" items={validation.findings.format} tone="error" />
          <Group title="Regelverstöße" items={validation.findings.rules} tone="error" />
          <Group title="Hinweise" items={validation.findings.notes} tone="note" />
        </>
      ) : status === "NOT_APPLICABLE" ? (
        <p className="text-ink-soft">Für diese Datei gibt es keine Prüfung gegen EN 16931.</p>
      ) : (
        <p className="text-ink-soft">Noch kein Prüfergebnis.</p>
      )}
      <p className="text-xs text-ink-muted">Die Prüfung bewertet nur das Format und die Regeln der Norm, nicht die inhaltliche Richtigkeit.</p>
    </section>
  );
}
