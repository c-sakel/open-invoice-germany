/**
 * Feste, erfundene Werte fuer die FinTS-Tests (Host `fints.example.org`, nie ein echter Server).
 */
import { buildCamt } from "./camt-builder";

export const FINTS_HOST = "fints.example.org";
export const FINTS_URL = `https://${FINTS_HOST}/fints`;
export const FINTS_BLZ = "37040044";
export const FINTS_USER = "kunde4711";
export const FINTS_PIN = "Pin-2250x";
export const FINTS_PRODUCT_ID = "TESTPRODUKT0000000001";
export const FINTS_TAN = "123456";
export const FINTS_IBAN = "DE89370400440532013000";
export const FINTS_IBAN_2 = "DE02120300000000202051";
export const FINTS_OTHER_IBAN = "DE75512108001245126199";

/** Ein camt.052-Dokument fuer ein Konto; `remittance` mit Umlauten prueft die Byte-Treue. */
export function camtDocument(iban: string, id: string, remittance = `Rechnung ${id} Gruesse aus Muenchen`): string {
  return buildCamt({
    format: "052",
    version: 8,
    iban,
    entries: [{ date: "2026-11-10", direction: "CRDT", txs: [{ amountCents: 11900, name: "Muster GmbH", remittance, endToEndId: `E2E-${id}` }] }],
  });
}

export function fintsAccess(overrides: Partial<{
  url: string;
  pin: string;
  userId: string;
  tanMethodId: number | null;
  tanMediaName: string | null;
  bankingInfo: string | null;
}> = {}): {
  productId: string;
  productVersion: string;
  url: string;
  bankCode: string;
  userId: string;
  customerId: string | null;
  pin: string;
  tanMethodId: number | null;
  tanMediaName: string | null;
  bankingInfo: string | null;
} {
  return {
    productId: FINTS_PRODUCT_ID,
    productVersion: "1.0",
    url: overrides.url ?? FINTS_URL,
    bankCode: FINTS_BLZ,
    userId: overrides.userId ?? FINTS_USER,
    customerId: null,
    pin: overrides.pin ?? FINTS_PIN,
    tanMethodId: overrides.tanMethodId ?? null,
    tanMediaName: overrides.tanMediaName ?? null,
    bankingInfo: overrides.bankingInfo ?? null,
  };
}
