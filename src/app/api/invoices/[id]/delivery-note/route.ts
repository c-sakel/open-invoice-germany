import { NextResponse } from "next/server";
import { z } from "zod";
import { convertDocument, ConvertError } from "@/domain/document/convert";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    quantities: z.array(z.object({ sourceLineId: z.string().min(1), quantityMilli: z.number().int().nonnegative() })).optional(),
    deliveryDate: z.coerce.date().optional(),
  })
  .default({});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const org = await getActiveOrg();
    const actor = (await getCurrentUserId()) ?? "system";

    let raw: unknown = {};
    const text = await req.text();
    if (text.trim() !== "") raw = JSON.parse(text);
    const body = bodySchema.parse(raw);

    const result = await convertDocument(
      org.id,
      { fromType: "INVOICE", fromId: id, toKind: "DELIVERY_NOTE", quantities: body.quantities, deliveryDate: body.deliveryDate },
      { actor },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    const status = e instanceof ConvertError ? 409 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
