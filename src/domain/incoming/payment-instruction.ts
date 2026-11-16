/**
 * Zahlungsangaben einer Eingangsrechnung fuer eine Ueberweisung von Hand: IBAN, Empfaenger,
 * Verwendungszweck (BT-83) und GiroCode (EPC-QR). Es wird nichts ausgefuehrt oder gebucht.
 */
import { isValidIban, normalizeIban } from "@/lib/iban";
import { buildEpcPayload, EpcError } from "@/lib/pdf/epc";
import type { ParsedIncomingInvoice } from "@/schemas/incoming";
import { MAX_EPC_NAME_LENGTH, MAX_EPC_REMITTANCE_LENGTH } from "./limits";
import type { skontoSchedule } from "./skonto";

export type GirocodeBlock = "CURRENCY" | "NO_IBAN" | "IBAN_INVALID" | "AMOUNT" | "DIRECT_DEBIT" | "CARD" | "CREDIT_NOTE" | "NO_RECIPIENT" | "EPC_LIMIT";

export interface PaymentInstruction {
  iban: string | null;
  ibanValid: boolean;
  bic: string | null;
  recipient: string | null;
  remittance: string | null;
  amountCents: number | null;
  currency: string | null;
  girocodes: { label: "FULL" | "SKONTO"; until: string | null; amountCents: number; payload: string }[];
  blockedBy: GirocodeBlock | null;
}

const TRANSFER_CODES = new Set(["30", "58", "42"]);
const CARD_CODES = new Set(["48", "54", "55"]);
/** Dokumenttypen (BT-3), die eine Gutschrift/Erstattung des Lieferanten sind; hierfuer keine Ueberweisung. */
export const CREDIT_TYPE_CODES: ReadonlySet<string> = new Set(["381", "261", "262", "296", "308", "396", "420", "458", "532"]);

/** Erste Zahlungsangabe mit IBAN, die fuer eine Ueberweisung gilt (ohne Lastschrift/Karte). */
export function pickTransferMeans<T extends { iban: string | null; code: string | null }>(means: readonly T[]): T | null {
  return means.find((m) => m.iban !== null && (m.code === null || TRANSFER_CODES.has(m.code))) ?? null;
}

const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** BIC nur bei gueltiger Form, sonst null (Anzeige und QR). */
function cleanBic(bic: string | null | undefined): string | null {
  if (bic == null) return null;
  const t = bic.trim().toUpperCase();
  return BIC_PATTERN.test(t) ? t : null;
}

const clip = (s: string | null, max: number): string | null => {
  if (s === null) return null;
  // Steuerzeichen und Zeilenumbrueche aus fremden Dateien -> Leerzeichen, Mehrfach-Leerzeichen zusammenfassen.
  const t = s.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, max);
};

export function buildPaymentInstruction(input: {
  currency: string | null;
  payableCents: number | null;
  typeCode: string | null;
  means: ParsedIncomingInvoice["payment"]["means"];
  remittance: string | null;
  number: string | null;
  sellerName: string | null;
  payeeName: string | null;
  skonto: ReturnType<typeof skontoSchedule>;
  todayBerlin: string;
}): PaymentInstruction {
  const transfer = pickTransferMeans(input.means);
  const iban = transfer?.iban != null ? normalizeIban(transfer.iban) : null;
  const ibanValid = iban !== null && isValidIban(iban);
  const recipient = clip(transfer?.accountName ?? input.payeeName ?? input.sellerName, MAX_EPC_NAME_LENGTH);
  const remittance = clip(input.remittance ?? input.number, MAX_EPC_REMITTANCE_LENGTH);
  const info: PaymentInstruction = {
    iban,
    ibanValid,
    bic: cleanBic(transfer?.bic),
    recipient,
    remittance,
    amountCents: input.payableCents,
    currency: input.currency,
    girocodes: [],
    blockedBy: null,
  };

  const block = (b: GirocodeBlock): PaymentInstruction => ({ ...info, blockedBy: b });
  if (input.typeCode !== null && CREDIT_TYPE_CODES.has(input.typeCode)) return block("CREDIT_NOTE");
  if (input.currency !== "EUR") return block("CURRENCY");
  if (transfer === null) {
    if (input.means.some((m) => m.code === "59")) return block("DIRECT_DEBIT");
    if (input.means.some((m) => m.code !== null && CARD_CODES.has(m.code))) return block("CARD");
    return block("NO_IBAN");
  }
  if (!ibanValid || iban === null) return block("IBAN_INVALID");
  if (input.payableCents === null || input.payableCents <= 0) return block("AMOUNT");
  if (recipient === null) return block("NO_RECIPIENT");

  try {
    const make = (amountCents: number): string =>
      buildEpcPayload({ name: recipient, iban, bic: info.bic, amountCents, remittance: remittance ?? "" });
    const girocodes: PaymentInstruction["girocodes"] = [
      { label: "FULL", until: null, amountCents: input.payableCents, payload: make(input.payableCents) },
    ];
    for (const s of input.skonto) {
      if (s.until >= input.todayBerlin && s.payCents > 0) {
        girocodes.push({ label: "SKONTO", until: s.until, amountCents: s.payCents, payload: make(s.payCents) });
      }
    }
    return { ...info, girocodes };
  } catch (e) {
    if (e instanceof EpcError) return block("EPC_LIMIT");
    throw e;
  }
}
