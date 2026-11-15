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
import { ONLINE_ACTOR, refreshAttempt } from "./reconcile";
import { resolvePayLinkByToken } from "./pay-link";

const OPEN_MIN_AGE_MS = 15 * 60_000;
const OPEN_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const CREATING_MAX_AGE_MS = 10 * 60_000;
const PER_ORG_DEFAULT = 20;
const RETURN_REFRESH_WINDOW_MS = 15_000;

export async function processOnlinePaymentPolls(
  opts: { now?: Date; transport?: PaymentTransport; perOrgLimit?: number } = {},
): Promise<{ checked: number; applied: number; errors: number }> {
  const now = opts.now ?? new Date();
  const limit = opts.perOrgLimit ?? PER_ORG_DEFAULT;
  const transport = opts.transport ?? defaultPaymentTransport();
  let checked = 0;
  let applied = 0;
  let errors = 0;

  // Haengende Anlagen: kein Anbieter-Objekt, aelter als 10 Minuten -> unklar, ohne Netz.
  await dbInternal.paymentProviderAttempt.updateMany({
    where: { status: "CREATING", providerObjectId: null, createdAt: { lt: new Date(now.getTime() - CREATING_MAX_AGE_MS) } },
    data: { status: "FAILED", error: "Anlage unklar" },
  });

  const orgs = await dbInternal.paymentProviderAccount.findMany({ where: { apiKeyEnc: { not: null } }, select: { orgId: true }, distinct: ["orgId"] });
  for (const { orgId } of orgs) {
    const attempts = await dbInternal.paymentProviderAttempt.findMany({
      where: {
        orgId,
        status: "OPEN",
        providerObjectId: { not: null },
        createdAt: { lt: new Date(now.getTime() - OPEN_MIN_AGE_MS), gt: new Date(now.getTime() - OPEN_MAX_AGE_MS) },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - OPEN_MIN_AGE_MS) } }],
      },
      select: { id: true },
      orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: limit,
    });
    for (const a of attempts) {
      checked += 1;
      try {
        const res = await refreshAttempt(orgId, a.id, { createdBy: "scheduler", actor: ONLINE_ACTOR, transport, now });
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
      actor: ONLINE_ACTOR,
      ...(deps.transport ? { transport: deps.transport } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (e) {
    console.error("Online-Zahlung: Abgleich der Rueckkehrseite fehlgeschlagen:", describeError(e));
  }
}
