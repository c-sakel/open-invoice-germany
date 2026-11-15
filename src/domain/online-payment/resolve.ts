/**
 * Aufloesung des Zahlungsanbieters fuer eine Rechnung (rein, ohne Datenbank).
 * Vorrang: Zahlungsart (nicht NULL) > Kunde (nicht NULL) > Organisation; NONE beendet die Kette.
 */
import type { OnlineProvider } from "@/lib/payment/types";

export type ProviderChoice = OnlineProvider | "NONE" | null;

export type ResolveReason = "NOT_PAYABLE" | "DIRECT_DEBIT" | "PREPAID" | "NONE" | "ACCOUNT_OFF" | "CURRENCY";

export interface ResolveInput {
  invoiceType: string;
  payableCents: number;
  currency: string;
  paymentMethodCode: string | null;
  hasDirectDebitMandate: boolean;
  methodChoice: ProviderChoice;
  customerChoice: ProviderChoice;
  orgDefault: OnlineProvider | "NONE";
  accounts: ReadonlyMap<OnlineProvider, { enabled: boolean; hasKey: boolean; currencies: readonly string[] }>;
}

export type ResolveResult = { provider: OnlineProvider } | { provider: null; reason: ResolveReason };

export function resolveOnlineProvider(input: ResolveInput): ResolveResult {
  if (input.invoiceType === "CREDIT_NOTE" || input.payableCents <= 0) return { provider: null, reason: "NOT_PAYABLE" };
  if (input.hasDirectDebitMandate) return { provider: null, reason: "DIRECT_DEBIT" };
  if (input.paymentMethodCode === "PREPAID") return { provider: null, reason: "PREPAID" };
  const choice: OnlineProvider | "NONE" = input.methodChoice ?? input.customerChoice ?? input.orgDefault;
  if (choice === "NONE") return { provider: null, reason: "NONE" };
  const account = input.accounts.get(choice);
  if (!account || !account.enabled || !account.hasKey) return { provider: null, reason: "ACCOUNT_OFF" };
  if (!account.currencies.includes(input.currency)) return { provider: null, reason: "CURRENCY" };
  return { provider: choice };
}

/** Normalisiert einen gespeicherten Textwert (NULL | NONE | Anbieter) zur Auswahl; Unbekanntes zaehlt als "keine Vorgabe". */
export function asProviderChoice(v: string | null | undefined): ProviderChoice {
  if (v === "NONE") return "NONE";
  if (v === "MOLLIE") return "MOLLIE";
  return null;
}
