import { NextResponse } from "next/server";
import { convertDocumentToInvoice, ConvertError } from "@/domain/document/convert";
import { getActiveOrg } from "@/lib/org";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const invoice = await convertDocumentToInvoice(org.id, id);
    return NextResponse.json({ invoiceId: invoice.id });
  } catch (e) {
    const status = e instanceof ConvertError ? 422 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
