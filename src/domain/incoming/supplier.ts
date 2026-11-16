/**
 * Lieferanten-Zuordnung: Vorschlaege aus den Kontakten (USt-IdNr., dann Name) und Anlegen eines
 * Kontakts aus den Angaben der Rechnung. Ohne VIES-Aufruf, ohne Netz.
 */
import { ciContains, dbInternal } from "@/lib/db";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { normalizeVatId } from "@/lib/vat-id";
import { appendChangeLog } from "@/domain/audit";
import { NotFoundError } from "@/domain/errors";
import { assertCustomerCreatable, createCustomerWithinTx } from "@/domain/customer/save";
import { customerSchema } from "@/schemas";
import { incomingContactInputSchema, incomingPartySchema } from "@/schemas/incoming";
import { IncomingWorkflowError } from "./errors";
import { INCOMING_HEADER_SELECT, type IncomingHeaderRow } from "./header";
import { normalizeName } from "./receive";
import { EDITABLE_STATUSES, parseManual } from "./update";

export interface SupplierSuggestion {
  id: string;
  name: string;
  customerNumber: string | null;
  vatId: string | null;
  match: "VAT_ID" | "NAME";
}

const MAX_SUGGESTIONS = 5;
const MAX_CANDIDATES = 50;
const MAX_VAT_CANDIDATES = 500;

/** Erstes aussagekraeftiges Wort des Namens (zum Vorfiltern in der Datenbank). */
export function firstNameToken(name: string | null): string | null {
  if (name === null) return null;
  const tok = name.split(/[^\p{L}\p{N}]+/u).find((t) => t.length >= 3);
  return tok ?? null;
}

export async function suggestSupplierContacts(
  orgId: string,
  row: { supplierVatId: string | null; supplierName: string | null },
): Promise<SupplierSuggestion[]> {
  const select = { id: true, name: true, customerNumber: true, vatId: true } as const;
  const out: SupplierSuggestion[] = [];
  const seen = new Set<string>();

  const vat = row.supplierVatId !== null && row.supplierVatId.trim() !== "" ? normalizeVatId(row.supplierVatId) : null;
  if (vat !== null && vat.length >= 4) {
    // In den Kontakten steht die USt-IdNr. evtl. mit Leerzeichen: nach dem Laendercode vorfiltern, dann normalisiert vergleichen.
    const cands = await dbInternal.customer.findMany({
      where: { orgId, isArchived: false, vatId: ciContains(vat.slice(0, 2)) },
      select,
      orderBy: { name: "asc" },
      take: MAX_VAT_CANDIDATES,
    });
    for (const c of cands) {
      if (c.vatId !== null && normalizeVatId(c.vatId) === vat && !seen.has(c.id)) {
        seen.add(c.id);
        out.push({ ...c, match: "VAT_ID" });
      }
    }
  }

  const norm = normalizeName(row.supplierName);
  const token = firstNameToken(row.supplierName);
  if (norm !== null && token !== null && out.length < MAX_SUGGESTIONS) {
    const cands = await dbInternal.customer.findMany({
      where: { orgId, isArchived: false, name: ciContains(token) },
      select,
      orderBy: { name: "asc" },
      take: MAX_CANDIDATES,
    });
    for (const c of cands) {
      if (!seen.has(c.id) && normalizeName(c.name) === norm) {
        seen.add(c.id);
        out.push({ ...c, match: "NAME" });
      }
    }
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

function emptyToUndefined(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export async function createContactFromIncoming(
  orgId: string,
  id: string,
  raw: unknown,
  actor: string,
  now: Date = new Date(),
): Promise<{ contactId: string; header: IncomingHeaderRow }> {
  const overrides = incomingContactInputSchema.parse(raw ?? {});
  const row =
    id.length <= 64
      ? await dbInternal.incomingInvoice.findFirst({ where: { id, orgId }, select: { status: true, supplierContactId: true, supplierJson: true, manualJson: true } })
      : null;
  if (!row) throw new NotFoundError("Eingangsrechnung nicht gefunden.");
  if (row.supplierContactId !== null) throw new IncomingWorkflowError("Die Rechnung ist bereits einem Kontakt zugeordnet.", "ALREADY_ASSIGNED");
  if (!EDITABLE_STATUSES.includes(row.status)) throw new IncomingWorkflowError("Die Zuordnung ist in diesem Status gesperrt.", "STATUS_LOCKED");

  let party: ReturnType<typeof incomingPartySchema.parse> | null = null;
  if (row.supplierJson !== null) {
    try {
      const r = incomingPartySchema.safeParse(JSON.parse(row.supplierJson));
      party = r.success ? r.data : null;
    } catch {
      party = null;
    }
  }
  const manual = parseManual(row.manualJson);

  const candidate = {
    type: "BUSINESS" as const,
    name: overrides.name ?? emptyToUndefined(party?.name) ?? manual?.supplierName,
    addressLine1: overrides.addressLine1 ?? emptyToUndefined(party?.address?.street),
    postalCode: overrides.postalCode ?? emptyToUndefined(party?.address?.postalCode),
    city: overrides.city ?? emptyToUndefined(party?.address?.city),
    countryCode: overrides.countryCode ?? emptyToUndefined(party?.address?.countryCode),
    email: overrides.email ?? emptyToUndefined(party?.contact?.email),
    phone: emptyToUndefined(party?.contact?.phone),
    vatId: overrides.vatId ?? emptyToUndefined(party?.vatId),
  };
  const parsed = customerSchema.safeParse(candidate);
  const missing = new Set<string>();
  if (!parsed.success) for (const i of parsed.error.issues) missing.add(String(i.path[0] ?? "name"));
  // Das Land wird nie geraten: fehlt es in der Datei, muss es angegeben werden.
  if (candidate.countryCode === undefined) missing.add("countryCode");
  if (missing.size > 0 || !parsed.success) {
    throw new IncomingWorkflowError("Fuer den Kontakt fehlen Angaben.", "CONTACT_INCOMPLETE", { fields: [...missing], prefill: candidate });
  }
  assertCustomerCreatable(parsed.data);

  return withChangeLogRetry(() =>
    dbInternal.$transaction(async (tx) => {
      const c = await createCustomerWithinTx(tx, orgId, parsed.data);
      const res = await tx.incomingInvoice.updateMany({
        where: { id, orgId, status: row.status, supplierContactId: null },
        data: { supplierContactId: c.id },
      });
      if (res.count !== 1) throw new IncomingWorkflowError("Die Rechnung wurde zwischenzeitlich geaendert.", "STATUS_CONFLICT");
      await appendChangeLog(tx, {
        orgId,
        entity: "INCOMING_INVOICE",
        entityId: id,
        action: "UPDATE",
        actor,
        at: now,
        diff: { supplierContactId: { from: null, to: c.id }, contactCreated: true },
      });
      const header = await tx.incomingInvoice.findFirstOrThrow({ where: { id, orgId }, select: INCOMING_HEADER_SELECT });
      return { contactId: c.id, header };
    }),
  );
}
