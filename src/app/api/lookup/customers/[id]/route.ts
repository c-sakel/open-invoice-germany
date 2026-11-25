import { NextResponse } from "next/server";
import { z } from "zod";
import { runLookup } from "@/lib/http/lookup-route";
import { loadCustomerForEditor } from "@/domain/customer/lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/lookup/customers/<id>` — Kunde samt Kontakten und Adressen fuer den Belegeditor. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = z.string().min(1).max(64).safeParse((await ctx.params).id);
  if (!parsed.success) return NextResponse.json({ error: "Ungültige Kunden-Id." }, { status: 400 });
  const id = parsed.data;
  return runLookup("/api/lookup/customers/[id]", null, (orgId) => loadCustomerForEditor(orgId, id));
}
