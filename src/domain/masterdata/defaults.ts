/**
 * Systemstammdaten, die jede Organisation bekommt — beim Anlegen (ensure*) und per
 * Backfill-Migration fuer Bestandsorganisationen. Die Codes TRANSFER/CASH/CARD/SEPA
 * entsprechen der frueheren Zod-Enum, damit Bestandszahlungen aufloesbar bleiben.
 * untdidCode: UNTDID 4461 (EN 16931 BT-81).
 */
export const SYSTEM_PAYMENT_METHODS = [
  { code: "TRANSFER", name: "Ueberweisung", untdidCode: "58", sortOrder: 1 },
  { code: "CASH", name: "Barzahlung", untdidCode: "10", sortOrder: 2 },
  { code: "CARD", name: "EC-/Debitkarte", untdidCode: "48", sortOrder: 3 },
  { code: "CREDIT_CARD", name: "Kreditkarte", untdidCode: "54", sortOrder: 4 },
  { code: "PAYPAL", name: "PayPal", untdidCode: "68", sortOrder: 5 },
  { code: "SEPA", name: "SEPA-Lastschrift", untdidCode: "59", sortOrder: 6 },
  { code: "PREPAID", name: "Bereits bezahlt", untdidCode: "ZZZ", sortOrder: 7 },
  { code: "OTHER", name: "Sonstige", untdidCode: "ZZZ", sortOrder: 8 },
  // Skonto-Buchung (Phase 4a) — keine echte Zahlungsart, sondern der Systemcode fuer
  // recordPayment(), wenn ein Skontoabzug als zweite Zahlung verbucht wird.
  { code: "SKONTO", name: "Skonto", untdidCode: "ZZZ", sortOrder: 9 },
] as const;

/** Standard-Mahnstufen (Fristen aus dem Lastenheft, Titel wie DUNNING_LEVEL_TITLE). */
export const DEFAULT_DUNNING_STAGES = [
  { order: 0, name: "Zahlungserinnerung", daysAfterDue: 3, newDueDays: 14, feeCents: 0, calculateInterest: false, includeB2BFlatFee: false },
  { order: 1, name: "1. Mahnung", daysAfterDue: 10, newDueDays: 14, feeCents: 0, calculateInterest: true, includeB2BFlatFee: true },
  { order: 2, name: "2. Mahnung", daysAfterDue: 10, newDueDays: 14, feeCents: 0, calculateInterest: true, includeB2BFlatFee: true },
  { order: 3, name: "3. Mahnung", daysAfterDue: 7, newDueDays: 14, feeCents: 0, calculateInterest: true, includeB2BFlatFee: true },
] as const;

/** Standard-E-Mail-Vorlagen (Lastenheft 19). Alle vom Nutzer editierbar; isSystem markiert nur die Herkunft. */
export const DEFAULT_EMAIL_TEMPLATES = [
  { docType: "ANGEBOT", name: "Standard", subject: "Angebot {{document.number}} von {{company.name}}",
    body: "Guten Tag,\n\nanbei erhalten Sie unser Angebot {{document.number}}.\nDas Angebot ist bis zum {{offer.validUntil}} gültig.\nSie können das Angebot auch online ansehen und annehmen: {{offer.link}}\n\nFür Rückfragen stehen wir gerne zur Verfügung.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "AUFTRAGSBESTAETIGUNG", name: "Standard", subject: "Auftragsbestätigung {{document.number}}",
    body: "Guten Tag,\n\nvielen Dank für Ihren Auftrag.\nAnbei erhalten Sie die Auftragsbestätigung {{document.number}}.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "PROFORMA", name: "Standard", subject: "Proformarechnung {{document.number}}",
    body: "Guten Tag,\n\nanbei erhalten Sie die Proformarechnung {{document.number}} über {{document.total}}.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "DELIVERY_NOTE", name: "Standard", subject: "Lieferschein {{document.number}}",
    body: "Guten Tag,\n\nanbei erhalten Sie den Lieferschein {{document.number}} zu Ihrer Lieferung.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "INVOICE", name: "Standard", subject: "Rechnung {{document.number}} von {{company.name}}",
    body: "Guten Tag,\n\nanbei erhalten Sie unsere Rechnung {{document.number}} über {{document.total}}.\nDer Rechnungsbetrag ist bis zum {{document.dueDate}} fällig.\n\nVielen Dank.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "CREDIT_NOTE", name: "Standard", subject: "Gutschrift {{document.number}} von {{company.name}}",
    body: "Guten Tag,\n\nanbei erhalten Sie unsere Gutschrift {{document.number}} über {{document.total}}.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "DUNNING", name: "Zahlungserinnerung", dunningOrder: 0, subject: "Zahlungserinnerung zur Rechnung {{invoice.number}}",
    body: "Guten Tag,\n\nsicher ist es Ihrer Aufmerksamkeit entgangen: Unsere Rechnung {{invoice.number}} vom {{invoice.date}} über {{invoice.total}} war am {{invoice.dueDate}} fällig. Offen sind derzeit {{invoice.openAmount}}.\n\nBitte gleichen Sie den Betrag bis zum {{dunning.newDueDate}} aus. Sollte die Zahlung bereits erfolgt sein, betrachten Sie diese Nachricht als gegenstandslos.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "DUNNING", name: "1. Mahnung", dunningOrder: 1, subject: "1. Mahnung zur Rechnung {{invoice.number}}",
    body: "Guten Tag,\n\ntrotz unserer Zahlungserinnerung ist die Rechnung {{invoice.number}} vom {{invoice.date}} noch nicht vollständig beglichen. Offen sind {{invoice.openAmount}}.\n\nBitte zahlen Sie den Betrag von {{dunning.total}} bis zum {{dunning.newDueDate}}.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "DUNNING", name: "2. Mahnung", dunningOrder: 2, subject: "2. Mahnung zur Rechnung {{invoice.number}}",
    body: "Guten Tag,\n\ndie Rechnung {{invoice.number}} vom {{invoice.date}} ist trotz Mahnung weiterhin offen ({{invoice.openAmount}}).\n\nWir bitten um Zahlung von {{dunning.total}} bis spätestens {{dunning.newDueDate}}.\n\nFreundliche Grüße\n{{company.name}}" },
  { docType: "DUNNING", name: "3. Mahnung", dunningOrder: 3, subject: "Letzte Mahnung zur Rechnung {{invoice.number}}",
    body: "Guten Tag,\n\ndies ist unsere letzte Mahnung zur Rechnung {{invoice.number}} vom {{invoice.date}}. Offen sind {{invoice.openAmount}}, zuzüglich Mahnkosten insgesamt {{dunning.total}}.\n\nGeht der Betrag nicht bis zum {{dunning.newDueDate}} ein, behalten wir uns weitere Schritte vor.\n\nFreundliche Grüße\n{{company.name}}" },
] as const;

