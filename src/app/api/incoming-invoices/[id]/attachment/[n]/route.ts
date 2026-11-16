/** GET /api/incoming-invoices/{id}/attachment/{n} — eingebettete Anlage aus der Oberfläche (nur als Anhang). */
import { NotFoundError } from "@/domain/errors";
import { getIncomingAttachment } from "@/domain/incoming/files";
import { incomingDownload } from "@/lib/http/incoming-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  return incomingDownload((orgId) => {
    if (!/^\d{1,3}$/.test(n)) throw new NotFoundError("Anlage nicht gefunden.");
    return getIncomingAttachment(orgId, id, Number(n));
  });
}
