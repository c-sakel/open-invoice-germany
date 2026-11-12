"use client";

import { useState } from "react";

/**
 * Zahlenfeld mit lokalem Textzustand: Zwischenstaende wie "" oder "9," blockieren das Tippen
 * nicht, nur gueltige Zahlen werden an den Entwurf gemeldet. Komma und Punkt sind erlaubt.
 */
export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  className,
  error,
  hideLabel,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  className?: string;
  error?: string;
  hideLabel?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? String(value).replace(".", ",");
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className={hideLabel ? "sr-only" : "text-ink-soft"}>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        step={step}
        value={shown}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value.trim().replace(",", "."));
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setText(null)}
        className={`rounded-[var(--radius-control)] border border-rule-strong bg-sheet px-2 py-1.5 ${className ?? ""}`}
      />
      {error && (
        <span role="alert" className="text-xs text-stamp">
          {error}
        </span>
      )}
    </label>
  );
}
