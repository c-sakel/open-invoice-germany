/**
 * GET /api/exports/<liste>.csv — CSV-Export einer Listenseite fuer die eingeloggte Oberflaeche
 * (Phase 18b, Task 3). Session-Auth ueber `src/proxy.ts` (nicht oeffentlich) und `getActiveOrg`;
 * die Query ist die der Listenseite (nur `ALLOWED_KEYS` aus `neighbors.ts`), die Id-Menge kommt
 * aus denselben Listenbausteinen wie die Seite. Die Bearer-Variante ist `GET /api/v1/<Ressource>?format=csv`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { ALLOWED_KEYS } from "@/domain/document/neighbors";
import { exportFromPageQuery, ExportTooLargeError } from "@/domain/export";
import { csvResponse } from "@/lib/http/csv-response";
import { RateLimitError } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILES = {
  rechnungen: "invoices",
  dokumente: "documents",
  lieferscheine: "delivery-notes",
  kunden: "contacts",
  produkte: "products",
} as const;

const fileSchema = z.enum(["rechnungen", "dokumente", "lieferscheine", "kunden", "produkte"]);

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const m = /^([a-z]+)\.csv$/.exec(file);
  const parsed = m ? fileSchema.safeParse(m[1]) : null;
  if (!parsed || !parsed.success) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  try {
    const org = await getActiveOrg();
    const incoming = new URL(req.url).searchParams;
    const allowed = new URLSearchParams();
    for (const [k, v] of incoming) if (ALLOWED_KEYS.has(k) && v !== "") allowed.set(k, v);
    const result = await exportFromPageQuery(org.id, FILES[parsed.data], allowed);
    return csvResponse(result.csv, result.filename);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues.map((i) => i.message).join("; ") }, { status: 400 });
    }
    if (e instanceof ExportTooLargeError) {
      return NextResponse.json({ error: e.message }, { status: 413 });
    }
    if (e instanceof RateLimitError) {
      return NextResponse.json({ error: "Zu viele Exporte — bitte kurz warten." }, { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } });
    }
    console.error("GET /api/exports:", e instanceof Error ? e.name : "unbekannt");
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
