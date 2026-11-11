import { dbInternal } from "@/lib/db";
import { getArchivedDunningPdf } from "@/domain/dunning/archive";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const d = await dbInternal.dunning.findUnique({ where: { id }, select: { id: true, number: true } });
  if (!d) return new Response("Mahnung nicht gefunden", { status: 404 });

  // Phase 16a: erste Ausgabe archiviert das Mahn-PDF, danach nur noch diese Bytes.
  const pdf = await getArchivedDunningPdf(d.id);

  const safe = (d.number ?? "mahnung").replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Uint8Array(pdf), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${safe}.pdf"` },
  });
}
