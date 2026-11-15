/**
 * GET /api/datev/<id>/file — ZIP eines DATEV-Exports fuer die eingeloggte Oberflaeche (Session-Auth ueber
 * `src/proxy.ts`, Organisation aus der Sitzung). Die Bearer-Variante ist `GET /api/v1/DatevExport/{id}/file`.
 */
import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { readDatevExportFile } from "@/domain/export/datev/run";
import { DatevExportError } from "@/domain/export/datev/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const org = await getActiveOrg();
    const { bytes, filename } = await readDatevExportFile(org.id, id);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof DatevExportError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("GET /api/datev:", e instanceof Error ? e.name : "unbekannt");
    return NextResponse.json({ error: "Download fehlgeschlagen." }, { status: 500 });
  }
}
