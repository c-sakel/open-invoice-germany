import { NextResponse } from "next/server";
import { z } from "zod";
import { updateRecurringStatusSchema } from "@/schemas";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { RecurringError } from "@/domain/recurring/create";
import { NotFoundError } from "@/domain/errors";

export const runtime = "nodejs";

/**
 * Reiner Statuswechsel (Task 1/2, unveraendert): `{ status }` allein. Fuer alle anderen
 * Felder (Titel/Rhythmus/Enddatum/maxRuns/… — Task 4, §43) `{ patch: {...} }` verwenden,
 * das an `updateRecurringInvoice` (Zod: `updateRecurringSchema`) geht. Beide Formen sind
 * ueber denselben Endpunkt erreichbar, damit das Bearbeiten-Formular NICHT zwei Routen
 * braucht.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const body: unknown = await req.json();

    if (body && typeof body === "object" && "patch" in body) {
      const updated = await updateRecurringInvoice(org.id, id, (body as { patch: unknown }).patch);
      return NextResponse.json(updated);
    }

    const { status } = updateRecurringStatusSchema.parse(body);
    const updated = await dbInternal.recurringInvoice.updateMany({
      where: { id, orgId: org.id },
      data: { status },
    });
    if (updated.count === 0) return NextResponse.json({ error: "Abo nicht gefunden." }, { status: 404 });
    return NextResponse.json({ id, status });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof RecurringError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("PATCH /api/recurring/[id]:", e);
    return NextResponse.json({ error: "Abo konnte nicht geändert werden." }, { status: 400 });
  }
}
