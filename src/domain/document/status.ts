/**
 * Zustandsmaschine fuer Angebot/Auftragsbestaetigung (Quote) und Lieferschein
 * (DeliveryNote). Jeder Statuswechsel prueft die Uebergangstabelle, laeuft in
 * einer Transaktion und schreibt einen ChangeLog-Eintrag (GoBD-Nachvollziehbarkeit,
 * auch wenn diese Belege selbst nicht GoBD-festgeschrieben werden).
 */
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { buildSellerSnapshot, buildBuyerSnapshot } from "@/domain/snapshot";
import { QuoteStatus, DeliveryNoteStatus, type SnapshotSource } from "@/schemas";
import type { Quote, DeliveryNote, Prisma } from "@/generated/prisma/client";

export class StatusTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusTransitionError";
  }
}

// DRAFT->ACCEPTED/REJECTED erlaubt: Annahme/Ablehnung ohne vorherigen digitalen Versand
// (Postversand, telefonische Zusage) — Ruling des Betreibers.
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  DRAFT: ["SENT", "ACCEPTED", "REJECTED", "CANCELLED"],
  SENT: ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  ACCEPTED: ["CANCELLED"],
  REJECTED: [],
  EXPIRED: ["SENT", "ACCEPTED"],
  CANCELLED: [],
};

export const DELIVERY_TRANSITIONS: Record<DeliveryNoteStatus, readonly DeliveryNoteStatus[]> = {
  DRAFT: ["CREATED", "CANCELLED"],
  CREATED: ["SENT", "DELIVERED", "CANCELLED"],
  SENT: ["DELIVERED", "CANCELLED"],
  DELIVERED: ["CANCELLED"],
  CANCELLED: [],
};

/** Prueft anhand einer Uebergangstabelle, ob von `from` nach `to` gewechselt werden darf. */
export function assertTransition<S extends string>(table: Record<S, readonly S[]>, from: S, to: S): void {
  if (!table[from].includes(to)) {
    throw new StatusTransitionError(`Uebergang von "${from}" nach "${to}" ist nicht erlaubt.`);
  }
}

interface StatusOptions {
  actor?: string;
  now?: Date;
  note?: string;
}

/**
 * Setzt den Status eines Angebots/einer Auftragsbestaetigung. Bei SENT wird — falls
 * noch kein Snapshot existiert — der Kaeufer-/Verkaeufer-Snapshot eingefroren
 * (Quelle "SENT"), damit spaetere Stammdatenaenderungen das versendete Dokument nicht
 * rueckwirkend veraendern. Bei ACCEPTED/REJECTED werden decidedAt/decisionNote gesetzt.
 */
export async function setQuoteStatus(
  orgId: string,
  quoteId: string,
  to: QuoteStatus,
  opts: StatusOptions = {},
): Promise<Quote> {
  const target = QuoteStatus.parse(to);
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";

  return dbInternal.$transaction(async (tx) => {
    const quote = await tx.quote.findFirst({ where: { id: quoteId, orgId } });
    if (!quote) throw new StatusTransitionError(`Angebot ${quoteId} nicht gefunden.`);

    const from = QuoteStatus.parse(quote.status);
    assertTransition(QUOTE_TRANSITIONS, from, target);

    const data: Prisma.QuoteUpdateInput = { status: target };

    if (target === "SENT") {
      data.sentAt = now;
      if (!quote.buyerSnapshotJson) {
        const customer = await tx.customer.findFirstOrThrow({ where: { id: quote.customerId, orgId } });
        const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });

        let contactName: string | null = customer.contactName ?? null;
        let addressLine1 = customer.addressLine1;
        let addressLine2 = customer.addressLine2;
        let postalCode = customer.postalCode;
        let city = customer.city;
        let countryCode = customer.countryCode;

        if (quote.contactPersonId) {
          const contact = await tx.contactPerson.findFirst({ where: { id: quote.contactPersonId, orgId } });
          if (contact) contactName = `${contact.firstName} ${contact.lastName}`.trim();
        }
        if (quote.billingAddressId) {
          const address = await tx.customerAddress.findFirst({ where: { id: quote.billingAddressId, orgId } });
          if (address) {
            addressLine1 = address.addressLine1;
            addressLine2 = address.addressLine2;
            postalCode = address.postalCode;
            city = address.city;
            countryCode = address.countryCode;
          }
        }

        const buyer = buildBuyerSnapshot({
          name: customer.name,
          contactName,
          addressLine1,
          addressLine2,
          postalCode,
          city,
          countryCode,
          vatId: customer.vatId,
          email: customer.email,
          leitwegId: customer.leitwegId,
        });
        const seller = buildSellerSnapshot(org);
        const source: SnapshotSource = "SENT";

        data.sellerSnapshotJson = JSON.stringify(seller);
        data.buyerSnapshotJson = JSON.stringify(buyer);
        data.snapshotSource = source;
        data.snapshotAt = now;
      }
    } else if (target === "ACCEPTED" || target === "REJECTED") {
      data.decidedAt = now;
      data.decisionNote = opts.note ?? null;
    }

    const updated = await tx.quote.update({ where: { id: quoteId }, data });

    await appendChangeLog(tx, {
      orgId,
      entity: "QUOTE",
      entityId: quoteId,
      action: `STATUS_${target}`,
      actor,
      at: now,
      diff: { from, to: target, note: opts.note ?? null },
    });

    return updated;
  });
}

