/**
 * GET /api/reports/<typ>.csv — CSV-Export einer Auswertung fuer die eingeloggte Oberflaeche
 * (Phase 17c, Task 3). Session-Auth ueber `src/proxy.ts` (nicht oeffentlich) und `getActiveOrg`;
 * dieselbe Auswertung wie REST/MCP (`runReport`), Parameter (`months`, `limit`, `customerId`)
 * als Query. Die Bearer-Variante ist `GET /api/v1/Report?format=csv`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { runReport } from "@/domain/reporting/query";
import { csvResponse } from "@/lib/http/csv-response";
import { reportCsvFilename, reportToCsv } from "@/domain/reporting/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const m = /^([a-z-]+)\.csv$/.exec(file);
  if (!m) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  const type = m[1];
  const known = z.enum(["revenue", "top-customers", "status", "payment-behaviour", "cash-in", "quote-outcome", "top-products", "recurring-run-rate"]);
  if (!known.safeParse(type).success) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  try {
    const org = await getActiveOrg();
    const { searchParams } = new URL(req.url);
    const query = Object.fromEntries(searchParams);
    delete query.format;
    const now = new Date();
    const result = await runReport(org.id, { ...query, type }, now);
    return csvResponse(reportToCsv(result), reportCsvFilename(result.type, now));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues.map((i) => i.message).join("; ") }, { status: 400 });
    }
    console.error("GET /api/reports:", e);
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
