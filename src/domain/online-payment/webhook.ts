/**
 * Eingang von Anbieter-Benachrichtigungen. Dem Body wird nie vertraut: er liefert nur die Objekt-Id; der
 * Zustand wird immer per API nachgeladen. Antworten sind bewusst knapp (nur Statuscode). Ohne passenden
 * Vorgang in der eigenen Datenbank wird kein Netzaufruf ausgeloest.
 */
import { dbInternal } from "@/lib/db";
import { adapterFor } from "@/lib/payment/registry";
import { defaultPaymentTransport } from "@/lib/payment/transport";
import { ONLINE_PROVIDERS, PaymentProviderError, type PaymentTransport } from "@/lib/payment/types";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { describeError } from "@/lib/safe-error";
import { hashToken } from "@/domain/quote-share/token";
import { OnlinePaymentError } from "./errors";
import { ONLINE_ACTOR, reconcileAttempt, reportProviderProblem } from "./reconcile";
import { loadProviderSecret } from "./settings";

export const WEBHOOK_BODY_MAX = 1024;
const IP_LIMIT = 120;
const PATH_LIMIT = 600;
const WINDOW_MS = 60_000;

export interface WebhookDeps {
  transport?: PaymentTransport;
  now?: Date;
}

export type WebhookStatus = 200 | 400 | 404 | 429 | 503;

export async function handleProviderWebhook(
  providerRaw: string,
  webhookPathId: string,
  rawBody: string,
  headers: Headers,
  deps: WebhookDeps = {},
): Promise<{ status: WebhookStatus }> {
  const now = deps.now ?? new Date();
  const ip = clientIpFromHeaders(headers);
  try {
    rateLimit(ip ? `pay-hook:ip:${ip}` : "pay-hook:ip:unknown", { limit: ip ? IP_LIMIT : PATH_LIMIT, windowMs: WINDOW_MS });
    rateLimit(`pay-hook:path:${hashToken(webhookPathId)}`, { limit: PATH_LIMIT, windowMs: WINDOW_MS });
  } catch (e) {
    if (e instanceof RateLimitError) return { status: 429 };
    throw e;
  }

  const provider = ONLINE_PROVIDERS.find((p) => p === providerRaw.toUpperCase());
  if (!provider || webhookPathId.length < 16 || webhookPathId.length > 200) return { status: 404 };
  try {
    const account = await dbInternal.paymentProviderAccount.findUnique({ where: { webhookPathId }, select: { orgId: true, provider: true } });
    if (!account || account.provider !== provider) return { status: 404 };
    const orgId = account.orgId;

    if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_BODY_MAX) return { status: 400 };
    const parsed = adapterFor(provider).parseWebhook(rawBody, headers);
    if (!parsed) return { status: 400 };

    // Vorgang nur ueber die eigene Datenbank; die Organisation stammt aus dem Zugang des Pfads, nie aus dem Body.
    const attempt = await dbInternal.paymentProviderAttempt.findUnique({
      where: { provider_providerObjectId: { provider, providerObjectId: parsed.objectId } },
      select: { id: true, orgId: true },
    });
    if (!attempt || attempt.orgId !== orgId) {
      console.warn("Online-Zahlung: Benachrichtigung ohne passenden Vorgang ignoriert");
      return { status: 200 };
    }

    let secret: Awaited<ReturnType<typeof loadProviderSecret>> = null;
    try {
      secret = await loadProviderSecret(orgId, provider);
    } catch (e) {
      if (!(e instanceof OnlinePaymentError)) throw e;
    }
    if (!secret) {
      await reportProviderProblem(orgId, "Online-Zahlung: Zugang nicht nutzbar", "Eine Zahlungsbenachrichtigung konnte nicht abgeglichen werden, weil der API-Schluessel fehlt oder nicht lesbar ist.", now, "nokey");
      return { status: 503 };
    }

    let state;
    try {
      state = await adapterFor(provider).fetchPayment(secret.key, parsed.objectId, deps.transport ?? defaultPaymentTransport());
    } catch (e) {
      if (e instanceof PaymentProviderError && e.kind === "invalid") {
        await recordIgnored(orgId, provider, parsed.objectId, attempt.id, "unusable", "Antwort des Anbieters unbrauchbar", now);
        await reportProviderProblem(orgId, "Online-Zahlung pruefen", "Die Antwort des Zahlungsanbieters war unbrauchbar (z. B. Modus passt nicht zum Zugang); es wurde nichts gebucht.", now, `invalid:${parsed.objectId}`);
        return { status: 200 };
      }
      if (e instanceof PaymentProviderError && e.kind === "auth") {
        await reportProviderProblem(orgId, "Online-Zahlung: Zugang abgelehnt", "Der Zahlungsanbieter lehnt den hinterlegten API-Schluessel ab; Zahlungen koennen nicht abgeglichen werden.", now, "auth");
      }
      return { status: 503 };
    }
    if (!state) {
      await recordIgnored(orgId, provider, parsed.objectId, attempt.id, "missing", "Objekt beim Anbieter nicht gefunden", now);
      return { status: 200 };
    }
    await reconcileAttempt(attempt.id, state, { createdBy: "webhook", actor: ONLINE_ACTOR, now });
    return { status: 200 };
  } catch (e) {
    console.error("Online-Zahlung: Benachrichtigung nicht verarbeitet:", describeError(e));
    return { status: 503 };
  }
}

async function recordIgnored(orgId: string, provider: string, objectId: string, attemptId: string, code: string, detail: string, now: Date): Promise<void> {
  try {
    await dbInternal.paymentProviderEvent.create({
      data: { orgId, provider, eventId: `${objectId}:${code}`, type: "payment.status", objectId, attemptId, receivedAt: now, result: "IGNORED", detail },
      select: { id: true },
    });
  } catch {
    // Duplikat (bereits protokolliert) oder Protokollfehler: ohne Folgen fuer die Antwort.
  }
}
