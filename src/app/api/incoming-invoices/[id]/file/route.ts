/** GET /api/incoming-invoices/{id}/file?kind=original|xml — Download aus der Oberfläche (nur als Anhang, nach Hash-Prüfung). */
import { getIncomingFile } from "@/domain/incoming/files";
import { incomingDownload } from "@/lib/http/incoming-download";
import { jsonNoStore } from "@/lib/http/account-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const raw = new URL(req.url).searchParams.get("kind") ?? "original";
  if (raw !== "original" && raw !== "xml") return jsonNoStore({ error: "kind muss original oder xml sein." }, { status: 400 });
  const { id } = await ctx.params;
  return incomingDownload((orgId) => getIncomingFile(orgId, id, raw));
}
