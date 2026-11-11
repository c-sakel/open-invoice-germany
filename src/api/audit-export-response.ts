/**
 * HTTP-Antwort fuer den Pruefer-Export (Phase 16a): ZIP wird in eine temporaere Datei gebaut
 * (Fehler vor dem ersten Byte) und von dort gestreamt; die Datei wird nach dem Senden geloescht.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { buildAuditExportFile, removeAuditExportFile } from "@/domain/audit/export";
import { auditExportQuerySchema, auditExportRange } from "@/schemas/audit";

export async function auditExportResponse(orgId: string, rawQuery: Record<string, string>): Promise<NextResponse> {
  const q = auditExportQuerySchema.parse({ from: rawQuery.from, to: rawQuery.to });
  const { path: file } = await buildAuditExportFile(orgId, auditExportRange(q));
  try {
    const { size } = await stat(file);
    const stream = createReadStream(file);
    const cleanup = () => void removeAuditExportFile(file).catch(() => undefined);
    stream.on("close", cleanup);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(size),
        "content-disposition": `attachment; filename="pruefer-export-${q.from}-${q.to}.zip"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    await removeAuditExportFile(file);
    throw e;
  }
}
