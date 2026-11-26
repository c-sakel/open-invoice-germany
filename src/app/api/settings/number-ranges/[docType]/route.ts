import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { AuthRequiredError, authRequiredResponse, requireSessionActor } from "@/lib/auth/require-session";
import { updateNumberRange, NUMBER_RANGE_DOC_TYPES } from "@/domain/numbering/ranges";
import { InvalidOperationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ docType: string }> }) {
  const { docType } = await ctx.params;
  if (!(NUMBER_RANGE_DOC_TYPES as readonly string[]).includes(docType)) {
    return NextResponse.json({ error: `docType muss einer von ${NUMBER_RANGE_DOC_TYPES.join(", ")} sein.` }, { status: 400 });
  }
  try {
    const org = await getActiveOrg();
    const actor = await requireSessionActor();
    const body = await req.json();
    const range = await updateNumberRange(org.id, docType, body, actor);
    return NextResponse.json({ range });
  } catch (e) {
    if (e instanceof AuthRequiredError) return authRequiredResponse();
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    if (e instanceof InvalidOperationError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error("PUT /api/settings/number-ranges/[docType]:", e);
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
