/**
 * Typen der Beleg-Uebersetzungen (Phase 16b, Task 5). Festtexte und Pflichthinweise je
 * Belegsprache; die PDF-Renderer und E-Rechnungs-Builder bekommen fertige Strings und
 * enthalten keine Sprachlogik. Deutsch ist die Referenz (de.ts uebernimmt die bisherigen
 * Literale woertlich), en.ts muss strukturgleich sein (Test: doc-strings.test.ts).
 */
import type { TaxScheme, TaxCategory } from "@/schemas";

export type DocLanguage = "de" | "en";

/** Steuerkategorien mit Hinweis-/Befreiungstext (S = Regelsteuersatz hat keinen). */
export type NoticeCategory = Exclude<TaxCategory, "S">;
/** Schemata mit Pflichthinweis (REGULAR hat keinen). */
export type NoticeScheme = Exclude<TaxScheme, "REGULAR">;
export type FxSource = "BMF_MONTHLY" | "ECB_DAILY" | "MANUAL";

export interface DocStrings {
  titles: {
    INVOICE: string;
    CREDIT_NOTE: string;
    /** Titel einer Korrektur ueber Gutschrift (creditNoteKind KORREKTUR). */
    CREDIT_NOTE_CORRECTION: string;
    CORRECTION: string;
    ANGEBOT: string;
    AUFTRAGSBESTAETIGUNG: string;
    PROFORMA: string;
    PARTIAL: string;
    DOWNPAYMENT: string;
    FINAL: string;
    DELIVERY_NOTE: string;
    /** Fallback, wenn der Belegtyp unbekannt ist. */
    DOCUMENT: string;
    /** Mahnstufen 0 (Zahlungserinnerung) bis 3. */
    DUNNING: Record<number, string>;
    /** Fallback-Titel fuer eine Mahnstufe ohne Eintrag. */
    dunningLevel: (level: number) => string;
  };
  numberLabels: {
    INVOICE: string;
    CREDIT_NOTE: string;
    CORRECTION: string;
    ANGEBOT: string;
    AUFTRAGSBESTAETIGUNG: string;
    PROFORMA: string;
    PARTIAL: string;
    DOWNPAYMENT: string;
    FINAL: string;
    /** Storno (CREDIT_NOTE, Art STORNO). */
    CANCELLATION: string;
    CREDIT_NOTE_CORRECTION: string;
    DELIVERY_NOTE: string;
    DOCUMENT: string;
    /** Kurzform im Mahnungskopf. */
    DUNNING: string;
  };
  meta: {
    invoiceDate: string;
    /** Datum bei Mahnung/Lieferschein. */
    date: string;
    deliveryDate: string;
    /** Lieferdatum (Lieferschein). */
    deliveryNoteDate: string;
    shippingDate: string;
    dueDate: string;
    customerNumber: string;
    contactPerson: string;
    buyerVatId: string;
    reference: string;
    referenceDocument: string;
    /** "zu <Beleg> <Nummer>" */
    referenceValue: (sourceLabel: string, number: string) => string;
    /** Fallback fuer den Namen des Bezugsbelegs. */
    genericDocument: string;
    /** Kopf des Lieferanschrift-Blocks im Rechnungs-PDF (inkl. Doppelpunkt). */
    deliveryAddress: string;
    /** Kopf des Lieferanschrift-Blocks im Lieferschein-PDF (inkl. Doppelpunkt). */
    deliveryNoteAddress: string;
  };
  /** Bezugsbeleg-Namen im Meta-Block "Bezug: zu <Beleg> <Nr.>" (je Quelltyp). */
  sourceLabels: {
    ANGEBOT: string;
    AUFTRAGSBESTAETIGUNG: string;
    PROFORMA: string;
    DELIVERY_NOTE: string;
  };
  /** Feste Systemtexte im PDF (frei eingegebene Texte bleiben unuebersetzt). */
  system: {
    /** Platzhalternummer einer Vorschau/eines Entwurfs. */
    draftNumber: string;
    /** Wasserzeichen der Layout-Vorschau (PdfTheme.watermark, preview-draft.ts). */
    previewWatermark: string;
  };
  /** Layout-spezifische Beschriftungen (PdfLayout#labels), derzeit nur "schlicht". */
  layoutLabels: {
    schlicht: {
      colEinzel: string;
      colNetto: string;
      colPosSuffix: string;
      net: string;
      taxRow: (rate: number) => string;
      gross: string;
      giroCaption: string;
    };
  };
  columns: {
    pos: string;
    articleNumber: string;
    description: string;
    quantity: string;
    unitPrice: string;
    vat: string;
    net: string;
    unit: string;
    discount: string;
  };
  lines: {
    /** Leistungszeitraum je Position (BG-26); Datumsangaben sind bereits formatiert. */
    servicePeriod: (from: string, to: string) => string;
  };
  totals: {
    subtotalNet: string;
    lessDiscount: string;
    surcharge: string;
    surchargeWithReason: (reason: string) => string;
    net: string;
    gross: string;
    finalNet: string;
    finalGross: string;
    taxRow: (rate: number) => string;
    /** Umsatzsteuer-0-%-Zeile je Befreiungskategorie. */
    zeroRateRow: (label: string) => string;
    zeroRateLabel: Record<NoticeCategory, string>;
    lineDiscount: (pct: string) => string;
    deduction: (number: string, date: string, gross: string, tax: string) => string;
    remaining: string;
    downpaymentTaxHint: string;
  };
  fx: {
    /** `rate` ist bereits locale-formatiert, `date` ebenso; ein leeres `date` laesst die Datumsangabe weg
     *  (Monatsdurchschnitt: das Label nennt den Monat bereits). */
    rateLine: (rate: string, currency: string, sourceLabel: string, date: string) => string;
    taxEurLine: (amount: string) => string;
    /** Schlussrechnung: EUR-Steuer der bereits mit Abschlaegen abgerechneten Betraege (Betrag formatiert). */
    deductedTaxEurLine: (amount: string) => string;
    sourceLabel: Record<FxSource, string>;
    /** "Monatsdurchschnittskurs <Monat> <Jahr>" (Monat 1..12). */
    monthlyRateLabel: (year: number, month: number) => string;
  };
  schemeNotice: Record<NoticeScheme, string>;
  categoryNotice: Record<NoticeCategory, string>;
  /** BT-120 (Klartext der Steuerbefreiung). */
  exemptionReason: Record<NoticeCategory, string>;
  /** Texte, die ins E-Rechnungs-XML (BT-22, Rabatt-/Aufschlaggruende) gehen. */
  notes: {
    /** Pflichthinweis auf Proforma-Rechnungen (PDF). */
    proformaHint: string;
    /** § 14b Abs. 1 Satz 5 UStG (PDF und XML). */
    consumerRetentionHint: string;
    /** BG-20/BG-27 Grund eines Rabatts. */
    allowanceReason: string;
    /** BG-21 Grund eines Aufschlags ohne eigenen Freitext. */
    chargeReason: string;
    /** BT-22-Abzugsaufstellung: Praefix, Betraege/Datum bereits formatiert. */
    deductionsPrefix: string;
    deductionLine: (number: string, date: string, net: string, tax: string, gross: string) => string;
  };
  paymentTerms: {
    /** Skonto-Satz bereits formatiert ("2 %"). */
    skontoClause: (percent: string, date: string, amount: string) => string;
    netDue: (date: string) => string;
  };
  footer: {
    phone: string;
    email: string;
    web: string;
    vatId: string;
    taxNumber: string;
    owner: string;
    bank: string;
    iban: string;
    bic: string;
    accountHolder: string;
  };
  giro: { caption: string; captionShort: string };
  /** Phase 18e: Zahlungsweg-Hinweise (Lastschrift-Vorabankuendigung, Kartenzahlung). */
  paymentMeans: {
    directDebit: (amount: string, date: string | null, ibanMasked: string, mandateReference: string, creditorId: string) => string;
    card: (network: string, last4: string) => string;
  };
  page: (n: number, total: number) => string;
  dunning: {
    salutation: string;
    intro: Record<0 | 1 | 2, (invoiceNumber: string) => string>;
    invoiceRow: (number: string, date: string) => string;
    interestSegment: (from: string, to: string, days: number, ratePct: string, points: string) => string;
    interestSingle: (days: number) => string;
    flatFee: string;
    fee: string;
    otherCosts: string;
    total: string;
    payBy: (date: string) => string;
  };
  /** Oeffentliches Kundenportal (Belegliste, Status, Downloads). */
  publicPortal: {
    title: string;
    greeting: (customerName: string) => string;
    openItemsHeading: string;
    openAmount: string;
    overdueAmount: string;
    noOpenItems: string;
    documentsHeading: string;
    empty: string;
    columns: { number: string; type: string; date: string; due: string; amount: string; open: string; status: string; download: string };
    kinds: { INVOICE: string; CREDIT_NOTE: string; CORRECTION: string; DUNNING: string };
    status: { OPEN: string; PARTIALLY_PAID: string; PAID: string; OVERDUE: string; CANCELLED: string; CREDIT: string; DUNNING: string };
    downloadPdf: string;
    downloadXml: string;
    relatedTo: (number: string) => string;
    expiresNotice: (date: string) => string;
    privacy: string;
    rateLimit: { title: string; hint: string };
  };
  /** Oeffentliche Angebotsseite (Freigabelink) und ihre Entscheidungsmeldungen. */
  publicOffer: {
    downloadPdf: string;
    sender: string;
    keyData: string;
    quoteNumber: string;
    date: string;
    validUntil: string;
    net: string;
    vat: string;
    gross: string;
    /** Danke-Text nach der Entscheidung (Datum bereits formatiert). */
    thanks: (date: string, accepted: boolean) => string;
    noFurtherDecision: string;
    rateLimit: { title: string; hint: string };
    form: {
      heading: string;
      name: string;
      email: string;
      comment: string;
      accept: string;
      reject: string;
      saving: string;
    };
    errors: {
      name: string;
      email: string;
      comment: string;
      decision: string;
      generic: string;
      invalidLink: string;
      alreadyDecided: string;
      tooMany: string;
      saveFailed: string;
    };
  };
}
