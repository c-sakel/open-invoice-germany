import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelInvoice, CancelError } from "@/domain/invoice/cancel";
import { NotFoundError } from "@/domain/errors";
import { cancelInvoiceSchema } from "@/schemas";
import { getActiveOrg } from "@/lib/org";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    // Body ist optional (nur `reason`); leerer/fehlender Body = kein Grund.
    const raw = await req.text();
    const input = cancelInvoiceSchema.parse(raw ? JSON.parse(raw) : {});
    const result = await cancelInvoice(id, { orgId: org.id, reason: input.reason });
    return NextResponse.json({
      originalNumber: result.originalNumber,
      creditNoteId: result.creditNote.id,
      creditNoteNumber: result.creditNote.number,
      refundDueCents: result.refundDueCents,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    if (e instanceof SyntaxError) return NextResponse.json({ error: "Ungültiges JSON im Request-Body." }, { status: 400 });
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    const status = e instanceof CancelError ? 422 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
