import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { revokeApiKey } from "@/domain/api-key/revoke";
import { NotFoundError } from "@/domain/errors";
import { AuthRequiredError, authRequiredResponse, requireSessionActor } from "@/lib/auth/require-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const actor = await requireSessionActor();
    await revokeApiKey(org.id, id, actor);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthRequiredError) return authRequiredResponse();
    if (e instanceof NotFoundError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    console.error("DELETE /api/api-keys/[id]:", e);
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
