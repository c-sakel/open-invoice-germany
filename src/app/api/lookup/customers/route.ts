import { runLookup } from "@/lib/http/lookup-route";
import { lookupCustomers } from "@/domain/customer/lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/lookup/customers?q=&limit=&ids=` — Kundenauswahl im Belegeditor. */
export async function GET(req: Request) {
  return runLookup("/api/lookup/customers", req, (orgId, raw) => lookupCustomers(orgId, raw));
}
