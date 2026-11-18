/**
 * Einstellungen des Kontoabrufs je Firma. Die Produkt-ID wird nur hier geschrieben und nie ausgegeben.
 */
import { dbInternal } from "@/lib/db";
import { berlinMidnight, berlinParts } from "@/lib/berlin-time";
import { logActivity } from "@/domain/activity/log";
import { bankFetchSettingsInputSchema } from "@/schemas/bank-fetch";
import { BankFetchError } from "./errors";
import { FETCH_FIRST_DAYS_DEFAULT } from "./limits";

export interface BankFetchSettingsView {
  productIdConfigured: boolean;
  autoHour: number;
  firstFetchDays: number;
}

const DEFAULT_AUTO_HOUR = 6;

export async function loadBankFetchSettings(orgId: string): Promise<BankFetchSettingsView> {
  const row = await dbInternal.bankFetchSettings.findUnique({
    where: { orgId },
    select: { productId: true, autoHour: true, firstFetchDays: true },
  });
  return {
    productIdConfigured: row?.productId != null && row.productId.length > 0,
    autoHour: row?.autoHour ?? DEFAULT_AUTO_HOUR,
    firstFetchDays: row?.firstFetchDays ?? FETCH_FIRST_DAYS_DEFAULT,
  };
}

/** Die Produkt-ID fuer den Verbindungsaufbau; ohne sie wird nie etwas gesendet. */
export async function requireProductId(orgId: string): Promise<string> {
  const row = await dbInternal.bankFetchSettings.findUnique({ where: { orgId }, select: { productId: true } });
  if (!row?.productId) throw new BankFetchError("PRODUCT_ID_MISSING");
  return row.productId;
}

export async function saveBankFetchSettings(orgId: string, raw: unknown, actor: string): Promise<void> {
  const input = bankFetchSettingsInputSchema.parse(raw);
  const existing = await dbInternal.bankFetchSettings.findUnique({
    where: { orgId },
    select: { productId: true, autoHour: true, firstFetchDays: true },
  });
  const changed: string[] = [];
  if (input.productId !== undefined && (existing?.productId ?? null) !== input.productId) changed.push("productId");
  if (input.autoHour !== undefined && (existing?.autoHour ?? DEFAULT_AUTO_HOUR) !== input.autoHour) changed.push("autoHour");
  if (input.firstFetchDays !== undefined && (existing?.firstFetchDays ?? FETCH_FIRST_DAYS_DEFAULT) !== input.firstFetchDays) {
    changed.push("firstFetchDays");
  }
  const data = {
    ...(input.productId !== undefined ? { productId: input.productId } : {}),
    ...(input.autoHour !== undefined ? { autoHour: input.autoHour } : {}),
    ...(input.firstFetchDays !== undefined ? { firstFetchDays: input.firstFetchDays } : {}),
  };
  const row = await dbInternal.bankFetchSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data, select: { id: true } });
  if (changed.length > 0) {
    await logActivity(dbInternal, { orgId, entityType: "BANK_CONNECTION", entityId: row.id, type: "BANK_CONNECTION_UPDATED", actor, data: { scope: "settings", changed } });
  }
}

/** Naechster Abrufzeitpunkt: `autoHour` Uhr Berliner Zeit (heute, sonst morgen). */
export function nextAutoRunAt(now: Date, autoHour: number): Date {
  const { year, month, day } = berlinParts(now);
  const today = new Date(berlinMidnight(year, month, day).getTime() + autoHour * 3_600_000);
  return today.getTime() > now.getTime() ? today : new Date(berlinMidnight(year, month, day + 1).getTime() + autoHour * 3_600_000);
}
