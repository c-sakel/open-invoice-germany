import { NextResponse } from "next/server";
import { duplicateDocument } from "@/domain/document/duplicate";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const actor = (await getCurrentUserId()) ?? "system";
    const copy = await duplicateDocument(org.id, "DELIVERY_NOTE", id, actor);
    return NextResponse.json(copy, { status: 201 });
  } catch (e) {
    const status = e instanceof Error && /nicht gefunden/.test(e.message) ? 404 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
