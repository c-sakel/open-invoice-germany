/**
 * Aktionsmatrix fuer Zeilen-Schnellaktionen (`RowActionsMenu`) UND die Detailseiten
 * (Phase 8b, §41 — "dieselbe Logik wie Detailseite, dort ebenfalls verwendet, keine
 * Doppelung"). Reine Funktion, keine DB-Zugriffe: der Aufrufer liefert bereits den
 * wirksamen Status (effectiveInvoiceStatus / effectiveQuoteStatus / DeliveryNoteStatus).
 *
 * Die Mengen hier bilden die bestehenden Sichtbarkeits-Sets der Rechnungs-Detailseite
 * nach (CANCELLABLE_TYPES/CREDITABLE_TYPES/NOT_DUPLICATABLE_TYPES in
 * src/app/rechnungen/[id]/page.tsx) — Task 2/4 loesen die Seite auf diese Funktion um,
 * ohne das Verhalten zu aendern.
 */
export type ActionKey =
  | "OPEN"
  | "EDIT"
  | "DUPLICATE"
  | "PDF"
  | "XRECHNUNG"
  | "SEND"
  | "RESEND"
  | "PAYMENT"
  | "REMINDER"
  | "DUNNING"
  | "DELIVERY_NOTE"
  | "CANCEL"
  | "CONVERT"
  // Phase 13d, Task 4: "Als Vorlage speichern" (src/domain/template/save.ts#saveTemplateFromDocument)
  // — verfuegbar fuer INVOICE/QUOTE/DELIVERY_NOTE, unabhaengig vom Status (auch ein
  // Entwurf oder ein stornierter Beleg darf als wiederverwendbare Vorlage dienen).
  | "TEMPLATE_SAVE";

export type DocKind = "INVOICE" | "QUOTE" | "DELIVERY_NOTE" | "RECURRING";

/**
 * Invoice: type ist der Rohtyp (INVOICE|CREDIT_NOTE|CORRECTION|PARTIAL|DOWNPAYMENT|FINAL),
 * status der WIRKSAME Status (effectiveInvoiceStatus-Ergebnis fuer INVOICE, sonst der
 * rohe Beleg-Status — z. B. effectiveQuoteStatus-Ergebnis fuer QUOTE, DeliveryNoteStatus
 * fuer DELIVERY_NOTE).
 */
export interface ActionableDoc {
  kind: DocKind;
  /** Fuer QUOTE: "ANGEBOT" | "AUFTRAGSBESTAETIGUNG" | "PROFORMA". Fuer INVOICE: der
   *  Invoice.type. Sonst ungenutzt. */
  type: string;
  /** Wirksamer Status — siehe Interface-Kommentar. */
  status: string;
  dunningState?: "ACTIVE" | "PAUSED" | "STOPPED";
  hasEmailLog?: boolean;
  isDraft: boolean;
}

// Rechnungstypen, die storniert/(teil-)gutgeschrieben werden koennen — CREDIT_NOTE
// (Stornobeleg selbst) ausgenommen. Deckungsgleich mit CANCELLABLE_TYPES/CREDITABLE_TYPES
// der Detailseite.
const CANCELLABLE_INVOICE_TYPES = new Set(["INVOICE", "CORRECTION", "PARTIAL", "DOWNPAYMENT", "FINAL"]);
// PARTIAL/DOWNPAYMENT/FINAL haengen an einer Quelle — kein freistehendes Duplikat.
// Deckungsgleich mit NOT_DUPLICATABLE_TYPES der Detailseite.
const NOT_DUPLICATABLE_INVOICE_TYPES = new Set(["PARTIAL", "DOWNPAYMENT", "FINAL"]);

const INVOICE_TYPES = new Set(["INVOICE", "CREDIT_NOTE", "CORRECTION", "PARTIAL", "DOWNPAYMENT", "FINAL"]);

