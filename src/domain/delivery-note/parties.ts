/**
 * Parteien eines Lieferscheins: Aufloesung von Ansprechpartner/Lieferadresse (mit
 * Kunden-Defaults) und Bau der Seller/Buyer/Contact-Snapshots. Gemeinsam genutzt von
 * Anlage (create.ts), Entwurf-Bearbeitung (update.ts) und DRAFT -> CREATED (status.ts).
 */
import type { Customer, Prisma } from "@/generated/prisma/client";
import { buildSellerSnapshot, buildContactSnapshot } from "@/domain/snapshot";
import { resolveBuyerSnapshot } from "@/domain/document/snapshot-input";
import { DeliveryNoteError, DeliveryNoteValidationError } from "@/domain/delivery-note/errors";

/**
 * Phase 8a (§29/§30): fehlt die Angabe komplett (`undefined`), greift die
 * Default-Lieferadresse/der Default-Ansprechpartner des Kunden (analog
 * createDraftInvoiceWithinTx/createBusinessDocumentWithinTx). Explizites `null`
 * uebernimmt bewusst keinen Default.
 */
export async function resolveDeliveryParties(
  tx: Prisma.TransactionClient,
  orgId: string,
  customerId: string,
  input: { contactPersonId?: string | null; shippingAddressId?: string | null },
): Promise<{ customer: Customer; contactPersonId: string | null; shippingAddressId: string | null }> {
  const customer = await tx.customer.findFirst({ where: { id: customerId, orgId } });
  if (!customer) throw new DeliveryNoteError("Kunde nicht gefunden.");

  let contactPersonId = input.contactPersonId;
  if (contactPersonId) {
    const contact = await tx.contactPerson.findFirst({ where: { id: contactPersonId, orgId, customerId }, select: { id: true } });
    if (!contact) throw new DeliveryNoteError("Ansprechpartner nicht gefunden.");
  } else if (contactPersonId === undefined) {
    const defaultContact = await tx.contactPerson.findFirst({ where: { orgId, customerId, isDefault: true }, select: { id: true } });
    contactPersonId = defaultContact?.id ?? null;
  }
  let shippingAddressId = input.shippingAddressId;
  if (shippingAddressId) {
    const address = await tx.customerAddress.findFirst({ where: { id: shippingAddressId, orgId, customerId }, select: { id: true, type: true } });
    if (!address) throw new DeliveryNoteError("Lieferadresse nicht gefunden.");
    // Nit (Fix-Welle): eine Lieferadresse ist SHIPPING oder OTHER, keine BILLING-Adresse.
    if (address.type === "BILLING") throw new DeliveryNoteValidationError("Als Lieferadresse ist keine Rechnungsadresse (BILLING) zulaessig.");
  } else if (shippingAddressId === undefined) {
    const defaultAddress = await tx.customerAddress.findFirst({ where: { orgId, customerId, type: "SHIPPING", isDefault: true }, select: { id: true } });
    shippingAddressId = defaultAddress?.id ?? null;
  }
  return { customer, contactPersonId: contactPersonId ?? null, shippingAddressId: shippingAddressId ?? null };
}

/**
 * Fix-Welle B2: resolveBuyerSnapshot bekommt IMMER billingAddressId: null — die
 * flachen Buyer-Postfelder (BG-8, addressLine1 etc.) bleiben Kundenstamm/Default-BILLING,
 * NICHT die Lieferadresse (sonst landete die Lieferadresse als Rechnungsadresse im
 * Snapshot und vererbte sich in eine daraus abgeleitete Teilrechnung). Die gewaehlte
 * Lieferadresse landet stattdessen strukturiert unter buyerSnapshot.shippingAddress.
 */
export async function buildDeliveryNoteSnapshots(
  tx: Prisma.TransactionClient,
  orgId: string,
  customer: Customer,
  contactPersonId: string | null,
  shippingAddressId: string | null,
): Promise<{ sellerSnapshotJson: string; buyerSnapshotJson: string; contactSnapshotJson: string | null }> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });
  const buyerSnapshot = await resolveBuyerSnapshot(tx, orgId, customer, contactPersonId, null);
  if (shippingAddressId) {
    const shipAddr = await tx.customerAddress.findFirst({ where: { id: shippingAddressId, orgId } });
    if (shipAddr) {
      buyerSnapshot.shippingAddress = {
        type: shipAddr.type as "BILLING" | "SHIPPING" | "OTHER",
        label: shipAddr.label,
        addressLine1: shipAddr.addressLine1,
        addressLine2: shipAddr.addressLine2,
        postalCode: shipAddr.postalCode,
        city: shipAddr.city,
        countryCode: shipAddr.countryCode,
      };
    }
  }
  let contactSnapshotJson: string | null = null;
  if (contactPersonId) {
    const contact = await tx.contactPerson.findFirst({ where: { id: contactPersonId, orgId } });
    if (contact) {
      contactSnapshotJson = JSON.stringify(
        buildContactSnapshot({ firstName: contact.firstName, lastName: contact.lastName, role: contact.role, email: contact.email, phone: contact.phone }),
      );
    }
  }
  return { sellerSnapshotJson: JSON.stringify(buildSellerSnapshot(org)), buyerSnapshotJson: JSON.stringify(buyerSnapshot), contactSnapshotJson };
}

/**
 * Ein Lieferschein mit Quelle (Angebot/Rechnung) gehoert zum Kunden der Quelle: sonst wuerde er
 * die Restmenge des Quellbelegs eines anderen Kunden verbrauchen. Die Quelle muss zur Organisation
 * gehoeren (sonst "nicht gefunden").
 */
export async function assertCustomerMatchesSource(
  tx: Prisma.TransactionClient,
  orgId: string,
  sourceType: string,
  sourceId: string,
  customerId: string,
): Promise<void> {
  const source =
    sourceType === "INVOICE"
      ? await tx.invoice.findFirst({ where: { id: sourceId, orgId }, select: { customerId: true } })
      : sourceType === "QUOTE"
        ? await tx.quote.findFirst({ where: { id: sourceId, orgId }, select: { customerId: true } })
        : null;
  if (!source) throw new DeliveryNoteError(`Quelldokument ${sourceId} nicht gefunden.`);
  if (source.customerId !== customerId) {
    throw new DeliveryNoteValidationError("Der Kunde muss dem Kunden des Quelldokuments entsprechen.");
  }
}