/**
 * Englische Standard-E-Mail-Vorlagen (Phase 16b, Belegsprache "en"): dieselben Platzhalter
 * wie die deutschen. DUNNING-Vorlagen tragen die Stufenordnung `dunningOrder`; sie werden
 * ueber diese Ordnung (nicht ueber den Namen der deutschen Stufe) zugeordnet.
 */
export const DEFAULT_EMAIL_TEMPLATES_EN = [
  { docType: "ANGEBOT", name: "Standard", subject: "Quote {{document.number}} from {{company.name}}",
    body: "Hello,\n\nplease find attached our quote {{document.number}}.\nThe quote is valid until {{offer.validUntil}}.\nYou can also view and accept the quote online: {{offer.link}}\n\nPlease do not hesitate to contact us if you have any questions.\n\nKind regards\n{{company.name}}" },
  { docType: "AUFTRAGSBESTAETIGUNG", name: "Standard", subject: "Order confirmation {{document.number}}",
    body: "Hello,\n\nthank you for your order.\nPlease find attached the order confirmation {{document.number}}.\n\nKind regards\n{{company.name}}" },
  { docType: "PROFORMA", name: "Standard", subject: "Proforma invoice {{document.number}}",
    body: "Hello,\n\nplease find attached the proforma invoice {{document.number}} for {{document.total}}.\n\nKind regards\n{{company.name}}" },
  { docType: "DELIVERY_NOTE", name: "Standard", subject: "Delivery note {{document.number}}",
    body: "Hello,\n\nplease find attached the delivery note {{document.number}} for your delivery.\n\nKind regards\n{{company.name}}" },
  { docType: "INVOICE", name: "Standard", subject: "Invoice {{document.number}} from {{company.name}}",
    body: "Hello,\n\nplease find attached our invoice {{document.number}} for {{document.total}}.\nThe invoice amount is due on {{document.dueDate}}.\n\nThank you.\n\nKind regards\n{{company.name}}" },
  { docType: "CREDIT_NOTE", name: "Standard", subject: "Credit note {{document.number}} from {{company.name}}",
    body: "Hello,\n\nplease find attached our credit note {{document.number}} for {{document.total}}.\n\nKind regards\n{{company.name}}" },
  { docType: "DUNNING", name: "Payment reminder", dunningOrder: 0, subject: "Payment reminder for invoice {{invoice.number}}",
    body: "Hello,\n\nit may have escaped your attention: our invoice {{invoice.number}} dated {{invoice.date}} for {{invoice.total}} was due on {{invoice.dueDate}}. The amount currently outstanding is {{invoice.openAmount}}.\n\nPlease settle the amount by {{dunning.newDueDate}}. If payment has already been made, please disregard this message.\n\nKind regards\n{{company.name}}" },
  { docType: "DUNNING", name: "1st reminder", dunningOrder: 1, subject: "1st reminder for invoice {{invoice.number}}",
    body: "Hello,\n\ndespite our payment reminder, invoice {{invoice.number}} dated {{invoice.date}} has not yet been paid in full. The amount outstanding is {{invoice.openAmount}}.\n\nPlease pay {{dunning.total}} by {{dunning.newDueDate}}.\n\nKind regards\n{{company.name}}" },
  { docType: "DUNNING", name: "2nd reminder", dunningOrder: 2, subject: "2nd reminder for invoice {{invoice.number}}",
    body: "Hello,\n\ninvoice {{invoice.number}} dated {{invoice.date}} remains outstanding despite our reminder ({{invoice.openAmount}}).\n\nWe kindly ask you to pay {{dunning.total}} by {{dunning.newDueDate}} at the latest.\n\nKind regards\n{{company.name}}" },
  { docType: "DUNNING", name: "3rd reminder", dunningOrder: 3, subject: "Final reminder for invoice {{invoice.number}}",
    body: "Hello,\n\nthis is our final reminder for invoice {{invoice.number}} dated {{invoice.date}}. The amount outstanding is {{invoice.openAmount}}; including reminder fees the total is {{dunning.total}}.\n\nIf the amount has not been received by {{dunning.newDueDate}}, we reserve the right to take further steps.\n\nKind regards\n{{company.name}}" },
] as const;

/** Name der englischen Systemvorlage je Mahnstufe (Zuordnung ueber die Stufenordnung). */
export const EN_DUNNING_TEMPLATE_NAME_BY_ORDER: Readonly<Record<number, string>> = Object.fromEntries(
  DEFAULT_EMAIL_TEMPLATES_EN.filter((t) => t.docType === "DUNNING").map((t) => [(t as { dunningOrder: number }).dunningOrder, t.name]),
);
