import { NextResponse } from "next/server";
import { finalizeInvoice, FinalizeError } from "@/domain/invoice/finalize";
import { collectFinalizeWarnings } from "@/domain/invoice/finalize-warnings";
import { getActiveOrg } from "@/lib/org";
import { describeError, INTERNAL_ERROR_TEXT } from "@/lib/safe-error";
import { AuthRequiredError, authRequiredResponse, requireSessionActor } from "@/lib/auth/require-session";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const actor = await requireSessionActor();
    const warnings = (await collectFinalizeWarnings(org.id, id)).map((w) => w.message);
    const invoice = await finalizeInvoice(id, { actor });
    return NextResponse.json({ id: invoice.id, number: invoice.number, status: invoice.status, warnings });
  } catch (e) {
    if (e instanceof AuthRequiredError) return authRequiredResponse();
    const status = e instanceof FinalizeError ? 422 : 500;
    if (status === 500) {
      console.error("/api/invoices/[id]/finalize:", describeError(e));
      return NextResponse.json({ error: INTERNAL_ERROR_TEXT }, { status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
