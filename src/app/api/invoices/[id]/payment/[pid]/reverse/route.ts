import { NextResponse } from "next/server";
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { PaymentError } from "@/domain/invoice/payment";
import { NotFoundError } from "@/domain/errors";
import { reversePaymentInputSchema } from "@/schemas/payment-correction";

export const runtime = "nodejs";

/** Zahlung per Gegenbuchung korrigieren (Belegansicht, Phase 16a). Die Zahlung muss zur Rechnung
 *  in der URL UND zur aktiven Organisation gehoeren, sonst 404. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; pid: string }> }) {
  const { id, pid } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const owned = await dbInternal.payment.findFirst({
      where: { id: pid, invoiceId: id, invoice: { orgId: org.id } },
      select: { id: true },
    });
    if (!owned) return NextResponse.json({ error: "Zahlung nicht gefunden." }, { status: 404 });

    const raw = await req.text();
    const input = reversePaymentInputSchema.parse(raw ? JSON.parse(raw) : {});
    const result = await reversePayment(pid, input, { actor: "user", orgId: org.id });
    return NextResponse.json({
      reversalId: result.reversal.id,
      status: result.invoiceStatus,
      paidAmountCents: result.paidAmountCents,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    if (e instanceof SyntaxError) return NextResponse.json({ error: "Ungültiges JSON im Request-Body." }, { status: 400 });
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    // Fachlicher Konflikt wie REST (Spec: 409); sonst generische Meldung ohne interne Details.
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error("payment reverse: unerwarteter Fehler", e);
    return NextResponse.json({ error: "Interner Fehler bei der Gegenbuchung." }, { status: 500 });
  }
}
