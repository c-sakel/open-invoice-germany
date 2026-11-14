"use server";

/**
 * Server-Actions des Bankabgleichs: gleiche Validierung (Zod) und dieselben Domainfunktionen wie REST und MCP.
 * Gebucht wird nur ueber die Domaindienste (Zahlung, Gegenbuchung); die Organisation kommt aus der Sitzung.
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { describeError } from "@/lib/safe-error";
import { NotFoundError } from "@/domain/errors";
import { PaymentError } from "@/domain/invoice/payment";
import { BankAllocationError, BankConflictError } from "@/domain/bank/errors";
import { confirmBankMatch, confirmUnambiguous, ignoreBankTransaction, reopenBankTransaction, undoBankMatch } from "@/domain/bank/confirm";
import { confirmBankReturn } from "@/domain/bank/return";
import { searchOpenInvoices, type OpenInvoiceHit } from "@/domain/bank/suggest";
import { bankConfirmUnambiguousInputSchema, parseBankId } from "@/schemas/bank";
import type { BankActionResult } from "@/components/bank/bank-view";

type Ctx = { orgId: string; actor: string };

async function run<T>(fn: (ctx: Ctx) => Promise<T>): Promise<BankActionResult<T>> {
  try {
    const org = await getActiveOrg();
    const actor = (await getCurrentUserId()) ?? "system";
    const data = await fn({ orgId: org.id, actor });
    revalidatePath("/bankabgleich");
    revalidatePath("/rechnungen");
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues[0]?.message ?? "Ungültige Eingabe." };
    if (e instanceof BankConflictError || e instanceof BankAllocationError || e instanceof PaymentError || e instanceof NotFoundError) {
      return { ok: false, error: e.message };
    }
    console.error("Bankabgleich:", describeError(e));
    return { ok: false, error: "Die Aktion konnte nicht ausgeführt werden." };
  }
}

const opts = (ctx: Ctx) => ({ actor: ctx.actor, createdBy: "user" as const });

export async function confirmMatchAction(txId: string, input: unknown): Promise<BankActionResult<{ payments: number }>> {
  return run(async (ctx) => {
    const r = await confirmBankMatch(ctx.orgId, parseBankId(txId), input, opts(ctx));
    return { payments: r.payments.length };
  });
}

export interface BulkConfirmView {
  confirmed: number;
  skipped: Array<{ transactionId: string; reason: string }>;
  truncated: boolean;
  remaining: number;
}

export async function confirmUnambiguousAction(input: unknown): Promise<BankActionResult<BulkConfirmView>> {
  return run((ctx) => confirmUnambiguous(ctx.orgId, bankConfirmUnambiguousInputSchema.parse(input), opts(ctx)));
}

export async function ignoreAction(txId: string, input: unknown): Promise<BankActionResult<{ status: string }>> {
  return run(async (ctx) => ({ status: (await ignoreBankTransaction(ctx.orgId, parseBankId(txId), input, opts(ctx))).status }));
}

export async function reopenAction(txId: string): Promise<BankActionResult<{ status: string }>> {
  return run(async (ctx) => ({ status: (await reopenBankTransaction(ctx.orgId, parseBankId(txId), opts(ctx))).status }));
}

export async function undoAction(txId: string, input: unknown): Promise<BankActionResult<{ status: string }>> {
  return run(async (ctx) => ({ status: (await undoBankMatch(ctx.orgId, parseBankId(txId), input, opts(ctx))).status }));
}

export async function returnAction(txId: string, input: unknown): Promise<BankActionResult<{ feeCents: number; partial: boolean }>> {
  return run(async (ctx) => {
    const r = await confirmBankReturn(ctx.orgId, parseBankId(txId), input, opts(ctx));
    return { feeCents: r.feeCents, partial: r.partial };
  });
}

const searchSchema = z.object({ q: z.string().trim().min(1, "Bitte einen Suchbegriff eingeben.").max(100) });

export async function searchInvoicesAction(input: unknown): Promise<BankActionResult<OpenInvoiceHit[]>> {
  try {
    const org = await getActiveOrg();
    const { q } = searchSchema.parse(input);
    return { ok: true, data: await searchOpenInvoices(org.id, q) };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues[0]?.message ?? "Ungültige Eingabe." };
    console.error("Bankabgleich Suche:", describeError(e));
    return { ok: false, error: "Die Suche ist fehlgeschlagen." };
  }
}
