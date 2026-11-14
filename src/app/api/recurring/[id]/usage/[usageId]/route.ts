import { voidUsage } from "@/domain/recurring/usage";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { guardSessionWrite, limitUsageWrites, ok, readUsageBody, usageErrorResponse } from "../respond";

export const runtime = "nodejs";

/** Verbrauchssatz stornieren (Pflichtgrund im JSON-Body); der Satz bleibt erhalten. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; usageId: string }> }) {
  const bad = guardSessionWrite(req);
  if (bad) return bad;
  try {
    const { id, usageId } = await ctx.params;
    const org = await getActiveOrg();
    limitUsageWrites(org.id);
    const actor = (await getCurrentUserId()) ?? "system";
    const usage = await voidUsage(org.id, id, usageId, await readUsageBody(req), { actor });
    return ok({ usage });
  } catch (e) {
    return usageErrorResponse(e, "DELETE /api/recurring/[id]/usage/[usageId]:");
  }
}
