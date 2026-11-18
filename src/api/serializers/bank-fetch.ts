import "../openapi-zod-init";
import { z } from "zod";
import type { BankFetchRunRow, BankFetchStatus } from "@/domain/bank-fetch/status";
import { iso } from "./common";

/** Nur maskierte Kennung und IBAN; Adresse, Produkt-ID, PIN-Daten und Bankdaten verlassen die Domain nie. */
export function serializeBankFetchStatus(s: BankFetchStatus) {
  return {
    productIdConfigured: s.productIdConfigured,
    autoHour: s.autoHour,
    connections: s.connections.map((c) => ({
      id: c.id,
      label: c.label,
      bankCode: c.bankCode,
      state: c.state,
      pinMode: c.pinMode,
      autoEnabled: c.autoEnabled,
      userIdMasked: c.userIdMasked,
      lastAttemptAt: iso(c.lastAttemptAt),
      lastSuccessAt: iso(c.lastSuccessAt),
      lastErrorCode: c.lastErrorCode,
      scaRenewBy: iso(c.scaRenewBy),
      accounts: c.accounts.map((a) => ({
        id: a.id,
        ibanMasked: a.ibanMasked,
        currency: a.currency,
        selected: a.selected,
        camtSupported: a.camtSupported,
        lastFetchedTo: iso(a.lastFetchedTo),
      })),
    })),
  };
}

export function serializeBankFetchRun(r: BankFetchRunRow) {
  return {
    objectName: "BankFetchRun" as const,
    id: r.id,
    connectionId: r.connectionId,
    accountId: r.accountId,
    ibanMasked: r.ibanMasked,
    trigger: r.trigger,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    result: r.result,
    bankCodes: r.bankCodes,
    from: iso(r.fromDate),
    to: iso(r.toDate),
    documents: r.documents,
    bytes: r.bytes,
    importId: r.importId,
    importedCount: r.importedCount,
    duplicateCount: r.duplicateCount,
    scaUsed: r.scaUsed,
    createdAt: iso(r.createdAt),
  };
}

// ── OpenAPI-Schemas ──────────────────────────────────────────────────────────────
export const bankFetchStatusSchema = z.object({
  productIdConfigured: z.boolean().describe("Die Produkt-ID selbst wird nie ausgegeben"),
  autoHour: z.number().int().describe("Stunde (Berliner Zeit) des taeglichen Abrufs"),
  connections: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      bankCode: z.string(),
      state: z.string().describe("NEW, READY, SCA_REQUIRED, PIN_REJECTED, AUTH_UNCLEAR oder ERROR"),
      pinMode: z.enum(["PER_FETCH", "STORED"]),
      autoEnabled: z.boolean(),
      userIdMasked: z.string().describe("Maskiert"),
      lastAttemptAt: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
      lastErrorCode: z.string().nullable().describe("Fester Fehlercode"),
      scaRenewBy: z.string().nullable().describe("Spaetestens bis dahin ist eine neue Freigabe noetig"),
      accounts: z.array(
        z.object({
          id: z.string(),
          ibanMasked: z.string().describe("Maskiert"),
          currency: z.string().nullable(),
          selected: z.boolean(),
          camtSupported: z.boolean(),
          lastFetchedTo: z.string().nullable(),
        }),
      ),
    }),
  ),
});

export const bankFetchRunSchema = z.object({
  objectName: z.literal("BankFetchRun"),
  id: z.string(),
  connectionId: z.string(),
  accountId: z.string().nullable(),
  ibanMasked: z.string().nullable().describe("Maskiert"),
  trigger: z.enum(["AUTO", "MANUAL"]),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  result: z.string().describe("OK oder ein fester Code"),
  bankCodes: z.array(z.string()).describe("Nur vierstellige Rueckmeldecodes"),
  from: z.string().nullable(),
  to: z.string().nullable(),
  documents: z.number().int(),
  bytes: z.number().int(),
  importId: z.string().nullable(),
  importedCount: z.number().int(),
  duplicateCount: z.number().int(),
  scaUsed: z.boolean(),
  createdAt: z.string().nullable(),
});
