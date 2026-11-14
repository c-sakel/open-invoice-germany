/**
 * Einstellungen des Kundenportals je Organisation (eine Zeile `CustomerPortalSettings`).
 * Ohne Zeile gelten die Standardwerte (Portal aus). Speichern aendert nur uebergebene Felder.
 */
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import { logActivity } from "@/domain/activity/log";
import { portalSettingsInputSchema } from "@/schemas/portal";

export interface PortalSettingsView {
  enabled: boolean;
  linkDays: number;
  showDunnings: boolean;
  showEInvoice: boolean;
  mailSubject: string | null;
  mailBody: string | null;
}

const SELECT = {
  enabled: true,
  linkDays: true,
  showDunnings: true,
  showEInvoice: true,
  mailSubject: true,
  mailBody: true,
} as const;

export const DEFAULT_PORTAL_SETTINGS: PortalSettingsView = {
  enabled: false,
  linkDays: 365,
  showDunnings: true,
  showEInvoice: true,
  mailSubject: null,
  mailBody: null,
};

export async function loadPortalSettings(orgId: string): Promise<PortalSettingsView> {
  const row = await dbInternal.customerPortalSettings.findUnique({ where: { orgId }, select: SELECT });
  return row ?? { ...DEFAULT_PORTAL_SETTINGS };
}

export async function savePortalSettings(orgId: string, raw: unknown, actor: string): Promise<PortalSettingsView> {
  const input = portalSettingsInputSchema.parse(raw);
  return dbInternal.$transaction(async (tx) => {
    await lockOrganization(tx, orgId);
    const base =
      (await tx.customerPortalSettings.findUnique({ where: { orgId }, select: SELECT })) ?? { ...DEFAULT_PORTAL_SETTINGS };
    const next: PortalSettingsView = {
      enabled: input.enabled ?? base.enabled,
      linkDays: input.linkDays ?? base.linkDays,
      showDunnings: input.showDunnings ?? base.showDunnings,
      showEInvoice: input.showEInvoice ?? base.showEInvoice,
      mailSubject: input.mailSubject !== undefined ? (input.mailSubject || null) : base.mailSubject,
      mailBody: input.mailBody !== undefined ? (input.mailBody || null) : base.mailBody,
    };
    const changed = (Object.keys(next) as (keyof PortalSettingsView)[]).filter((k) => next[k] !== base[k]);
    const saved = await tx.customerPortalSettings.upsert({
      where: { orgId },
      create: { orgId, ...next },
      update: next,
      select: SELECT,
    });
    if (changed.length > 0) {
      await logActivity(tx, {
        orgId,
        entityType: "PORTAL",
        entityId: orgId,
        type: "PORTAL_SETTINGS_CHANGED",
        actor,
        data: { changed, enabled: next.enabled, linkDays: next.linkDays },
      });
    }
    return saved;
  });
}
