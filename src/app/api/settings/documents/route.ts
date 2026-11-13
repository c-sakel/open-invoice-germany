import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveOrg } from "@/lib/org";
import { loadDocumentSettings, saveDocumentSettings } from "@/domain/document/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const org = await getActiveOrg();
  const settings = await loadDocumentSettings(org.id);
  return NextResponse.json({ settings });
}

export async function PUT(req: Request) {
  try {
    const org = await getActiveOrg();
    const body = await req.json();
    // Fehlende VIES-Schalter duerfen nicht auf die Schema-Defaults zurueckfallen.
    const current = await loadDocumentSettings(org.id);
    const sent: Record<string, unknown> = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const settings = await saveDocumentSettings(org.id, {
      ...sent,
      viesCheckEnabled: "viesCheckEnabled" in sent ? sent.viesCheckEnabled : current.viesCheckEnabled,
      viesCheckOnFinalize: "viesCheckOnFinalize" in sent ? sent.viesCheckOnFinalize : current.viesCheckOnFinalize,
    });
    return NextResponse.json({ settings });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    console.error("PUT /api/settings/documents:", e);
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
