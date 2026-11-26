import { NextResponse } from "next/server";
import { emitRecurringNow, isSkipped } from "@/domain/recurring/run";
import { RecurringError } from "@/domain/recurring/create";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { describeError, INTERNAL_ERROR_TEXT } from "@/lib/safe-error";
import { AuthRequiredError, authRequiredResponse, requireSessionActor } from "@/lib/auth/require-session";

export const runtime = "nodejs";

const NO_USAGE_MESSAGE = "Keine Verbräuche im Zeitraum — keine Rechnung erzeugt.";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const actor = await requireSessionActor();
    const rec = await dbInternal.recurringInvoice.findFirst({ where: { id, orgId: org.id }, select: { id: true } });
    if (!rec) return NextResponse.json({ error: "Abo nicht gefunden." }, { status: 404 });
    const res = await emitRecurringNow(id, { actor });
    if (isSkipped(res)) return NextResponse.json({ skipped: true, periodDate: res.periodDate, message: NO_USAGE_MESSAGE });
    return NextResponse.json({
      invoiceId: res.invoiceId,
      number: res.number,
      finalized: res.finalized,
      collectiveCount: res.collectiveRecurringIds?.length ?? 1,
    });
  } catch (e) {
    if (e instanceof AuthRequiredError) return authRequiredResponse();
    if (e instanceof RecurringError) return NextResponse.json({ error: e.message }, { status: 422 });
    console.error("POST /api/recurring/[id]/run:", describeError(e));
    return NextResponse.json({ error: INTERNAL_ERROR_TEXT }, { status: 500 });
  }
}
