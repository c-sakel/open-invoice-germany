import { runLookup } from "@/lib/http/lookup-route";
import { lookupProducts } from "@/domain/product/lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/lookup/products?q=&limit=&ids=` — Produktauswahl im Belegeditor. */
export async function GET(req: Request) {
  return runLookup("/api/lookup/products", req, (orgId, raw) => lookupProducts(orgId, raw));
}
