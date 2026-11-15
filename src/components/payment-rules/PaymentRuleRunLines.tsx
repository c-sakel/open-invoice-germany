import { RUN_STATUS_LABELS } from "./rule-form-model";

/** Zeilen "Regeln: <Name> – <Status>" unter einer Zahlung der Belegansicht. */
export function PaymentRuleRunLines({ runs }: { runs: { ruleName: string; status: string }[] }) {
  if (runs.length === 0) return null;
  return (
    <p className="basis-full text-xs text-ink-muted">
      {runs.map((r, i) => (
        <span key={`${r.ruleName}-${i}`}>
          {i > 0 ? " · " : "Regeln: "}
          {r.ruleName} – {RUN_STATUS_LABELS[r.status] ?? r.status}
        </span>
      ))}
    </p>
  );
}
