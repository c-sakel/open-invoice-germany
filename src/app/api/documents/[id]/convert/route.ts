import { NextResponse } from "next/server";
import { z } from "zod";
import { convertDocument, ConvertError } from "@/domain/document/convert";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";

export const runtime = "nodejs";

// Body optional: fehlt er oder ist er leer ({}), bleibt der alte ConvertButton-Aufruf
// (In-Rechnung-Umwandeln ohne Body) kompatibel. fromType/fromId kommen aus der URL
// (fromType immer QUOTE), nicht aus dem Body.
const bodySchema = z
  .object({
    toKind: z.enum(["AUFTRAGSBESTAETIGUNG", "INVOICE", "DELIVERY_NOTE"]).default("INVOICE"),
    quantities: z.array(z.object({ sourceLineId: z.string().min(1), quantityMilli: z.number().int().nonnegative() })).optional(),
    deliveryDate: z.coerce.date().optional(),
  })
  .default({ toKind: "INVOICE" });

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
      { fromType: "QUOTE", fromId: id, toKind: body.toKind, quantities: body.quantities, deliveryDate: body.deliveryDate },
      { actor },
    );

    // invoiceId bleibt fuer Rueckwaertskompatibilitaet des alten ConvertButton-Aufrufs erhalten.
    return NextResponse.json({ type: result.type, id: result.id, invoiceId: result.type === "INVOICE" ? result.id : undefined });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400 });
    }
    const status = e instanceof ConvertError ? 409 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
