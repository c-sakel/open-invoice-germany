import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { AuthRequiredError, authRequiredResponse, requireSessionActor } from "@/lib/auth/require-session";
import { updateDraftDocument } from "@/domain/document/update";
import { StatusTransitionError } from "@/domain/document/status";
import { NotFoundError } from "@/domain/errors";
import { describeError } from "@/lib/safe-error";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const actor = await requireSessionActor();
    const body = await req.json();
    const updated = await updateDraftDocument(org.id, id, body, actor);
    return NextResponse.json({ id: updated.id, number: updated.number, status: updated.status });
  } catch (e) {
    if (e instanceof AuthRequiredError) return authRequiredResponse();
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    if (e instanceof StatusTransitionError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof NotFoundError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    console.error("PATCH /api/documents/[id]:", describeError(e));
    return NextResponse.json({ error: "Aktualisieren fehlgeschlagen." }, { status: 500 });
  }
}
