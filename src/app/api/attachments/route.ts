import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { addAttachment, type AttachmentDocType } from "@/domain/attachment/manage";
import { AttachmentValidationError } from "@/lib/attachments/storage";
import { RelationError } from "@/domain/relations";
import { DocRefType } from "@/schemas";
import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_TOTAL_BYTES_PER_DOC } from "@/lib/attachments/mime";

export const runtime = "nodejs";

// Toleranz fuer multipart-Overhead (Boundary, Feldnamen) oberhalb der eigentlichen
// Dateigroesse — analog api/emails/send.
const CONTENT_LENGTH_TOLERANCE_BYTES = 64 * 1024;

const fieldsSchema = z.object({
  docType: DocRefType,
  docId: z.string().min(1),
});

export async function POST(req: Request) {
  // Groesse VOR jedem Einlesen anhand des Headers pruefen (analog api/emails/send) —
  // fehlt er oder ist er zu gross, wird der Body nie gelesen.
  const contentLengthHeader = req.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
  if (!Number.isFinite(contentLength) || contentLength > MAX_ATTACHMENT_TOTAL_BYTES_PER_DOC + CONTENT_LENGTH_TOLERANCE_BYTES) {
    return NextResponse.json({ error: "Anfrage zu gross" }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Ungueltige multipart-Anfrage." }, { status: 400 });
  }

  const parsedFields = fieldsSchema.safeParse({ docType: formData.get("docType"), docId: formData.get("docId") });
  if (!parsedFields.success) {
    return NextResponse.json({ error: "docType/docId fehlen oder sind ungueltig." }, { status: 400 });
  }
  const { docType, docId } = parsedFields.data as { docType: AttachmentDocType; docId: string };

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "Keine Datei uebergeben." }, { status: 400 });
  }

  try {
    const org = await getActiveOrg();
    const actor = (await getCurrentUserId()) ?? "system";
    const created = [];
    for (const f of files) {
      if (f.size > MAX_ATTACHMENT_FILE_BYTES) {
        return NextResponse.json({ error: `Datei "${f.name}" ueberschreitet die Groesse von ${MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024)} MB.` }, { status: 400 });
      }
      const buffer = Buffer.from(await f.arrayBuffer());
      const row = await addAttachment(org.id, docType, docId, { filename: f.name, mime: f.type || "application/octet-stream", buffer }, actor);
      created.push({ id: row.id, filename: row.filename, mime: row.mime, sizeBytes: row.sizeBytes });
    }
    return NextResponse.json({ attachments: created }, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen: " + (e.issues[0]?.message ?? "") }, { status: 400 });
    }
    if (e instanceof AttachmentValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof RelationError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof Error && e.message.includes("ueberschreiten insgesamt")) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error("POST /api/attachments:", e);
    return NextResponse.json({ error: "Anhang konnte nicht gespeichert werden." }, { status: 500 });
  }
}
