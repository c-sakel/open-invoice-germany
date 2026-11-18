/**
 * Kern der Server-Actions des Kontoabrufs: gleiche Domainfunktionen und Schemas wie REST und MCP, aber mit festen
 * Texten für die Oberfläche. Organisation und Benutzer kommen vom Aufrufer (Sitzung). PIN, TAN und Produkt-ID
 * verlassen diese Schicht nie; Antworten enthalten nur die Sichten unten. Fremde und unbekannte Ids (auch Tokens)
 * liefern denselben Text.
 */
import { z, ZodError } from "zod";
import { describeError } from "@/lib/safe-error";
import { maskIban } from "@/lib/iban";
import { FintsError } from "@/lib/fints/client";
import { NotFoundError } from "@/domain/errors";
import { BankFetchError } from "@/domain/bank-fetch/errors";
import {
  archiveBankConnection,
  createBankConnection,
  listBankConnections,
  selectAccounts,
  setAutoEnabled,
  setStoredPin,
  updateBankConnection,
  type BankConnectionView,
} from "@/domain/bank-fetch/connections";
import { cancelManualFetch, continueManualFetch, startManualFetch, type FetchOutcome } from "@/domain/bank-fetch/run";
import { loadBankFetchSettings, saveBankFetchSettings } from "@/domain/bank-fetch/settings";
import { cancelSetup, connectBankConnection, continueSetup, type PublicChallenge, type SetupResult, type TanMethodChoice } from "@/domain/bank-fetch/setup";
import type { RunSummary } from "@/domain/bank-fetch/run-types";
import { bankFetchErrorText, GENERIC_BANK_FETCH_ERROR, NOT_FOUND_TEXT, SESSION_LOST_TEXT } from "./bank-fetch-ui";

export type UiResult<T = undefined> = ({ ok: true } & ([T] extends [undefined] ? Record<never, never> : { data: T })) | { ok: false; error: string };

export interface BankAccountClientView {
  id: string;
  /** Immer maskiert. */
  ibanMasked: string;
  currency: string | null;
  productName: string | null;
  camtSupported: boolean;
  selected: boolean;
  lastFetchedTo: string | null;
}

/** Sicht auf einen Bankzugang für die Oberfläche: nie PIN, nie Bankdaten, IBAN maskiert. */
export interface BankConnectionClientView {
  id: string;
  label: string;
  bankCode: string;
  url: string;
  userId: string;
  customerId: string | null;
  pinMode: "PER_FETCH" | "STORED";
  hasPin: boolean;
  tanMethodId: number | null;
  autoEnabled: boolean;
  state: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastScaAt: string | null;
  scaRenewBy: string | null;
  lastErrorCode: string | null;
  accounts: BankAccountClientView[];
}

export function toConnectionClientView(v: BankConnectionView): BankConnectionClientView {
  return {
    id: v.id,
    label: v.label,
    bankCode: v.bankCode,
    url: v.url,
    userId: v.userId,
    customerId: v.customerId,
    pinMode: v.pinMode,
    hasPin: v.hasPin,
    tanMethodId: v.tanMethodId,
    autoEnabled: v.autoEnabled,
    state: v.state,
    lastAttemptAt: v.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: v.lastSuccessAt?.toISOString() ?? null,
    lastScaAt: v.lastScaAt?.toISOString() ?? null,
    scaRenewBy: v.scaRenewBy?.toISOString() ?? null,
    lastErrorCode: v.lastErrorCode,
    accounts: v.accounts.map((a) => ({
      id: a.id,
      ibanMasked: maskIban(a.iban),
      currency: a.currency,
      productName: a.productName,
      camtSupported: a.camtSupported,
      selected: a.selected,
      lastFetchedTo: a.lastFetchedTo?.toISOString() ?? null,
    })),
  };
}

export interface BankFetchSettingsClientView {
  productIdConfigured: boolean;
  autoHour: number;
  firstFetchDays: number;
}

export type SetupUi =
  | { state: "DONE"; connection: BankConnectionClientView }
  | { state: "SCA"; token: string; challenge: PublicChallenge }
  | { state: "CHOOSE_TAN_METHOD"; methods: TanMethodChoice[] };

export type FetchUi = { state: "DONE"; runs: RunSummary[] } | { state: "SCA"; token: string; challenge: PublicChallenge };

function toSetupUi(r: SetupResult): SetupUi {
  if (r.state === "DONE") return { state: "DONE", connection: toConnectionClientView(r.view) };
  return r;
}

function toFetchUi(r: FetchOutcome): FetchUi {
  return r.state === "DONE" ? { state: "DONE", runs: r.runs } : r;
}

function zodText(e: ZodError): string {
  const field = e.issues[0]?.path[0];
  if (field === "url") return bankFetchErrorText("URL_INVALID");
  if (field === "bankCode") return "Die Bankleitzahl besteht aus 8 Ziffern.";
  if (field === "label") return "Bitte eine Bezeichnung eintragen (höchstens 60 Zeichen).";
  if (field === "userId") return "Bitte den Anmeldenamen eintragen.";
  if (field === "customerId") return "Die Kunden-ID ist ungültig.";
  if (field === "productId") return "Die Produkt-ID besteht aus 10 bis 30 Buchstaben und Ziffern.";
  if (field === "pin") return "Die PIN ist ungültig.";
  if (field === "confirm") return "Bitte die Speicherung der PIN ausdrücklich bestätigen.";
  if (field === "tan") return bankFetchErrorText("TAN_FORMAT");
  if (field === "from") return "Bitte ein gültiges Datum eintragen.";
  return "Ungültige Eingabe.";
}

