/**
 * Such-Endpunkte fuer den Belegeditor: Kundenauswahl (serverseitig, org-gescoped) und
 * Kundenkontext (Kontakte/Adressen nur dieses Kunden).
 */
import { prisma, ciContains } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { lookupQuerySchema, type EditorCustomerContext } from "@/schemas/lookup";
import { formatAddressLabel, formatContactLabel } from "@/domain/customer/editor-labels";

export interface CustomerLookupRow {
  id: string;
  name: string;
  customerNumber: string | null;
  city: string;
  email: string | null;
  isArchived: boolean;
}

const LOOKUP_DB_TAKE = 60;

function rank(row: CustomerLookupRow, q: string): number {
  const needle = q.toLowerCase();
  if (!needle) return 0;
  return row.name.toLowerCase().startsWith(needle) || (row.customerNumber ?? "").toLowerCase().startsWith(needle) ? 0 : 1;
}

export async function lookupCustomers(orgId: string, raw: unknown): Promise<CustomerLookupRow[]> {
  const { q, limit, ids } = lookupQuerySchema.parse(raw);
  const select = { id: true, name: true, customerNumber: true, city: true, email: true, isArchived: true } as const;
  if (ids && ids.length > 0) {
    const rows = await prisma.customer.findMany({ where: { orgId, id: { in: ids } }, select });
    // Archivierte bleiben ueber ihre Id aufloesbar (Label gewaehlter Eintraege); die Suche q liefert sie nie.
    // Reihenfolge der angefragten Ids beibehalten (zuletzt verwendet zuerst).
    return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is CustomerLookupRow => r !== undefined);
  }
  const rows = await prisma.customer.findMany({
    where: {
      orgId,
      isArchived: false,
      ...(q
        ? {
            OR: [
              { name: ciContains(q) },
              { customerNumber: ciContains(q) },
              { email: ciContains(q) },
              { city: ciContains(q) },
              { vatId: ciContains(q) },
            ],
          }
        : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: q ? LOOKUP_DB_TAKE : limit,
    select,
  });
  return rows
    .map((r, i) => ({ r, i, k: rank(r, q) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.r);
}

/** Kundenkontext fuer den Editor. Archivierte Kunden bleiben ladbar (Entwuerfe mit archiviertem Kunden), mit `isArchived`. */
export async function loadCustomerForEditor(orgId: string, id: string): Promise<EditorCustomerContext> {
  const customer = await prisma.customer.findFirst({
    where: { id, orgId },
    select: {
      id: true,
      name: true,
      customerNumber: true,
      email: true,
      invoiceEmail: true,
      defaultPaymentMethodId: true,
      defaultDiscountPermille: true,
      defaultCurrency: true,
      language: true,
      defaultPaymentTermsDays: true,
      addressLine1: true,
      postalCode: true,
      city: true,
      countryCode: true,
      vatId: true,
      isArchived: true,
    },
  });
  if (!customer) throw new NotFoundError("Kunde nicht gefunden.");
  const [contactRows, addressRows] = await Promise.all([
    prisma.contactPerson.findMany({
      where: { orgId, customerId: id },
      orderBy: { lastName: "asc" },
      select: { id: true, firstName: true, lastName: true, role: true, isDefault: true },
    }),
    prisma.customerAddress.findMany({
      where: { orgId, customerId: id },
      orderBy: { label: "asc" },
      select: { id: true, type: true, isDefault: true, label: true, addressLine1: true, postalCode: true, city: true },
    }),
  ]);
  return {
    customer,
    contacts: contactRows.map((c) => ({ id: c.id, name: formatContactLabel(c), isDefault: c.isDefault })),
    addresses: addressRows.map((a) => ({
      id: a.id,
      type: a.type as "BILLING" | "SHIPPING" | "OTHER",
      isDefault: a.isDefault,
      label: formatAddressLabel(a),
    })),
  };
}

/**
 * Vorbelegung der Editor-Seiten: nur der vorgewaehlte Kunde (Entwurf bzw. `?customerId=`) samt
 * Kontakten und Adressen, nie die Kundenliste. Unbekannte/fremde Ids ergeben eine leere Vorbelegung.
 * `allowArchived=false` (Neuanlage) ignoriert archivierte Kunden.
 */
export async function loadEditorCustomerBootstrap(orgId: string, customerId: string | null | undefined, allowArchived: boolean) {
  const empty = {
    customers: [] as EditorCustomerContext["customer"][],
    contacts: [] as Array<EditorCustomerContext["contacts"][number] & { customerId: string }>,
    addresses: [] as Array<EditorCustomerContext["addresses"][number] & { customerId: string }>,
  };
  if (!customerId) return empty;
  let ctx: EditorCustomerContext;
  try {
    ctx = await loadCustomerForEditor(orgId, customerId);
  } catch (e) {
    if (e instanceof NotFoundError) return empty;
    throw e;
  }
  if (ctx.customer.isArchived && !allowArchived) return empty;
  return {
    customers: [ctx.customer],
    contacts: ctx.contacts.map((c) => ({ ...c, customerId: ctx.customer.id })),
    addresses: ctx.addresses.map((a) => ({ ...a, customerId: ctx.customer.id })),
  };
}
