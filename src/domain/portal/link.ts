/**
 * Portal-Links: anlegen (rotiert einen aktiven Link), widerrufen, Status, Wiederabruf, Aufloesung.
 * Das Klartext-Token liegt nie in der Datenbank im Klartext (tokenHash + verschluesseltes tokenEnc) und nie
 * im ActivityLog. Hoechstens ein aktiver Link je Kunde (Zeilensperre auf den Kunden).
 * `resolvePortalToken` liefert fuer jeden Ungueltigkeitsfall einheitlich null.
 */
import type { Prisma } from "@prisma/client";
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { decryptSecret, encryptSecret, PORTAL_TOKEN_PURPOSE } from "@/lib/crypto/secrets";
import { createPortalLinkInputSchema } from "@/schemas/portal";
import { PortalError } from "@/domain/portal/errors";
import { loadPortalSettings } from "@/domain/portal/settings";
import { generateToken, hashToken, isWellFormedPortalToken } from "@/domain/portal/token";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";

export interface PortalLinkStatus {
  id: string;
  active: boolean;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  lastViewedAt: Date | null;
  viewCount: number;
}

export interface ResolvedPortalLink {
  linkId: string;
  orgId: string;
  customerId: string;
  customerName: string;
  language: string;
  expiresAt: Date;
  showDunnings: boolean;
  showEInvoice: boolean;
}

const STATUS_SELECT = {
  id: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  revokeReason: true,
  lastViewedAt: true,
  viewCount: true,
} as const;

function toStatus(
  row: { id: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null; revokeReason: string | null; lastViewedAt: Date | null; viewCount: number },
  now: Date,
): PortalLinkStatus {
  return { ...row, active: row.revokedAt === null && row.expiresAt.getTime() > now.getTime() };
}

/**
 * Basis-URL fuer Portal-Links: ausschliesslich APP_BASE_URL. Kein Rueckfall auf den Host-Header des Requests,
 * damit ein manipulierter Host keinen Link auf eine fremde Adresse in Mails an Kunden bringt.
 */
export function requirePortalBaseUrl(): string {
  const baseUrl = appBaseUrlFromEnv();
  if (!baseUrl) throw new PortalError("APP_BASE_URL ist nicht gesetzt; ohne Server-Adresse kann kein Portal-Link erzeugt werden.", "NO_BASE_URL");
  return baseUrl;
}

function buildUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/portal/${token}`;
}

export async function createPortalLink(
  orgId: string,
  customerId: string,
  raw: unknown,
  opts: { actor: string; now?: Date; baseUrl: string },
): Promise<{ link: PortalLinkStatus; url: string }> {
  const input = createPortalLinkInputSchema.parse(raw ?? {});
  const now = opts.now ?? new Date();
  // Erst die Kundenpruefung (fremder Kunde -> 404), dann der Portalstatus.
  const known = await dbInternal.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true } });
  if (!known) throw new NotFoundError("Kunde nicht gefunden.");
  const settings = await loadPortalSettings(orgId);
  if (!settings.enabled) throw new PortalError("Das Kundenportal ist nicht aktiviert.", "PORTAL_DISABLED");

  const token = generateToken();
  const tokenEnc = encryptSecret(token, PORTAL_TOKEN_PURPOSE);
  const days = input.expiresInDays ?? settings.linkDays;
  const expiresAt = new Date(now.getTime() + days * 86_400_000);

  const link = await dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "Customer", customerId, orgId);
    const customer = await tx.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true, isArchived: true } });
    if (!customer) throw new NotFoundError("Kunde nicht gefunden.");
    if (customer.isArchived) throw new PortalError("Der Kunde ist archiviert.", "CUSTOMER_ARCHIVED");

    const active = await tx.customerPortalLink.findMany({
      where: { orgId, customerId, revokedAt: null },
      select: { id: true },
    });
    if (active.length > 0) {
      await tx.customerPortalLink.updateMany({
        where: { orgId, customerId, revokedAt: null },
        data: { revokedAt: now, revokedBy: opts.actor, revokeReason: "ROTATED", tokenEnc: "" },
      });
      for (const a of active) {
        await logActivity(tx, {
          orgId,
          entityType: "CUSTOMER",
          entityId: customerId,
          type: "PORTAL_LINK_REVOKED",
          actor: opts.actor,
          at: now,
          data: { linkId: a.id, reason: "ROTATED" },
        });
      }
    }
    const created = await tx.customerPortalLink.create({
      data: { orgId, customerId, tokenHash: hashToken(token), tokenEnc, expiresAt, createdBy: opts.actor, createdAt: now },
      select: STATUS_SELECT,
    });
    await logActivity(tx, {
      orgId,
      entityType: "CUSTOMER",
      entityId: customerId,
      type: "PORTAL_LINK_CREATED",
      actor: opts.actor,
      at: now,
      data: { linkId: created.id, expiresAt: expiresAt.toISOString() },
    });
    return created;
  });
  return { link: toStatus(link, now), url: buildUrl(opts.baseUrl, token) };
}

/** Widerruf innerhalb einer bestehenden Transaktion (z. B. beim Archivieren des Kunden). */
export async function revokePortalLinkInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  customerId: string,
  opts: { actor: string; now?: Date; reason?: "MANUAL" | "CUSTOMER_ARCHIVED" },
): Promise<PortalLinkStatus | null> {
  const now = opts.now ?? new Date();
  const reason = opts.reason ?? "MANUAL";
  await lockRow(tx, "Customer", customerId, orgId);
  const active = await tx.customerPortalLink.findMany({
    where: { orgId, customerId, revokedAt: null },
    select: { id: true },
  });
  if (active.length === 0) return null;
  await tx.customerPortalLink.updateMany({
    where: { orgId, customerId, revokedAt: null },
    data: { revokedAt: now, revokedBy: opts.actor, revokeReason: reason, tokenEnc: "" },
  });
  for (const a of active) {
    await logActivity(tx, {
      orgId,
      entityType: "CUSTOMER",
      entityId: customerId,
      type: "PORTAL_LINK_REVOKED",
      actor: opts.actor,
      at: now,
      data: { linkId: a.id, reason },
    });
  }
  const last = await tx.customerPortalLink.findUniqueOrThrow({ where: { id: active[0]!.id }, select: STATUS_SELECT });
  return toStatus(last, now);
}

export async function revokePortalLink(
  orgId: string,
  customerId: string,
  opts: { actor: string; now?: Date; reason?: "MANUAL" | "CUSTOMER_ARCHIVED" },
): Promise<PortalLinkStatus | null> {
  return dbInternal.$transaction((tx) => revokePortalLinkInTx(tx, orgId, customerId, opts));
}

/** Status des juengsten Links des Kunden (aktiv oder zuletzt beendet); null ohne Link. */
export async function getPortalLinkStatus(orgId: string, customerId: string, now: Date = new Date()): Promise<PortalLinkStatus | null> {
  const row = await dbInternal.customerPortalLink.findFirst({
    where: { orgId, customerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: STATUS_SELECT,
  });
  return row ? toStatus(row, now) : null;
}

/** Wiederabruf der URL des aktiven Links; null ohne aktiven Link. */
export async function revealPortalUrl(orgId: string, customerId: string, baseUrl: string, now: Date = new Date()): Promise<string | null> {
  const row = await dbInternal.customerPortalLink.findFirst({
    where: { orgId, customerId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { tokenEnc: true },
  });
  if (!row) return null;
  return buildUrl(baseUrl, decryptSecret(row.tokenEnc, PORTAL_TOKEN_PURPOSE));
}

/** Oeffentliche Aufloesung. Einheitlich null fuer jeden Ungueltigkeitsfall. */
export async function resolvePortalToken(token: string, now: Date = new Date()): Promise<ResolvedPortalLink | null> {
  if (!isWellFormedPortalToken(token)) return null;
  const row = await dbInternal.customerPortalLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      orgId: true,
      customerId: true,
      expiresAt: true,
      revokedAt: true,
      customer: { select: { name: true, language: true, isArchived: true } },
      org: { select: { portalSettings: { select: { enabled: true, showDunnings: true, showEInvoice: true } } } },
    },
  });
  if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= now.getTime()) return null;
  if (row.customer.isArchived) return null;
  const settings = row.org.portalSettings;
  if (!settings || !settings.enabled) return null;
  return {
    linkId: row.id,
    orgId: row.orgId,
    customerId: row.customerId,
    customerName: row.customer.name,
    language: row.customer.language,
    expiresAt: row.expiresAt,
    showDunnings: settings.showDunnings,
    showEInvoice: settings.showEInvoice,
  };
}
