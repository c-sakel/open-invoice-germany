/** Ergebnis eines Kontoabrufs je Konto (nur Zahlen, Codes und die maskierte IBAN; nie Banktexte). */
export interface RunSummary {
  runId: string;
  accountId: string | null;
  /** Maskiert. */
  iban: string | null;
  /** OK oder ein fester Code (z. B. SCA_REQUIRED, SCA_CANCELLED, ACCOUNT_MISMATCH). */
  result: string;
  bankCodes: string[];
  from: string | null;
  to: string | null;
  /** Gewuenschter Beginn, wenn der Zeitraum gekuerzt wurde (davor liegende Tage fehlen). */
  gapBefore: string | null;
  documents: number;
  bytes: number;
  importId: string | null;
  importedCount: number;
  duplicateCount: number;
  scaUsed: boolean;
}
