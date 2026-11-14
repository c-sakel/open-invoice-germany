/**
 * Abrufprotokoll des Kundenportals (append-only, ohne IP und User-Agent). Ein Aufruf der Seite (VIEW) wird
 * hoechstens einmal je Link und Berliner Kalendertag protokolliert, jeder Download (DOWNLOAD) einzeln.
 */
import { dbInternal } from "@/lib/db";
import { berlinMidnight, berlinParts } from "@/lib/berlin-time";
import type { ResolvedPortalLink } from "@/domain/portal/link";

export interface PortalEventInput {
  kind: "VIEW" | "DOWNLOAD";
  docType?: string;
  docId?: string;
  fileKind?: string;
}

export async function recordPortalEvent(link: ResolvedPortalLink, e: PortalEventInput, now: Date = new Date()): Promise<void> {
  if (e.kind === "VIEW") {
    const { year, month, day } = berlinParts(now);
    const dayStart = berlinMidnight(year, month, day);
    const dayEnd = berlinMidnight(year, month, day + 1);
    const existing = await dbInternal.customerPortalEvent.findFirst({
      where: { linkId: link.linkId, orgId: link.orgId, kind: "VIEW", at: { gte: dayStart, lt: dayEnd } },
      select: { id: true },
    });
    if (existing) return;
    await dbInternal.$transaction(async (tx) => {
      await tx.customerPortalEvent.create({ data: { orgId: link.orgId, linkId: link.linkId, kind: "VIEW", at: now } });
      await tx.customerPortalLink.update({
        where: { id: link.linkId },
        data: { lastViewedAt: now, viewCount: { increment: 1 } },
        select: { id: true },
      });
    });
    return;
  }
  await dbInternal.customerPortalEvent.create({
    data: {
      orgId: link.orgId,
      linkId: link.linkId,
      kind: "DOWNLOAD",
      at: now,
      docType: e.docType ?? null,
      docId: e.docId ?? null,
      fileKind: e.fileKind ?? null,
    },
  });
}
