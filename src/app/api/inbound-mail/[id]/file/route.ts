/** GET /api/inbound-mail/{id}/file — Datei einer Anlage aus der Sichtung (Oberfläche; nur als Anhang, nach Hash-Prüfung). */
import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { NotFoundError } from "@/domain/errors";
import { InboundMailError } from "@/domain/mailbox/errors";
import { getStagedFile } from "@/domain/mailbox/list";
import { downloadHeaders } from "@/lib/http/download-headers";
import { jsonNoStore } from "@/lib/http/account-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const org = await getActiveOrg();
    const { id } = await ctx.params;
    const file = await getStagedFile(org.id, id);
    return new NextResponse(new Uint8Array(file.bytes), { headers: downloadHeaders(file.fileName, file.mime, file.bytes.length) });
  } catch (e) {
    // Fehlende Datei oder fremde Id sehen von aussen gleich aus.
    if (e instanceof NotFoundError || e instanceof InboundMailError) return jsonNoStore({ error: "Nicht gefunden." }, { status: 404 });
    console.error("GET inbound-mail Download:", e instanceof Error ? e.name : "unbekannt");
    return jsonNoStore({ error: "Interner Fehler" }, { status: 500 });
  }
}