/** Setzt den Status eines Lieferscheins. Bei SENT/DELIVERED werden sentAt/deliveredAt gesetzt. */
export async function setDeliveryNoteStatus(
  orgId: string,
  id: string,
  to: DeliveryNoteStatus,
  opts: StatusOptions = {},
): Promise<DeliveryNote> {
  const target = DeliveryNoteStatus.parse(to);
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";

  return dbInternal.$transaction(async (tx) => {
    const note = await tx.deliveryNote.findFirst({ where: { id, orgId } });
    if (!note) throw new StatusTransitionError(`Lieferschein ${id} nicht gefunden.`);

    const from = DeliveryNoteStatus.parse(note.status);
    assertTransition(DELIVERY_TRANSITIONS, from, target);

    const data: Prisma.DeliveryNoteUpdateInput = { status: target };
    if (target === "SENT") data.sentAt = now;
    if (target === "DELIVERED") data.deliveredAt = now;

    const updated = await tx.deliveryNote.update({ where: { id }, data });

    await appendChangeLog(tx, {
      orgId,
      entity: "DELIVERY_NOTE",
      entityId: id,
      action: `STATUS_${target}`,
      actor,
      at: now,
      diff: { from, to: target, note: opts.note ?? null },
    });

    return updated;
  });
}

/** Archiviert/entarchiviert ein Angebot oder einen Lieferschein (rein organisatorisch, kein Statuswechsel). */
export async function setArchived(
  orgId: string,
  type: "QUOTE" | "DELIVERY_NOTE",
  id: string,
  archived: boolean,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const archivedAt = archived ? now : null;

  await dbInternal.$transaction(async (tx) => {
    if (type === "QUOTE") {
      const found = await tx.quote.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!found) throw new StatusTransitionError(`Angebot ${id} nicht gefunden.`);
      await tx.quote.update({ where: { id }, data: { archivedAt } });
    } else {
      const found = await tx.deliveryNote.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!found) throw new StatusTransitionError(`Lieferschein ${id} nicht gefunden.`);
      await tx.deliveryNote.update({ where: { id }, data: { archivedAt } });
    }

    await appendChangeLog(tx, {
      orgId,
      entity: type,
      entityId: id,
      action: archived ? "ARCHIVE" : "UNARCHIVE",
      actor,
      at: now,
      diff: { archived },
    });
  });
}

/**
 * Leitet den tatsaechlich wirksamen Status eines Angebots ab: EXPIRED ist kein
 * gespeicherter Status, sondern ergibt sich, wenn DRAFT/SENT noch aktiv ist und
 * `validUntil` verstrichen ist. Tagesgenauer Vergleich in UTC — Europe/Berlin-
 * Grenzfaelle (Mitternacht) sind fuer ein Gueltigkeitsdatum ohne Uhrzeit nicht relevant.
 */
export function effectiveQuoteStatus(q: { status: string; validUntil: Date | null }, now: Date = new Date()): QuoteStatus {
  const status = QuoteStatus.parse(q.status);
  if ((status === "DRAFT" || status === "SENT") && q.validUntil && q.validUntil.getTime() < now.getTime()) {
    return "EXPIRED";
  }
  return status;
}
