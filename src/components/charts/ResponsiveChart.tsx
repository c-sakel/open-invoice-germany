"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Misst die echte Pixelbreite des Containers (ResizeObserver) und reicht sie an die
 * Diagramme weiter (`viewBoxWidth`), damit die Schrift nie skaliert wird. Serverseitig und
 * vor der ersten Messung gilt `initialWidth`.
 */
export function ResponsiveChart({
  children,
  initialWidth = 640,
}: {
  children: (width: number) => ReactNode;
  initialWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number) => {
      const rounded = Math.round(w);
      if (rounded > 0) setWidth((prev) => (prev === rounded ? prev : rounded));
    };
    measure(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="w-full">
      {children(width)}
    </div>
  );
}
