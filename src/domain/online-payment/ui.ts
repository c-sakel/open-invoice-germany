/**
 * Reine Darstellungslogik der Online-Zahlung (Beschriftungen, erlaubte Schaltflaechen); keine Datenzugriffe.
 */
import type { InvoicePayLinkView } from "./views";
import type { ProviderAccountView } from "./settings";

export const ATTEMPT_STATUS_LABEL: Record<string, string> = {
  CREATING: "wird angelegt",
  OPEN: "offen",
  PAID: "bezahlt",
  EXPIRED: "abgelaufen",
  CANCELED: "abgebrochen",
  FAILED: "fehlgeschlagen",
};

export const LINK_DISABLED_LABEL: Record<string, string> = {
  MANUAL: "manuell deaktiviert",
  INVOICE_CANCELLED: "Rechnung storniert",
  INVOICE_PAID: "Rechnung bezahlt",
};

export const MODE_LABEL: Record<"TEST" | "LIVE", string> = { TEST: "Testmodus", LIVE: "Livemodus" };

/** Einschalten ist nur mit Schluessel, gesetzter APP_BASE_URL und erfolgreichem Test des aktuellen Schluessels moeglich. */
export function canEnableProvider(account: Pick<ProviderAccountView, "hasApiKey" | "lastTestOk">, baseUrlSet: boolean): boolean {
  return account.hasApiKey && account.lastTestOk === true && baseUrlSet;
}

export interface PayLinkActions {
  create: boolean;
  reactivate: boolean;
  disable: boolean;
  refresh: boolean;
  open: boolean;
  copy: boolean;
}

/** Schaltflaechen je Linkstatus; Storno sperrt Anlegen und Reaktivieren dauerhaft. */
export function payLinkActions(view: InvoicePayLinkView, opts: { invoiceCancelled: boolean; hasUrl: boolean }): PayLinkActions {
  const link = view.link;
  const cancelled = opts.invoiceCancelled || link?.disabledReason === "INVOICE_CANCELLED";
  const active = link?.status === "ACTIVE";
  return {
    create: link === null && !cancelled,
    reactivate: link !== null && !active && !cancelled,
    disable: active,
    refresh: link !== null && view.attempts.some((a) => a.status === "OPEN"),
    open: active && opts.hasUrl,
    copy: active && opts.hasUrl,
  };
}
