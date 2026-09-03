import { NextResponse } from "next/server";
import { remainingQuantities } from "@/domain/delivery-note/quantities";
import { getActiveOrg } from "@/lib/org";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const remaining = await remainingQuantities(org.id, "INVOICE", id);
    return NextResponse.json(remaining);
  } catch (e) {
    const status = e instanceof Error && /nicht gefunden/.test(e.message) ? 404 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
