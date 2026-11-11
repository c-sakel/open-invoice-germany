/** Hinweiskarte im Bereich "Hinweise" des Dashboards (R2); Quellen liefern Karten, das Raster bleibt gleich. */
export interface DashboardNotice {
  id: string;
  tone: "pen" | "seal" | "stamp";
  title: string;
  body: string;
  href?: string;
}