// Task 7 ("eine Aktionsmatrix"): wortgleich aus der Dokument-Detailseite hierher verschoben
// (vormals dokumente/[id]/page.tsx:48-51) — einzige Quelle fuer die Umwandlungs-Sichtbarkeit,
// von RowActionsMenu UND der Detailseite genutzt. Reine Sichtbarkeit; die eigentliche Pruefung
// bleibt serverseitig (ConvertError/409 bei Regelverstoss).
const ANGEBOT_TO_AB_STATUSES = new Set(["DRAFT", "SENT", "ACCEPTED", "EXPIRED"]);
const ANGEBOT_TO_INVOICE_STATUSES = new Set(["DRAFT", "SENT", "ACCEPTED", "EXPIRED"]);
const AB_TO_INVOICE_STATUSES = new Set(["DRAFT", "SENT"]);
const QUOTE_TO_DELIVERY_NOTE_STATUSES = new Set(["DRAFT", "SENT", "ACCEPTED", "EXPIRED"]);

export interface ConvertTargets {
  orderConfirmation: boolean;
  invoice: boolean;
  deliveryNote: boolean;
}

/**
 * Ziele fuer die "Umwandeln"-Aktion eines Angebots/einer AB (ConvertMenu-Props
 * showToOrderConfirmation/showToInvoice/showToDeliveryNote). Nur fuer kind "QUOTE" —
 * andere Belegarten liefern immer drei `false`. `convertedToInvoiceId` sperrt AB/Rechnung
 * (bereits umgewandelt), `billingFull` (Gesamtleistung bereits voll berechnet, §13-15 UStG)
 * sperrt NUR die Rechnung — die AB-Erzeugung haengt nicht an der Abrechnung.
 *
 * Fix-Welle M5: `deliveryNote` folgt jetzt EXAKT der serverseitigen Regel in
 * `convertToDeliveryNote` (`src/domain/document/convert.ts`, `fromType === "QUOTE"`) —
 * die prueft dort NUR den (effektiven) Status gegen `QUOTE_TO_DELIVERY_NOTE_STATUSES`,
 * weder `kind` (PROFORMA eingeschlossen) noch den Abrechnungsstand. Vorher sperrte diese
 * Funktion zusaetzlich PROFORMA und ein bereits voll abgerechnetes Angebot/eine AB, obwohl
 * der Server beides weiterhin erlaubte — zwei bisher funktionierende, aber im Zeilenmenue/
 * auf der Detailseite unsichtbare Wege zur Lieferscheinerzeugung (Review-Finding M5). Nach
 * einer Rechnung noch zu liefern ist der Normalfall, keine Ausnahme.
 */
export function convertTargets(doc: ActionableDoc & { convertedToInvoiceId?: string | null; billingFull?: boolean }): ConvertTargets {
  if (doc.kind !== "QUOTE") return { orderConfirmation: false, invoice: false, deliveryNote: false };
  const isAngebot = doc.type === "ANGEBOT";
  const isAB = doc.type === "AUFTRAGSBESTAETIGUNG";
  const converted = doc.convertedToInvoiceId != null;
  const billingFull = doc.billingFull === true;
  return {
    orderConfirmation: isAngebot && !converted && ANGEBOT_TO_AB_STATUSES.has(doc.status),
    invoice:
      !converted && !billingFull && ((isAngebot && ANGEBOT_TO_INVOICE_STATUSES.has(doc.status)) || (isAB && AB_TO_INVOICE_STATUSES.has(doc.status))),
    deliveryNote: QUOTE_TO_DELIVERY_NOTE_STATUSES.has(doc.status),
  };
}

