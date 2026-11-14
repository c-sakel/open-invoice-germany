import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { iso } from "./common";
import type { PortalLinkStatus } from "@/domain/portal/link";
import type { PortalSettingsView } from "@/domain/portal/settings";
import type { PortalEventRow } from "@/domain/portal/access";

/** Status eines Links: nie Token, Hash oder URL. */
export function serializePortalLink(l: PortalLinkStatus) {
  return {
    objectName: "PortalLink" as const,
    id: l.id,
    active: l.active,
    createdAt: iso(l.createdAt),
    expiresAt: iso(l.expiresAt),
    revokedAt: iso(l.revokedAt),
    revokeReason: l.revokeReason,
    lastViewedAt: iso(l.lastViewedAt),
    viewCount: l.viewCount,
  };
}

export const portalLinkSchema = z.object({
  objectName: z.literal("PortalLink"),
  id: z.string(),
  active: z.boolean(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
  lastViewedAt: z.string().nullable(),
  viewCount: z.number().int(),
});

export const portalLinkWithUrlSchema = z.object({
  link: portalLinkSchema,
  url: z.string().describe("Vollstaendige Portal-URL; wird nur bei der Anlage und beim Wiederabruf geliefert."),
});

export const portalUrlSchema = z.object({ url: z.string() });

/** Abrufprotokoll ohne IP und User-Agent. */
export function serializePortalEvent(e: PortalEventRow) {
  return {
    objectName: "PortalEvent" as const,
    id: e.id,
    at: iso(e.at),
    kind: e.kind,
    docType: e.docType,
    docId: e.docId,
    fileKind: e.fileKind,
  };
}

export const portalEventSchema = z.object({
  objectName: z.literal("PortalEvent"),
  id: z.string(),
  at: z.string().nullable(),
  kind: z.enum(["VIEW", "DOWNLOAD"]),
  docType: z.string().nullable(),
  docId: z.string().nullable(),
  fileKind: z.string().nullable(),
});

export function serializePortalSettings(v: PortalSettingsView) {
  return {
    objectName: "PortalSettings" as const,
    enabled: v.enabled,
    linkDays: v.linkDays,
    showDunnings: v.showDunnings,
    showEInvoice: v.showEInvoice,
    mailSubject: v.mailSubject,
    mailBody: v.mailBody,
  };
}

export const portalSettingsSchema = z.object({
  objectName: z.literal("PortalSettings"),
  enabled: z.boolean(),
  linkDays: z.number().int(),
  showDunnings: z.boolean(),
  showEInvoice: z.boolean(),
  mailSubject: z.string().nullable(),
  mailBody: z.string().nullable(),
});
