import { NextResponse } from "next/server";
import { getCancelPreview } from "@/domain/invoice/cancel-preview";
import { NotFoundError } from "@/domain/errors";
import { getActiveOrg } from "@/lib/org";
import { describeError, INTERNAL_ERROR_TEXT } from "@/lib/safe-error";

export const runtime = "nodejs";

/** Vorschau fuer den Storno-Dialog (Betrag, Erstattung, Mahnstufe) — nur lesend, mandantengeprueft. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    return NextResponse.json(await getCancelPreview(id, org.id));
  } catch (e) {
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    console.error("/api/invoices/[id]/cancel-preview:", describeError(e));
    return NextResponse.json({ error: INTERNAL_ERROR_TEXT }, { status: 500 });
  }
}