function invoiceActions(doc: ActionableDoc): ActionKey[] {
  const actions: ActionKey[] = ["OPEN", "PDF", "TEMPLATE_SAVE"];
  const isCancelled = doc.status === "CANCELLED";
  const isPayable = INVOICE_TYPES.has(doc.type) && doc.type !== "CREDIT_NOTE";

  if (doc.isDraft) {
    actions.push("EDIT");
  } else {
    // Rechnungsnummer erst nach Festschreibung vorhanden -> XRechnung/Mahnung/Zahlung
    // setzen alle "nicht DRAFT" voraus, unabhaengig vom konkreten Fälligkeits-Status.
    actions.push("XRECHNUNG");
  }

  if (!NOT_DUPLICATABLE_INVOICE_TYPES.has(doc.type)) actions.push("DUPLICATE");

  if (!isCancelled) {
    actions.push(doc.hasEmailLog ? "RESEND" : "SEND");
  }

  if (!doc.isDraft && !isCancelled && isPayable) {
    // PAYMENT nur, solange effectiveInvoiceStatus nicht bereits PAID ist (openCents > 0
    // ist Sache des Aufrufers/openAmountCents — hier reicht der Statuswert).
    if (doc.status !== "PAID") actions.push("PAYMENT");

    if (doc.status === "DUE" || doc.status === "OVERDUE") {
      const dunningActive = doc.dunningState == null || doc.dunningState === "ACTIVE";
      if (dunningActive) {
        actions.push("REMINDER", "DUNNING");
      }
    }
  }

  if (!doc.isDraft && !isCancelled && CANCELLABLE_INVOICE_TYPES.has(doc.type)) {
    actions.push("CANCEL");
  }

  return actions;
}

function quoteActions(doc: ActionableDoc): ActionKey[] {
  const actions: ActionKey[] = ["OPEN", "PDF", "TEMPLATE_SAVE"];
  const isCancelled = doc.status === "CANCELLED";
  const isRejected = doc.status === "REJECTED";

  if (doc.isDraft) actions.push("EDIT");
  actions.push("DUPLICATE");

  if (!isCancelled && !isRejected) {
    actions.push(doc.hasEmailLog ? "RESEND" : "SEND");
  }

  // Lieferschein/AB nur aus einem angenommenen Angebot bzw. einer AB heraus (§45) —
  // ANGEBOT/AUFTRAGSBESTAETIGUNG jeweils im Status ACCEPTED bzw. bereits SENT/ACCEPTED.
  if (!doc.isDraft && !isCancelled && !isRejected && doc.status === "ACCEPTED") {
    actions.push("DELIVERY_NOTE");
  }

  if (!doc.isDraft && !isCancelled) actions.push("CANCEL");

  // Task 7 ("eine Aktionsmatrix"): CONVERT buendelt AB-/Rechnungs-/Lieferschein-Erzeugung
  // ueber convertTargets — dieselbe Matrix wie die Dokument-Detailseite.
  const targets = convertTargets(doc);
  if (targets.orderConfirmation || targets.invoice || targets.deliveryNote) actions.push("CONVERT");

  return actions;
}

function deliveryNoteActions(doc: ActionableDoc): ActionKey[] {
  const actions: ActionKey[] = ["OPEN", "PDF", "TEMPLATE_SAVE"];
  const isCancelled = doc.status === "CANCELLED";

  if (doc.isDraft) actions.push("EDIT");
  actions.push("DUPLICATE");

  if (!isCancelled) {
    actions.push(doc.hasEmailLog ? "RESEND" : "SEND");
  }
  if (!doc.isDraft && !isCancelled) actions.push("CANCEL");

  return actions;
}

/**
 * Liefert die im aktuellen Zustand sinnvollen Aktionen fuer einen Beleg. Reine
 * Sichtbarkeitsfunktion — jede Aktion prueft ihre eigentliche Berechtigung erneut in
 * der jeweiligen Domain-Funktion (z. B. cancelInvoice, recordPayment); hier geht es nur
 * darum, ob ein Button/Menuepunkt ueberhaupt angezeigt wird.
 */
export function availableActions(doc: ActionableDoc): ActionKey[] {
  switch (doc.kind) {
    case "INVOICE":
      return invoiceActions(doc);
    case "QUOTE":
      return quoteActions(doc);
    case "DELIVERY_NOTE":
      return deliveryNoteActions(doc);
    case "RECURRING":
      // Abos selbst sind kein GoBD-Beleg (siehe recurring/create.ts) — nur OPEN/EDIT,
      // keine Beleg-Aktionen (PDF/SEND/...).
      return ["OPEN", "EDIT"];
    default:
      return ["OPEN"];
  }
}
