import type { ReactNode } from "react";

interface CardProps {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Flaeche auf dem Papier-Hintergrund (Phase 16f): Blatt mit Kartenschatten, Titel links, Aktion rechts. */
export function Card({ title, action, children, className }: CardProps) {
  return (
    <section className={`rounded-[var(--radius-card)] bg-sheet p-4 shadow-[var(--shadow-card)] sm:p-5${className ? ` ${className}` : ""}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2 className="text-[15px] font-semibold text-ink">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
