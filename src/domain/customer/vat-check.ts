/**
 * Phase 17a — qualifizierte Pruefung einer Kunden-USt-IdNr. ueber VIES.
 * Jede Abfrage wird append-only protokolliert (`VatIdCheck`); bei VALID wird
 * `Customer.vatIdValidatedAt` gesetzt. Netz-/Dienstfehler werfen nie, sondern
 * erzeugen ein Protokoll mit Status ERROR.
 */
import { dbInternal } from "@/lib/db";
import { rateLimit, RateLimitError } from "@/lib/rate-limit";
import { externalFetch, ExternalHttpError } from "@/lib/http/external";
import { normalizeVatId, splitVatId, vatIdFormatProblem } from "@/lib/vat-id";
import { NotFoundError } from "@/domain/errors";
import { loadDocumentSettings } from "@/domain/document/settings";
import { CustomerValidationError } from "@/domain/customer/save";
import { viesResponseSchema, type VatIdCheckRow } from "@/schemas/vat-check";

export const VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
export type VatCheckStatus = "VALID" | "INVALID" | "ERROR";

/** Pruefung in den Einstellungen abgeschaltet (REST 409). */
export class VatCheckDisabledError extends Error {
  constructor() {
    super("Die USt-IdNr.-Pruefung ist in den Einstellungen abgeschaltet.");
    this.name = "VatCheckDisabledError";
  }
}

/** Mehr als 20 Abfragen je Minute und Organisation (REST 429). */
export class VatCheckRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("Zu viele USt-IdNr.-Pruefungen — bitte in einer Minute erneut versuchen.");
    this.name = "VatCheckRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

const rowSelect = {
  id: true,
  customerId: true,
  invoiceId: true,
  vatId: true,
  requesterVatId: true,
  status: true,
  errorCode: true,
  requestIdentifier: true,
  requestDate: true,
  traderName: true,
  traderAddress: true,
  trigger: true,
  checkedAt: true,
} as const;

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t && t !== "---" ? t : null;
}

interface Outcome {
  status: VatCheckStatus;
  errorCode: string | null;
  requestIdentifier: string | null;
  requestDate: Date | null;
  traderName: string | null;
  traderAddress: string | null;
}

const emptyOutcome: Outcome = {
  status: "ERROR",
  errorCode: null,
  requestIdentifier: null,
  requestDate: null,
  traderName: null,
  traderAddress: null,
};

export async function checkVatId(
  orgId: string,
  customerId: string,
  opts: { trigger?: "MANUAL" | "FINALIZE"; invoiceId?: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: Date } = {},
): Promise<VatIdCheckRow> {
  const customer = await dbInternal.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true, vatId: true } });
  if (!customer) throw new NotFoundError("Kunde nicht gefunden.");
  if (opts.invoiceId) {
    const inv = await dbInternal.invoice.findFirst({ where: { id: opts.invoiceId, orgId }, select: { id: true } });
    if (!inv) throw new NotFoundError("Rechnung nicht gefunden.");
  }
  const settings = await loadDocumentSettings(orgId);
  if (!settings.viesCheckEnabled) throw new VatCheckDisabledError();
  if (!customer.vatId?.trim()) throw new CustomerValidationError("Der Kunde hat keine USt-IdNr.");

  const vatId = normalizeVatId(customer.vatId);
  const trigger = opts.trigger ?? "MANUAL";
  const org = await dbInternal.organization.findUnique({ where: { id: orgId }, select: { vatId: true } });
  const ownVatId = org?.vatId && !vatIdFormatProblem(org.vatId) ? normalizeVatId(org.vatId) : null;

  let outcome: Outcome;
  if (vatIdFormatProblem(vatId)) {
    outcome = { ...emptyOutcome, errorCode: "FORMAT" };
  } else {
    try {
      rateLimit("vies:" + orgId, { limit: 20, windowMs: 60_000, now: opts.now?.getTime() });
    } catch (e) {
      if (e instanceof RateLimitError) throw new VatCheckRateLimitError(e.retryAfterMs);
      throw e;
    }
    const { countryCode, number } = splitVatId(vatId);
    const requester = ownVatId ? splitVatId(ownVatId) : null;
    const body = JSON.stringify({
      countryCode,
      vatNumber: number,
      ...(requester ? { requesterMemberStateCode: requester.countryCode, requesterNumber: requester.number } : {}),
    });
    outcome = await callVies(body, opts);
  }

  const created = await dbInternal.$transaction(async (tx) => {
    const row = await tx.vatIdCheck.create({
      data: {
        orgId,
        customerId,
        invoiceId: opts.invoiceId ?? null,
        vatId,
        requesterVatId: ownVatId,
        trigger,
        ...(opts.now ? { checkedAt: opts.now } : {}),
        ...outcome,
      },
      select: rowSelect,
    });
    if (outcome.status === "VALID") {
      await tx.customer.update({ where: { id: customerId }, data: { vatIdValidatedAt: outcome.requestDate ?? opts.now ?? new Date() } });
    }
    return row;
  });
  return created as VatIdCheckRow;
}

async function callVies(body: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<Outcome> {
  let text: string;
  try {
    text = await externalFetch(VIES_URL, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", accept: "application/json" },
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxBytes: 64 * 1024,
    });
  } catch (e) {
    const code = e instanceof ExternalHttpError && e.status ? `HTTP_${e.status}` : "NETWORK";
    return { ...emptyOutcome, errorCode: code };
  }
  let parsed;
  try {
    parsed = viesResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return { ...emptyOutcome, errorCode: "BAD_RESPONSE" };
  }
  if (!parsed.success) return { ...emptyOutcome, errorCode: "BAD_RESPONSE" };
  const r = parsed.data;
  const requestDate = r.requestDate && !Number.isNaN(new Date(r.requestDate).getTime()) ? new Date(r.requestDate) : null;
  const common = {
    requestIdentifier: clean(r.requestIdentifier),
    requestDate,
    traderName: clean(r.name),
    traderAddress: clean(r.address),
  };
  const userError = r.userError?.trim() || null;
  if (r.valid && (!userError || userError === "VALID")) return { status: "VALID", errorCode: null, ...common };
  if (!r.valid && (!userError || userError === "INVALID")) return { status: "INVALID", errorCode: null, ...common };
  return { status: "ERROR", errorCode: userError ?? "UNKNOWN", ...common };
}

export async function listVatIdChecks(orgId: string, customerId: string, limit = 50): Promise<VatIdCheckRow[]> {
  const customer = await dbInternal.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true } });
  if (!customer) throw new NotFoundError("Kunde nicht gefunden.");
  const rows = await dbInternal.vatIdCheck.findMany({
    where: { orgId, customerId },
    orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(limit, 1), 50),
    select: rowSelect,
  });
  return rows as VatIdCheckRow[];
}
