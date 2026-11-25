import { runLookup } from "@/lib/http/lookup-route";
import { loadCustomerForEditor } from "@/domain/customer/lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/lookup/customers/<id>` — Kunde samt Kontakten und Adressen fuer den Belegeditor. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return runLookup("/api/lookup/customers/[id]", null, (orgId) => loadCustomerForEditor(orgId, id));
}
