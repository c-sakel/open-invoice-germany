/**
 * Status-Abgleich offener Bezahlvorgaenge: Scheduler-Job und Rueckkehrseite. Haengende Anlagen (Zeile
 * ohne Anbieter-Objekt) werden ohne Netzaufruf als fehlgeschlagen markiert.
 */
import { dbInternal } from "@/lib/db";
import { defaultPaymentTransport } from "@/lib/payment/transport";
import type { PaymentTransport } from "@/lib/payment/types";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { describeError } from "@/lib/safe-error";
import { hashToken } from "@/domain/quote-share/token";
import { payLinkTokenSchema } from "@/schemas/online-payment";
import { onOnlinePaymentNotice } from "@/domain/notifications/hooks";
import { ONLINE_PROVIDERS } from "@/lib/payment/types";
import { onlineActor, refreshAttempt } from "./reconcile";
import { resolvePayLinkByToken } from "./pay-link";

const OPEN_MIN_AGE_MS = 15 * 60_000;
const OPEN_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const CREATING_MAX_AGE_MS = 10 * 60_000;
const PER_ORG_DEFAULT = 20;
const RETURN_REFRESH_WINDOW_MS = 15_000;
const DAY_MS = 24 * 60 * 60_000;
const OPEN_FINAL_AGE_MS = 14 * DAY_MS;
const PAID_MAX_AGE_MS = 180 * DAY_MS;
/** Nachpruefung bezahlter Vorgaenge (Erstattung/Rueckbuchung bei verlorener Benachrichtigung), Abstand nimmt mit dem Alter ab. */
const PAID_BANDS: Array<{ maxAgeMs: number; everyMs: number }> = [
  { maxAgeMs: 2 * DAY_MS, everyMs: 6 * 60 * 60_000 },
  { maxAgeMs: 14 * DAY_MS, everyMs: DAY_MS },
  { maxAgeMs: 60 * DAY_MS, everyMs: 7 * DAY_MS },
  { maxAgeMs: PAID_MAX_AGE_MS, everyMs: 30 * DAY_MS },
];

export async function processOnlinePaymentPolls(
  opts: { now?: Date; transport?: PaymentTransport; perOrgLimit?: number } = {},
): Promise<{ checked: number; applied: number; errors: number }> {
  const now = opts.now ?? new Date();
  const limit = opts.perOrgLimit ?? PER_ORG_DEFAULT;
  const transport = opts.transport ?? defaultPaymentTransport();
  let checked = 0;
  let applied = 0;
  let errors = 0;

  // Haengende Anlagen: kein Anbieter-Objekt, aelter als 10 Minuten -> unklar, ohne Netz; einmaliger Hinweis (beim Anbieter pruefen).
  const stuck = await dbInternal.paymentProviderAttempt.findMany({
    where: { status: "CREATING", providerObjectId: null, createdAt: { lt: new Date(now.getTime() - CREATING_MAX_AGE_MS) } },
    select: { id: true, orgId: true, payLink: { select: { invoiceId: true, invoice: { select: { number: true } } } } },
    take: 200,
  });
  for (const a of stuck) {
    const res = await dbInternal.paymentProviderAttempt.updateMany({
      where: { id: a.id, orgId: a.orgId, status: "CREATING", providerObjectId: null },
      data: { status: "FAILED", error: "Anlage unklar" },
    });
    if (res.count !== 1) continue;
    const num = a.payLink.invoice.number;
    await onOnlinePaymentNotice(a.orgId, {
      type: "ONLINE_PAYMENT_ISSUE",
      title: `Online-Zahlung: Anlage unklar${num ? ` (${num})` : ""}`,
      body: "Ein Bezahlvorgang konnte nicht sicher angelegt werden. Bitte beim Zahlungsanbieter pruefen, ob dort eine Zahlung eingegangen ist, und ggf. von Hand buchen.",
      invoiceId: a.payLink.invoiceId,
      dedupeKey: `online:unclear:${a.id}`,
      at: now,
    });
  }

  const t = (ms: number) => new Date(now.getTime() - ms);
  const orgs = await dbInternal.paymentProviderAccount.findMany({ where: { apiKeyEnc: { not: null } }, select: { orgId: true }, distinct: ["orgId"] });
  for (const { orgId } of orgs) {
    const order = [{ lastCheckedAt: { sort: "asc" as const, nulls: "first" as const } }, { createdAt: "asc" as const }];
    const open = await dbInternal.paymentProviderAttempt.findMany({
      where: {
        orgId,
        status: "OPEN",
        providerObjectId: { not: null },
        OR: [
          // Jung genug: regelmaessig alle 15 Minuten.
          { createdAt: { lt: t(OPEN_MIN_AGE_MS), gt: t(OPEN_MAX_AGE_MS) }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: t(OPEN_MIN_AGE_MS) } }] },
          // Aelter als 3 Tage (Bankueberweisung laeuft beim Anbieter bis ~12 Tage): taeglich, bis 14 Tage nach Anlage.
          { createdAt: { lte: t(OPEN_MAX_AGE_MS), gt: t(OPEN_FINAL_AGE_MS) }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: t(DAY_MS) } }] },
        ],
      },
      select: { id: true, provider: true },
      orderBy: order,
      take: limit,
    });
    const paid = await dbInternal.paymentProviderAttempt.findMany({
      where: {
        orgId,
        status: "PAID",
        providerObjectId: { not: null },
        OR: PAID_BANDS.map((band, i) => ({
          createdAt: { gt: t(band.maxAgeMs), ...(i > 0 ? { lte: t(PAID_BANDS[i - 1]!.maxAgeMs) } : {}) },
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: t(band.everyMs) } }],
        })),
      },
      select: { id: true, provider: true },
      orderBy: order,
      take: limit,
    });
    const todo = [...open, ...paid];
    for (const { id, provider: providerRaw } of todo) {
      const provider = ONLINE_PROVIDERS.find((p) => p === providerRaw);
      if (!provider) continue;
      checked += 1;
      try {
        const res = await refreshAttempt(orgId, id, { createdBy: "scheduler", actor: onlineActor(provider), transport, now });
        if (res.kind === "RECONCILED" && res.result === "APPLIED" && !res.duplicate) applied += 1;
      } catch (e) {
        errors += 1;
        console.error("Online-Zahlung: Abgleich fehlgeschlagen:", describeError(e));
      }
    }
  }
  return { checked, applied, errors };
}

/** Rueckkehrseite: juengsten offenen Vorgang des Links abgleichen (hoechstens alle 15 s je Token); wirft nie. */
export async function refreshLatestAttempt(token: string, deps: { transport?: PaymentTransport; now?: Date } = {}): Promise<void> {
  try {
    if (!payLinkTokenSchema.safeParse(token).success) return;
    try {
      rateLimit(`pay-refresh:${hashToken(token)}`, { limit: 1, windowMs: RETURN_REFRESH_WINDOW_MS });
    } catch (e) {
      if (e instanceof RateLimitError) return;
      throw e;
    }
    const link = await resolvePayLinkByToken(token);
    if (!link) return;
    const latest = await dbInternal.paymentProviderAttempt.findFirst({
      where: { payLinkId: link.id, orgId: link.orgId, status: "OPEN", providerObjectId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!latest) return;
    await refreshAttempt(link.orgId, latest.id, {
      createdBy: "webhook",
      actor: onlineActor(link.provider),
      ...(deps.transport ? { transport: deps.transport } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (e) {
    console.error("Online-Zahlung: Abgleich der Rueckkehrseite fehlgeschlagen:", describeError(e));
  }
}
