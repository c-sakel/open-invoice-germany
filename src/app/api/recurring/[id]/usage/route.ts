import { recordUsage } from "@/domain/recurring/usage";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { jsonRequired, ok, usageErrorResponse } from "./respond";

export const runtime = "nodejs";

/** Verbrauch aus der Oberflaeche erfassen (Sitzung); gleiche Domainfunktion und Validierung wie REST/MCP. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const bad = jsonRequired(req);
  if (bad) return bad;
  try {
    const { id } = await ctx.params;
    const org = await getActiveOrg();
    const actor = (await getCurrentUserId()) ?? "system";
    const { usage, replayed } = await recordUsage(org.id, id, await req.json(), { source: "UI", actor });
    return ok({ usage, replayed }, replayed ? 200 : 201);
  } catch (e) {
    return usageErrorResponse(e, "POST /api/recurring/[id]/usage:");
  }
}
