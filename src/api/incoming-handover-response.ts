/**
 * HTTP-Antwort der Uebergabe von Eingangsrechnungen: das ZIP wird in eine temporaere Datei gebaut
 * (Fehler vor dem ersten Byte) und von dort gestreamt; die Datei wird nach dem Senden geloescht.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { buildIncomingHandoverFile, removeIncomingHandoverFile } from "@/domain/incoming/handover";

export async function incomingHandoverResponse(orgId: string, rawQuery: Record<string, string>): Promise<NextResponse> {
  const { path: file, fileName } = await buildIncomingHandoverFile(orgId, {
    from: rawQuery.from,
    to: rawQuery.to,
    ...(rawQuery.includeRejected !== undefined ? { includeRejected: rawQuery.includeRejected } : {}),
  });
  try {
    const { size } = await stat(file);
    const stream = createReadStream(file);
    const cleanup = () => void removeIncomingHandoverFile(file).catch(() => undefined);
    stream.on("close", cleanup);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${fileName}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    await removeIncomingHandoverFile(file);
    throw e;
  }
}
