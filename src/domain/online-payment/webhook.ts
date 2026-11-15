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
import { onlineActor, reconcileAttempt, reportProviderProblem } from "./reconcile";
import { loadProviderSecret, loadWebhookSigningSecret } from "./settings";

/** Obergrenze fuer unbekannte Anbieter; je Anbieter gilt `webhookBodyMax` des Adapters. */
export const WEBHOOK_BODY_MAX = 1024;

/** Hoechstzahl Bytes des Webhook-Bodys fuer den Anbieter aus dem Pfad (unbekannt: 1024). */
export function webhookBodyMaxFor(providerRaw: string): number {
  const provider = ONLINE_PROVIDERS.find((p) => p === providerRaw.toUpperCase());
  return provider ? adapterFor(provider).webhookBodyMax : WEBHOOK_BODY_MAX;
}

const PROVIDER_LABEL: Record<(typeof ONLINE_PROVIDERS)[number], string> = { MOLLIE: "Mollie", STRIPE: "Stripe" };
const IP_LIMIT = 120;
const PATH_LIMIT = 600;
const WINDOW_MS = 60_000;

export interface WebhookDeps {
  transport?: PaymentTransport;
  now?: Date;
  /** Nur fuer Tests: abweichende Grenzen je Minute. */
  limits?: { ip?: number; path?: number };
}

/** Liest den Body erst nach Rate-Limit und Pfadpruefung (Rohbytes, fuer die Signatur unveraendert); null = zu gross. */
export type WebhookBodyReader = () => Promise<Buffer | string | null>;

export type WebhookStatus = 200 | 400 | 404 | 429 | 503;

export async function handleProviderWebhook(
  providerRaw: string,
  webhookPathId: string,
  body: string | Buffer | WebhookBodyReader,
  headers: Headers,
  deps: WebhookDeps = {},
): Promise<{ status: WebhookStatus }> {
  const now = deps.now ?? new Date();
  const ip = clientIpFromHeaders(headers);
  try {
    rateLimit(ip ? `pay-hook:ip:${ip}` : "pay-hook:ip:unknown", { limit: deps.limits?.ip ?? (ip ? IP_LIMIT : PATH_LIMIT), windowMs: WINDOW_MS });
  } catch (e) {
    if (e instanceof RateLimitError) return { status: 429 };
    throw e;
  }

  const provider = ONLINE_PROVIDERS.find((p) => p === providerRaw.toUpperCase());
  if (!provider || webhookPathId.length < 16 || webhookPathId.length > 200) return { status: 404 };
  try {
    const account = await dbInternal.paymentProviderAccount.findUnique({ where: { webhookPathId }, select: { orgId: true, provider: true, mode: true } });
    if (!account || account.provider !== provider) return { status: 404 };
    const orgId = account.orgId;

    // Pfad-Limit erst fuer bekannte Pfade (begrenzte Schluesselzahl).
    try {
      rateLimit(`pay-hook:path:${hashToken(webhookPathId)}`, { limit: deps.limits?.path ?? PATH_LIMIT, windowMs: WINDOW_MS });
    } catch (e) {
      if (e instanceof RateLimitError) return { status: 429 };
      throw e;
    }
    const read = typeof body === "function" ? await body() : body;
    const rawBody = read === null ? null : typeof read === "string" ? Buffer.from(read, "utf8") : read;
    const adapter = adapterFor(provider);
    if (rawBody === null || rawBody.byteLength > adapter.webhookBodyMax) return { status: 400 };
    const label = PROVIDER_LABEL[provider];
    let signingSecret: string | null = null;
    if (adapter.webhookAuth === "signature") {
      try {
        signingSecret = await loadWebhookSigningSecret(orgId, provider);
      } catch (e) {
        if (!(e instanceof OnlinePaymentError)) throw e;
      }
      if (!signingSecret) {
        await reportQuietly(orgId, "Online-Zahlung: Zugang nicht nutzbar", `${label}: Signaturschluessel fehlt oder ist nicht lesbar; Benachrichtigungen koennen nicht geprueft werden.`, now, `nowhsec:${provider}`);
        return { status: 503 };
      }
    }
    // Signatur (falls vorgesehen) wird im Adapter vor jedem JSON-Parse ueber die Rohbytes geprueft.
    const hook = adapter.parseWebhook(rawBody, headers, { signingSecret, now });
    if (hook.kind === "REJECT") {
      if (hook.reason === "NO_SECRET") return { status: 503 };
      if (hook.reason === "UNSUPPORTED_FORMAT") {
        await reportQuietly(orgId, "Online-Zahlung: Ereignisziel pruefen", `${label}: Ereignisziel im Format Snapshot anlegen.`, now, `fmt:${provider}`);
      } else if (adapter.webhookAuth === "signature") {
        // Vor gueltiger Signatur hoechstens eine Tagesmeldung (dedupe), Fehler darin ohne Wirkung auf die Antwort.
        await reportQuietly(orgId, "Online-Zahlung: Signatur ungueltig", `${label}-Benachrichtigung mit ungueltiger Signatur — Signaturschluessel pruefen.`, now, `sig:${provider}`);
      }
      return { status: 400 };
    }
    if (hook.kind === "IRRELEVANT") return { status: 200 };
    // Modus des Ereignisses muss zum Kontomodus passen (Live-Ereignisse nie an ein Testkonto und umgekehrt).
    if (hook.livemode !== null && hook.livemode !== (account.mode === "LIVE")) return { status: 200 };

    // Vorgang nur ueber die eigene Datenbank; die Organisation stammt aus dem Zugang des Pfads, nie aus dem Body.
    const attempt = await dbInternal.paymentProviderAttempt.findUnique({
      where:
        "objectId" in hook.ref
          ? { provider_providerObjectId: { provider, providerObjectId: hook.ref.objectId } }
          : { provider_providerPaymentRef: { provider, providerPaymentRef: hook.ref.paymentRef } },
      select: { id: true, orgId: true, providerObjectId: true },
    });
    if (!attempt || attempt.orgId !== orgId || !attempt.providerObjectId) {
      console.warn("Online-Zahlung: Benachrichtigung ohne passenden Vorgang ignoriert");
      return { status: 200 };
    }
    const parsed = { objectId: attempt.providerObjectId };

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
    await reconcileAttempt(attempt.id, state, { createdBy: "webhook", actor: onlineActor(provider), now });
    return { status: 200 };
  } catch (e) {
    console.error("Online-Zahlung: Benachrichtigung nicht verarbeitet:", describeError(e));
    return { status: 503 };
  }
}

/** Tagesmeldung ohne Einfluss auf die Antwort: Fehler beim Schreiben werden geschluckt. */
async function reportQuietly(orgId: string, title: string, body: string, now: Date, key: string): Promise<void> {
  try {
    await reportProviderProblem(orgId, title, body, now, key);
  } catch (e) {
    console.error("Online-Zahlung: Meldung nicht gespeichert:", describeError(e));
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
