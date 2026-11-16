/**
 * Gemeinsamer Rahmen der Session-Downloads von Eingangsrechnungen: Organisation aus der Sitzung,
 * feste Fehlertexte (404 identisch fuer fremde und unbekannte Ids, 500 ohne Details bei Hash-Abweichung).
 */
import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import type { IncomingFile } from "@/domain/incoming/files";
import { downloadHeaders } from "./download-headers";
import { jsonNoStore } from "./account-route";

export async function incomingDownload(load: (orgId: string) => Promise<IncomingFile>): Promise<NextResponse> {
  try {
    const org = await getActiveOrg();
    const file = await load(org.id);
    return new NextResponse(new Uint8Array(file.bytes), { headers: downloadHeaders(file.fileName, file.mime, file.bytes.length) });
  } catch (e) {
    if (e instanceof NotFoundError) return jsonNoStore({ error: "Nicht gefunden." }, { status: 404 });
    if (e instanceof ArchiveTamperedError) return jsonNoStore({ error: "Die Datei kann nicht ausgegeben werden." }, { status: 500 });
    console.error("GET incoming-invoices Download:", e instanceof Error ? e.name : "unbekannt");
    return jsonNoStore({ error: "Interner Fehler" }, { status: 500 });
  }
}
