/**
 * Session-Route fuer die UI: Hash-Kette pruefen (POST) bzw. Historie lesen (GET), Phase 16a.
 * Org-Pruefung ueber getActiveOrg (Session-geschuetzt durch die Middleware).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { listChainVerifications, verifyOrgChain } from "@/domain/audit/verify-chain";
import { auditChainListQuerySchema, auditChainVerifyInputSchema } from "@/schemas/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(e: unknown) {
  if (e instanceof z.ZodError) return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
  console.error("[audit-chain]", e);
  return NextResponse.json({ error: "Unerwarteter Fehler" }, { status: 500 });
}

export async function GET(req: Request) {
  try {
    const org = await getActiveOrg();
    const { limit } = auditChainListQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    return NextResponse.json({ data: await listChainVerifications(org.id, limit) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const org = await getActiveOrg();
    const raw = await req.text();
    auditChainVerifyInputSchema.parse(raw ? JSON.parse(raw) : {});
    return NextResponse.json({ data: await verifyOrgChain(org.id, "UI") });
  } catch (e) {
    if (e instanceof SyntaxError) return errorResponse(new z.ZodError([{ code: "custom", path: [], message: "Ungueltiges JSON" }]));
    return errorResponse(e);
  }
}
