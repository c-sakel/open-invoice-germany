import type { ReactNode } from "react";

/**
 * Breitenrahmen einer Seite (Phase 13a). `AppShell` gibt seit dieser Phase 1600 px frei —
 * gewollt fuer Listen/Editor/Belegansicht, unlesbar fuer ein Stammdaten- oder
 * Einstellungsformular (Zeilenlaenge). Server-Komponente ohne Zustand; bewusst nur die
 * zwei Faelle, die es gibt.
 */
export function PageContainer({ width, children }: { width: "wide" | "form"; children: ReactNode }) {
  return <div className={width === "form" ? "mx-auto w-full max-w-4xl" : "w-full"}>{children}</div>;
}
