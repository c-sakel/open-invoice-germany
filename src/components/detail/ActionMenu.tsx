// src/components/detail/ActionMenu.tsx
"use client";

import { useRef, type ReactNode } from "react";
import { useDetailsDismiss } from "./use-details-dismiss";

/** "Mehr"-Menue: <details> mit absolut positionierter Liste. Ohne JS bleibt es voll bedienbar
 *  (natives Auf-/Zuklappen); mit JS schliesst es bei Klick ausserhalb und Escape. Kinder sind
 *  <ActionMenuItem> mit Link, Button oder <form action=...> (Server Actions bleiben nutzbar). */
export function ActionMenu({ label = "Mehr", children }: { label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsDismiss(ref, { outsideClick: true });
  return (
    <details ref={ref} className="relative">
      <summary className="cursor-pointer list-none rounded-md border border-rule-strong bg-sheet px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-paper [&::-webkit-details-marker]:hidden">
        {label} ▾
      </summary>
      <ul className="absolute right-0 z-30 mt-1 min-w-56 rounded-md border border-rule bg-sheet py-1 text-sm shadow-lg">{children}</ul>
    </details>
  );
}

export function ActionMenuItem({ children }: { children: ReactNode }) {
  return (
    <li className="[&>a,&>button,&>form>button]:block [&>a,&>button,&>form>button]:w-full [&>a,&>button,&>form>button]:px-3 [&>a,&>button,&>form>button]:py-1.5 [&>a,&>button,&>form>button]:text-left [&>a,&>button,&>form>button]:hover:bg-paper">
      {children}
    </li>
  );
}

export function ActionMenuSeparator() {
  return <li className="my-1 border-t border-rule" />;
}
