"use client";

import type { ComponentProps } from "react";
import { BarChart } from "@/components/charts/BarChart";
import { ResponsiveChart } from "@/components/charts/ResponsiveChart";

/** Client-Huelle: misst die Kartenbreite und rendert das (serialisierbar parametrierte) BarChart in echten Pixeln. */
export function ResponsiveBarChart(props: Omit<ComponentProps<typeof BarChart>, "viewBoxWidth">) {
  return <ResponsiveChart>{(width) => <BarChart {...props} viewBoxWidth={width} />}</ResponsiveChart>;
}
