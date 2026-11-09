import { NextResponse } from "next/server";
import { getCancelPreview } from "@/domain/invoice/cancel-preview";
import { NotFoundError } from "@/domain/errors";
import { getActiveOrg } from "@/lib/org";

export const runtime = "nodejs";

/** Vorschau fuer den Storno-Dialog (Betrag, Erstattung, Mahnstufe) — nur lesend, mandantengeprueft. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    return NextResponse.json(await getCancelPreview(id, org.id));
  } catch (e) {
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
