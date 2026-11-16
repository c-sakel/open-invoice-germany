/**
 * Pruefung der Bankverbindung gegen frueher angenommene Rechnungen desselben Lieferanten:
 * eine geaenderte IBAN ist ein klassisches Betrugsmuster und wird als Warnung gezeigt.
 */
import { ciContains, dbInternal } from "@/lib/db";
import { normalizeIban } from "@/lib/iban";
import { normalizeVatId } from "@/lib/vat-id";
import { parsedIncomingInvoiceSchema } from "@/schemas/incoming";
import { normalizeName } from "./receive";
import { firstNameToken } from "./supplier";

export interface IncomingRowForIban {
  id: string;
  receivedAt: Date;
  supplierContactId: string | null;
  supplierVatId: string | null;
  supplierName: string | null;
}

export interface PreviousIban {
  id: string;
  number: string | null;
  iban: string;
}

export type IbanWarning = { code: "IBAN_CHANGED" | "FIRST_IBAN"; previous: PreviousIban | null };

const MAX_PREVIOUS = 50;

function ibanOfPayment(paymentJson: string | null): string | null {
  if (paymentJson === null) return null;
  try {
    const r = parsedIncomingInvoiceSchema.shape.payment.safeParse(JSON.parse(paymentJson));
    if (!r.success) return null;
    const m = r.data.means.find((x) => x.iban !== null && normalizeIban(x.iban) !== "");
    return m?.iban != null ? normalizeIban(m.iban) : null;
  } catch {
    return null;
  }
}

export async function previousSupplierIban(orgId: string, row: IncomingRowForIban): Promise<PreviousIban | null> {
  const vat = row.supplierVatId !== null && row.supplierVatId.trim() !== "" ? normalizeVatId(row.supplierVatId) : null;
  const name = normalizeName(row.supplierName);
  const token = firstNameToken(row.supplierName);

  let supplier: Record<string, unknown>;
  if (row.supplierContactId !== null) supplier = { supplierContactId: row.supplierContactId };
  else if (vat !== null && vat.length >= 4) supplier = { supplierVatId: ciContains(vat.slice(0, 2)) };
  else if (name !== null && token !== null) supplier = { supplierName: ciContains(token) };
  else return null;

  const cands = await dbInternal.incomingInvoice.findMany({
    where: {
      orgId,
      status: { not: "REJECTED" },
      id: { not: row.id },
      OR: [{ receivedAt: { lt: row.receivedAt } }, { receivedAt: row.receivedAt, id: { lt: row.id } }],
      ...supplier,
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: MAX_PREVIOUS,
    select: { id: true, number: true, supplierVatId: true, supplierName: true, paymentJson: true },
  });
  for (const c of cands) {
    if (row.supplierContactId === null) {
      const same =
        vat !== null && vat.length >= 4
          ? c.supplierVatId !== null && normalizeVatId(c.supplierVatId) === vat
          : name !== null && normalizeName(c.supplierName) === name;
      if (!same) continue;
    }
    const iban = ibanOfPayment(c.paymentJson);
    if (iban !== null) return { id: c.id, number: c.number, iban };
  }
  return null;
}

export function ibanWarning(currentIban: string | null, previous: PreviousIban | null): IbanWarning | null {
  if (currentIban === null) return null;
  if (previous === null) return { code: "FIRST_IBAN", previous: null };
  return normalizeIban(currentIban) === normalizeIban(previous.iban) ? null : { code: "IBAN_CHANGED", previous };
}
