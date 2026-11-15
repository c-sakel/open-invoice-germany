/**
 * Bezahllink fuer Belegausgaben (PDF, E-Rechnung, Mail, Kundenportal). Der Klartext-Token wird nur
 * hier und nur fuer die jeweilige Ausgabe entschluesselt; er gelangt nie in Protokolle.
 *
 * Regeln:
 * - PDF/XML: Link genau dann, wenn der Link `onDocument` traegt (nur Live-Konto) und aktiv ist, die Rechnung weder
 *   Entwurf noch storniert noch voll bezahlt ist und `APP_BASE_URL` gesetzt ist. Bereits archivierte Belege bleiben
 *   unveraendert (das Archiv gibt die erste Ausgabe wieder).
 * - Mail: genau dann, wenn ein aktives Live-Konto, Einstellung "in Mail zeigen", aktiver Link, offener Rest und nicht
 *   stornierte Rechnung vorliegen — unabhaengig von `onDocument` (das steuert nur PDF/E-Rechnung).
 * - Portal: relative Adresse der Bezahlseite, nur bei aktivem Link, Einstellung "im Portal zeigen", offenem Rest,
 *   nicht stornierter Rechnung und aktivem Live-Konto.
 */
import { dbInternal } from "@/lib/db";
import { decryptSecret, PAYLINK_TOKEN_PURPOSE } from "@/lib/crypto/secrets";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";

/**
 * Markiert Links im Moment der Ausgabe als im Livebetrieb ausgegeben (nur false -> true, bedingt und idempotent,
 * ohne Sperren). Damit gilt: jeder Link, den ein Kunde im Livebetrieb sehen konnte, ist liveIssued.
 */
async function markLiveIssued(orgId: string, linkIds: string[]): Promise<void> {
  if (linkIds.length === 0) return;
  await dbInternal.invoicePayLink.updateMany({ where: { orgId, id: { in: linkIds }, liveIssued: false }, data: { liveIssued: true } });
}

function payUrl(baseUrl: string, tokenEnc: string): string {
  return `${baseUrl}/zahlen/${decryptSecret(tokenEnc, PAYLINK_TOKEN_PURPOSE)}`;
}

/** Link fuer PDF und E-Rechnung; null = kein Link auf dem Beleg. */
export async function documentPayLinkUrl(orgId: string, invoice: { id: string; status: string }, openCents: number): Promise<string | null> {
  if (invoice.status === "DRAFT" || invoice.status === "CANCELLED" || openCents <= 0) return null;
  const baseUrl = appBaseUrlFromEnv();
  if (!baseUrl) return null;
  const link = await dbInternal.invoicePayLink.findFirst({
    where: { invoiceId: invoice.id, orgId, onDocument: true, status: "ACTIVE" },
    select: { id: true, tokenEnc: true },
  });
  if (!link) return null;
  await markLiveIssued(orgId, [link.id]);
  return payUrl(baseUrl, link.tokenEnc);
}

/** Link fuer den Mail-Platzhalter `{{invoice.paymentLink}}`; leer, wenn die Regeln ihn ausschliessen. */
export async function mailPayLinkUrl(orgId: string, invoice: { id: string; status: string }, openCents: number): Promise<string> {
  if (invoice.status === "DRAFT" || invoice.status === "CANCELLED" || openCents <= 0) return "";
  const baseUrl = appBaseUrlFromEnv();
  if (!baseUrl) return "";
  const [link, settings, liveAccount] = await Promise.all([
    dbInternal.invoicePayLink.findFirst({ where: { invoiceId: invoice.id, orgId, status: "ACTIVE" }, select: { id: true, tokenEnc: true, provider: true } }),
    dbInternal.paymentProviderSettings.findUnique({ where: { orgId }, select: { showInMail: true } }),
    dbInternal.paymentProviderAccount.findMany({ where: { orgId, enabled: true, mode: "LIVE", apiKeyEnc: { not: null } }, select: { provider: true } }),
  ]);
  if (!link || !(settings?.showInMail ?? true)) return "";
  if (!liveAccount.some((a) => a.provider === link.provider)) return "";
  await markLiveIssued(orgId, [link.id]);
  return payUrl(baseUrl, link.tokenEnc);
}

/** Relative Bezahladresse je Rechnungs-Id fuer das Portal (nur offene, bezahlbare Rechnungen). */
export async function portalPayPaths(orgId: string, invoices: Array<{ id: string; status: string; openCents: number }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const candidates = invoices.filter((i) => i.status !== "DRAFT" && i.status !== "CANCELLED" && i.openCents > 0);
  if (candidates.length === 0) return out;
  const settings = await dbInternal.paymentProviderSettings.findUnique({ where: { orgId }, select: { showInPortal: true } });
  if (!(settings?.showInPortal ?? true)) return out;
  const liveAccounts = await dbInternal.paymentProviderAccount.findMany({
    where: { orgId, enabled: true, mode: "LIVE", apiKeyEnc: { not: null } },
    select: { provider: true },
  });
  if (liveAccounts.length === 0) return out;
  const providers = liveAccounts.map((a) => a.provider);
  const ids = candidates.map((c) => c.id);
  for (let i = 0; i < ids.length; i += 500) {
    const links = await dbInternal.invoicePayLink.findMany({
      where: { orgId, invoiceId: { in: ids.slice(i, i + 500) }, status: "ACTIVE", provider: { in: providers } },
      select: { id: true, invoiceId: true, tokenEnc: true },
    });
    await markLiveIssued(orgId, links.map((l) => l.id));
    for (const l of links) out.set(l.invoiceId, `/zahlen/${decryptSecret(l.tokenEnc, PAYLINK_TOKEN_PURPOSE)}`);
  }
  return out;
}
