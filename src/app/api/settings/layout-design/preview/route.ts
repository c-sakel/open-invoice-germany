import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { renderLayoutPreview } from "@/domain/layout-design/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live-Vorschau des Layout-Designers (Phase 16g, Session-authentifiziert). Body wie
 * `layoutPreviewSchema` (config | version, docType, draftInvoiceId), zusaetzlich optional
 * `designId` fuer Versionsvorschau. Schreibt nichts; `cache-control: no-store`.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ungültiger JSON-Body." }, { status: 400 });
  }
  const envelope = z.object({ designId: z.string().min(1).optional() }).loose().safeParse(body);
  if (!envelope.success) {
    return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: envelope.error.issues }, { status: 400 });
  }
  const { designId, ...rest } = envelope.data;
  try {
    const org = await getActiveOrg();
    const pdf = await renderLayoutPreview(org.id, designId ?? null, rest);
    return new Response(new Uint8Array(pdf), {
      headers: { "content-type": "application/pdf", "content-disposition": 'inline; filename="layout-vorschau.pdf"', "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    console.error("POST /api/settings/layout-design/preview:", e);
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
