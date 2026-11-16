/**
 * Pruefung der Bankverbindung gegen frueher angenommene Rechnungen desselben Lieferanten:
 * eine geaenderte IBAN ist ein klassisches Betrugsmuster und wird als Warnung gezeigt.
 */
import { ciContains, dbInternal } from "@/lib/db";
import { normalizeIban } from "@/lib/iban";
import { normalizeVatId } from "@/lib/vat-id";
import { parsedIncomingInvoiceSchema } from "@/schemas/incoming";
import { normalizeName } from "./receive";
import { pickTransferMeans } from "./payment-instruction";
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

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

export function ibanOfPayment(paymentJson: string | null): string | null {
  if (paymentJson === null) return null;
  try {
    const r = parsedIncomingInvoiceSchema.shape.payment.safeParse(JSON.parse(paymentJson));
    if (!r.success) return null;
    const m = pickTransferMeans(r.data.means);
    return m?.iban != null ? normalizeIban(m.iban) : null;
  } catch {
    return null;
  }
}

/**
 * Letzte frueher angenommene IBAN desselben Lieferanten. Ohne Kontakt-Zuordnung wird ueber den
 * Lieferanten-Schluessel (USt-IdNr., sonst Name) verglichen; die Abfrage laeuft in Bloecken, damit
 * fremde Lieferanten mit gleichem Laendercode den Vorgaenger nicht verdraengen.
 */
export async function previousSupplierIban(
  orgId: string,
  row: IncomingRowForIban,
  pageSize: number = PAGE_SIZE,
): Promise<PreviousIban | null> {
  const vat = row.supplierVatId !== null && row.supplierVatId.trim() !== "" ? normalizeVatId(row.supplierVatId) : null;
  const name = normalizeName(row.supplierName);
  const token = firstNameToken(row.supplierName);

  // Lieferanten-Schluessel ohne Zuordnung: USt-IdNr. (Vorfilter auf deren letzte Ziffern), sonst Name.
  let keyFilter: Record<string, unknown> | null = null;
  if (vat !== null && vat.length >= 4) keyFilter = { supplierVatId: ciContains(vat.slice(-3)) };
  else if (name !== null && token !== null) keyFilter = { supplierName: ciContains(token) };

  // Mit Zuordnung zaehlen auch fruehere, noch nicht zugeordnete Rechnungen desselben Lieferanten.
  let supplier: Record<string, unknown>;
  if (row.supplierContactId !== null) {
    supplier = {
      OR: [
        { supplierContactId: row.supplierContactId },
        ...(keyFilter !== null ? [{ supplierContactId: null, ...keyFilter }] : []),
      ],
    };
  } else if (keyFilter !== null) supplier = keyFilter;
  else return null;

  let bound: { receivedAt: Date; id: string } = { receivedAt: row.receivedAt, id: row.id };
  for (let page = 0; page < MAX_PAGES; page++) {
    const cands = await dbInternal.incomingInvoice.findMany({
      where: {
        orgId,
        status: { not: "REJECTED" },
        id: { not: row.id },
        AND: [
          { OR: [{ receivedAt: { lt: bound.receivedAt } }, { receivedAt: bound.receivedAt, id: { lt: bound.id } }] },
          supplier,
        ],
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: pageSize,
      select: { id: true, receivedAt: true, number: true, supplierContactId: true, supplierVatId: true, supplierName: true, paymentJson: true },
    });
    for (const c of cands) {
      if (row.supplierContactId === null || c.supplierContactId === null) {
        const same =
          vat !== null && vat.length >= 4
            ? c.supplierVatId !== null && normalizeVatId(c.supplierVatId) === vat
            : name !== null && normalizeName(c.supplierName) === name;
        if (!same) continue;
      }
      const iban = ibanOfPayment(c.paymentJson);
      if (iban !== null) return { id: c.id, number: c.number, iban };
    }
    const last = cands[cands.length - 1];
    if (cands.length < pageSize || !last) break;
    bound = { receivedAt: last.receivedAt, id: last.id };
  }
  return null;
}

export function ibanWarning(currentIban: string | null, previous: PreviousIban | null): IbanWarning | null {
  if (currentIban === null) return null;
  if (previous === null) return { code: "FIRST_IBAN", previous: null };
  return normalizeIban(currentIban) === normalizeIban(previous.iban) ? null : { code: "IBAN_CHANGED", previous };
}
