/** Belegstrecke einer Rechnung (statusbasiert): fuenf Punkte, der erreichte Schritt ist gefuellt. */
const STEPS = [
  { status: "DRAFT", label: "Entwurf" },
  { status: "FINALIZED", label: "Festgeschrieben" },
  { status: "SENT", label: "Versendet" },
  { status: "PARTIALLY_PAID", label: "Teilbezahlt" },
  { status: "PAID", label: "Bezahlt" },
] as const;

export function BelegStreckeMini({ status }: { status: string }) {
  const index = STEPS.findIndex((s) => s.status === status);
  if (index < 0) return null;
  return (
    <span role="img" aria-label={`Belegstrecke: ${STEPS[index].label}`} className="inline-flex items-center gap-1">
      {STEPS.map((s, i) => (
        <span key={s.status} aria-hidden="true" className={`size-1.5 rounded-full ${i <= index ? "bg-pen" : "bg-rule-strong"}`} />
      ))}
    </span>
  );
}
