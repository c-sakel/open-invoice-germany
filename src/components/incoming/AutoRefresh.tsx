"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Lädt die Seite alle 5 Sekunden neu (höchstens 2 Minuten), solange Prüfungen laufen. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (n > 24) clearInterval(t);
      else router.refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
