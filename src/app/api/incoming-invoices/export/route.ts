/** GET /api/incoming-invoices/export?from&to&includeRejected[&dryRun=1] — Übergabe an die Buchhaltung aus der Oberfläche (Sitzung). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { mapApiError } from "@/api/errors";
import { incomingErrorResponse } from "@/api/incoming-errors";
import { incomingHandoverResponse } from "@/api/incoming-handover-response";
import { planIncomingHandover } from "@/domain/incoming/handover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const org = await getActiveOrg();
    const query = Object.fromEntries(new URL(req.url).searchParams);
    if (query.dryRun === "1") {
      // Nur pruefen (Eingabe, Umfang), ohne das ZIP zu bauen.
      const plan = await planIncomingHandover(org.id, { from: query.from, to: query.to, ...(query.includeRejected !== undefined ? { includeRejected: query.includeRejected } : {}) });
      return NextResponse.json(plan);
    }
    return await incomingHandoverResponse(org.id, query);
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    const mapped = incomingErrorResponse(e);
    if (mapped) return mapped;
    const { status, body } = mapApiError(e);
    return NextResponse.json({ error: body.error.message }, { status });
  }
}
