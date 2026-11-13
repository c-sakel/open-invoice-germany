/**
 * Phase 16d — Verbindungstest und Preisabfrage zum Briefdienst.
 *
 * Der Verbindungstest ruft AUSSCHLIESSLICH den lesenden Endpunkt /balance (Guthaben) auf,
 * nie einen schreibenden, und wird nie vom Scheduler ausgeloest. Der Transport ist
 * injizierbar (Tests: Fake); ohne Injektion gilt defaultTransport() mit Notschalter.
 */
import { dbInternal } from "@/lib/db";
import { createLetterXpressClient, LxpAuthError, redact } from "@/lib/postal/letterxpress";
import { defaultTransport, type LxpTransport } from "@/lib/postal/transport";
import { postalPriceQuerySchema } from "@/schemas/postal";
import {
  loadPostalCredentials,
  loadPostalSettings,
  PostalDisabledError,
  PostalKeyUnreadableError,
  PostalNotConfiguredError,
} from "./settings";

export async function testPostalConnection(
  orgId: string,
  deps: { transport?: LxpTransport; now?: Date } = {},
): Promise<{ ok: true; balanceCents: number } | { ok: false; error: string }> {
  const now = deps.now ?? new Date();
  const record = async (ok: boolean, error: string | null, balanceCents?: number): Promise<void> => {
    await dbInternal.postalSettings.update({
      where: { orgId },
      data: {
        lastTestAt: now,
        lastTestOk: ok,
        lastTestError: error,
        ...(balanceCents !== undefined ? { lastBalanceCents: balanceCents } : {}),
      },
      select: { id: true },
    });
  };

  let creds;
  try {
    creds = await loadPostalCredentials(orgId);
  } catch (e) {
    if (e instanceof PostalKeyUnreadableError) {
      await record(false, e.message);
      return { ok: false, error: e.message };
    }
    throw e;
  }
  if (!creds) throw new PostalNotConfiguredError();

  const client = createLetterXpressClient(creds, deps.transport ?? defaultTransport());
  try {
    const { balanceCents } = await client.balance();
    await record(true, null, balanceCents);
    return { ok: true, balanceCents };
  } catch (e) {
    const error = e instanceof LxpAuthError ? e.message : redact(e instanceof Error ? e.message : "Unbekannter Fehler.", creds);
    await record(false, error);
    return { ok: false, error };
  }
}

export async function queryPostalPrice(
  orgId: string,
  raw: unknown,
  deps: { transport?: LxpTransport } = {},
): Promise<{ priceCents: number }> {
  const q = postalPriceQuerySchema.parse(raw);
  const settings = await loadPostalSettings(orgId);
  if (!settings.enabled) throw new PostalDisabledError();
  const creds = await loadPostalCredentials(orgId);
  if (!creds) throw new PostalNotConfiguredError();
  const client = createLetterXpressClient(creds, deps.transport ?? defaultTransport());
  return client.price({
    pages: q.pages,
    color: q.color,
    duplex: q.duplex,
    shipping: q.shipping,
    registered: q.registered ?? null,
  });
}
