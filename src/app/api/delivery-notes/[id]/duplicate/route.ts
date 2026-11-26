import { NextResponse } from "next/server";
import { duplicateDocument } from "@/domain/document/duplicate";
import { NotFoundError } from "@/domain/errors";
import { getActiveOrg } from "@/lib/org";
import { AuthRequiredError, authRequiredResponse, requireSessionActor } from "@/lib/auth/require-session";
import { describeError } from "@/lib/safe-error";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const actor = await requireSessionActor();
    const copy = await duplicateDocument(org.id, "DELIVERY_NOTE", id, actor);
    return NextResponse.json(copy, { status: 201 });
  } catch (e) {
    if (e instanceof AuthRequiredError) return authRequiredResponse();
    if (e instanceof NotFoundError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    console.error("POST /duplicate:", describeError(e));
    return NextResponse.json({ error: "Duplizieren fehlgeschlagen." }, { status: 500 });
  }
}