function failure(e: unknown, what: string): { ok: false; error: string } {
  if (e instanceof ZodError) return { ok: false, error: zodText(e) };
  if (e instanceof BankFetchError) return { ok: false, error: bankFetchErrorText(e.code) };
  if (e instanceof FintsError) return { ok: false, error: bankFetchErrorText(e.code) };
  if (e instanceof NotFoundError) return { ok: false, error: /Sitzung/.test(e.message) ? SESSION_LOST_TEXT : NOT_FOUND_TEXT };
  console.error(`Kontoabruf ${what}:`, describeError(e));
  return { ok: false, error: GENERIC_BANK_FETCH_ERROR };
}

const idSchema = z.string().min(1).max(64);
const tokenSchema = z.string().min(1).max(200);

export async function loadClientConnections(orgId: string): Promise<BankConnectionClientView[]> {
  return (await listBankConnections(orgId)).map(toConnectionClientView);
}

export async function saveSettingsCore(orgId: string, actor: string, input: unknown): Promise<UiResult<BankFetchSettingsClientView>> {
  try {
    await saveBankFetchSettings(orgId, input, actor);
    return { ok: true, data: await loadBankFetchSettings(orgId) };
  } catch (e) {
    return failure(e, "Einstellungen");
  }
}

export async function createConnectionCore(orgId: string, actor: string, input: unknown): Promise<UiResult<BankConnectionClientView>> {
  try {
    return { ok: true, data: toConnectionClientView(await createBankConnection(orgId, input, actor)) };
  } catch (e) {
    return failure(e, "Bankzugang anlegen");
  }
}

export async function updateConnectionCore(orgId: string, actor: string, id: unknown, input: unknown): Promise<UiResult<BankConnectionClientView>> {
  try {
    return { ok: true, data: toConnectionClientView(await updateBankConnection(orgId, idSchema.parse(id), input, actor)) };
  } catch (e) {
    return failure(e, "Bankzugang ändern");
  }
}

export async function archiveConnectionCore(orgId: string, actor: string, id: unknown): Promise<UiResult> {
  try {
    await archiveBankConnection(orgId, idSchema.parse(id), actor);
    return { ok: true };
  } catch (e) {
    return failure(e, "Bankzugang entfernen");
  }
}

export async function storePinCore(orgId: string, actor: string, id: unknown, input: unknown): Promise<UiResult<BankConnectionClientView[]>> {
  try {
    await setStoredPin(orgId, idSchema.parse(id), input, actor);
    return { ok: true, data: await loadClientConnections(orgId) };
  } catch (e) {
    return failure(e, "PIN speichern");
  }
}

export async function setAutoCore(orgId: string, actor: string, id: unknown, enabled: unknown): Promise<UiResult<BankConnectionClientView>> {
  try {
    return { ok: true, data: toConnectionClientView(await setAutoEnabled(orgId, idSchema.parse(id), z.boolean().parse(enabled), actor)) };
  } catch (e) {
    return failure(e, "Automatischer Abruf");
  }
}

export async function selectAccountsCore(orgId: string, actor: string, id: unknown, input: unknown): Promise<UiResult<BankConnectionClientView>> {
  try {
    return { ok: true, data: toConnectionClientView(await selectAccounts(orgId, idSchema.parse(id), input, actor)) };
  } catch (e) {
    return failure(e, "Konten auswählen");
  }
}

export async function connectCore(orgId: string, actor: string, id: unknown, input: unknown): Promise<UiResult<SetupUi>> {
  try {
    return { ok: true, data: toSetupUi(await connectBankConnection(orgId, idSchema.parse(id), input, { userId: actor, name: actor })) };
  } catch (e) {
    return failure(e, "Einrichtung");
  }
}

export async function continueSetupCore(orgId: string, actor: string, token: unknown, input: unknown): Promise<UiResult<SetupUi>> {
  try {
    return { ok: true, data: toSetupUi(await continueSetup(orgId, tokenSchema.parse(token), input, { userId: actor, name: actor })) };
  } catch (e) {
    return failure(e, "Freigabe");
  }
}

export async function startFetchCore(orgId: string, actor: string, id: unknown, input: unknown): Promise<UiResult<FetchUi>> {
  try {
    return { ok: true, data: toFetchUi(await startManualFetch(orgId, idSchema.parse(id), input, { userId: actor, name: actor })) };
  } catch (e) {
    return failure(e, "Abruf");
  }
}

export async function continueFetchCore(orgId: string, actor: string, token: unknown, input: unknown): Promise<UiResult<FetchUi>> {
  try {
    return { ok: true, data: toFetchUi(await continueManualFetch(orgId, tokenSchema.parse(token), input, { userId: actor, name: actor })) };
  } catch (e) {
    return failure(e, "Freigabe");
  }
}

export async function cancelFetchCore(orgId: string, actor: string, token: unknown): Promise<UiResult> {
  try {
    await cancelManualFetch(orgId, tokenSchema.parse(token), { userId: actor, name: actor });
    return { ok: true };
  } catch (e) {
    return failure(e, "Abbruch");
  }
}

export async function cancelSetupCore(orgId: string, actor: string, token: unknown): Promise<UiResult> {
  try {
    await cancelSetup(orgId, tokenSchema.parse(token), { userId: actor, name: actor });
    return { ok: true };
  } catch (e) {
    return failure(e, "Abbruch");
  }
}
