import type { ReactNode } from "react";

export type KpiTone = "default" | "stamp" | "seal" | "ledger";

const TONE: Record<KpiTone, string> = {
  default: "text-ink",
  stamp: "text-stamp",
  seal: "text-seal",
  ledger: "text-ledger",
};

interface KpiProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: KpiTone;
  size?: "default" | "hero";
  children?: ReactNode;
}

/** Kennzahl: Beschriftung klein, Wert gross (22 px, Hero 40 px) mit tabellarischen Ziffern. */
export function Kpi({ label, value, hint, tone = "default", size = "default", children }: KpiProps) {
  const valueSize = size === "hero" ? "text-[40px] leading-[1.1]" : "text-[22px] leading-tight";
  return (
    <div>
      <div className="text-[13px] text-ink-muted">{label}</div>
      <div className={`tabular font-semibold ${valueSize} ${TONE[tone]}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[13px] text-ink-muted">{hint}</div>}
      {children}
    </div>
  );
}
