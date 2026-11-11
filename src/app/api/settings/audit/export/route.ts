/**
 * Session-Route fuer die UI: Pruefer-Export als ZIP-Download (Phase 16a). Org-Pruefung ueber
 * getActiveOrg (Session-geschuetzt durch die Middleware).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { auditExportResponse } from "@/api/audit-export-response";
import { mapApiError } from "@/api/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const org = await getActiveOrg();
    return await auditExportResponse(org.id, Object.fromEntries(new URL(req.url).searchParams));
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    const { status, body } = mapApiError(e);
    return NextResponse.json({ error: body.error.message }, { status });
  }
}
