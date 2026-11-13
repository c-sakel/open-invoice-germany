import { NextResponse } from "next/server";
import { z } from "zod";
import { updateDraftDeliveryNote } from "@/domain/delivery-note/update";
import { DeliveryNoteError, DeliveryNoteValidationError } from "@/domain/delivery-note/errors";
import { OverDeliveryError } from "@/domain/delivery-note/quantities";
import { NotFoundError } from "@/domain/errors";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";

export const runtime = "nodejs";

/** Phase 17b: Lieferschein-Entwurf bearbeiten (nur Status DRAFT, sonst 409). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const actor = (await getCurrentUserId()) ?? "system";
    const updated = await updateDraftDeliveryNote(org.id, id, await req.json(), { actor });
    return NextResponse.json({ id: updated.id, number: updated.number, status: updated.status });
  } catch (e) {
    if (e instanceof SyntaxError) return NextResponse.json({ error: "Ungültiges JSON im Request-Body." }, { status: 400 });
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    if (e instanceof NotFoundError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    if (e instanceof DeliveryNoteValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof DeliveryNoteError || e instanceof OverDeliveryError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error("PATCH /api/delivery-notes/[id]:", e);
    return NextResponse.json({ error: "Aktualisieren fehlgeschlagen." }, { status: 500 });
  }
}
