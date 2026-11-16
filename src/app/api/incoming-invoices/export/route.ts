/** GET /api/incoming-invoices/export?from&to&includeRejected — Übergabe an die Buchhaltung aus der Oberfläche (Sitzung). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { mapApiError } from "@/api/errors";
import { incomingErrorResponse } from "@/api/incoming-errors";
import { incomingHandoverResponse } from "@/api/incoming-handover-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const org = await getActiveOrg();
    return await incomingHandoverResponse(org.id, Object.fromEntries(new URL(req.url).searchParams));
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    const mapped = incomingErrorResponse(e);
    if (mapped) return mapped;
    const { status, body } = mapApiError(e);
    return NextResponse.json({ error: body.error.message }, { status });
  }
}
