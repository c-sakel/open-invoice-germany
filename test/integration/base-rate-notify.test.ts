/**
 * Pflicht-Alarm "Basiszinssatz fehlt" (checkBaseRateNotifications, Job). Testjahr 2310.
 */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { upsertBaseRate } from "@/domain/dunning/base-rate";
import { saveNotificationSettings } from "@/domain/notifications/settings";
import { runNotificationsJob } from "@/domain/notifications/job";
import { checkBaseRateNotifications } from "@/domain/dunning/base-rate-notify";

const NOW = new Date("2310-03-10T10:00:00.000Z");
let seq = 0;

async function mkOrg(withInterestStage: boolean, enabled = true): Promise<string> {
  seq += 1;
  const org = await dbInternal.organization.create({
    data: { legalName: `Basiszins-Alarm ${seq} GmbH`, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: `DE2310${String(seq).padStart(5, "0")}` },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  // Standard-Mahnstufen entfernen, damit der Zustand eindeutig ist.
  await dbInternal.dunningStage.deleteMany({ where: { orgId: org.id } });
  await dbInternal.dunningStage.create({
    data: { orgId: org.id, order: 1, name: "Stufe", daysAfterDue: 7, calculateInterest: withInterestStage, enabled, includeB2BFlatFee: false },
  });
  // Nur ein alter Satz: das laufende Halbjahr fehlt.
  await upsertBaseRate(org.id, { validFrom: "2309-07-01", rateBp: 250 });
  return org.id;
}

async function count(orgId: string): Promise<number> {
  return dbInternal.notification.count({ where: { orgId, type: "BASE_RATE_MISSING" } });
}

describe("checkBaseRateNotifications", () => {
  it("legt bei zinsrechnender Stufe genau eine Meldung an, der zweite Lauf dedupliziert", async () => {
    const orgId = await mkOrg(true);
    expect(await checkBaseRateNotifications(orgId, NOW)).toBe(1);
    expect(await checkBaseRateNotifications(orgId, NOW)).toBe(0);
    expect(await count(orgId)).toBe(1);
    const n = await dbInternal.notification.findFirstOrThrow({ where: { orgId, type: "BASE_RATE_MISSING" }, select: { title: true, body: true, dedupeKey: true, link: true } });
    expect(n.title).toBe("Basiszinssatz für 1. Halbjahr 2310 fehlt");
    expect(n.dedupeKey).toBe("BASE_RATE_MISSING:2310-H1");
    expect(n.body).toContain("2,50 %");
    expect(n.link).toBe("/einstellungen/mahnwesen");
  });

  it("ohne zinsrechnende Stufe keine Meldung", async () => {
    const orgId = await mkOrg(false);
    expect(await checkBaseRateNotifications(orgId, NOW)).toBe(0);
    expect(await count(orgId)).toBe(0);
  });

  it("deaktivierte zinsrechnende Stufe -> keine Meldung", async () => {
    const orgId = await mkOrg(true, false);
    expect(await checkBaseRateNotifications(orgId, NOW)).toBe(0);
    expect(await count(orgId)).toBe(0);
  });

  it("nach Nachtragen des Satzes keine neue Meldung", async () => {
    const orgId = await mkOrg(true);
    await upsertBaseRate(orgId, { validFrom: "2310-01-01", rateBp: 300 });
    expect(await checkBaseRateNotifications(orgId, NOW)).toBe(0);
    expect(await count(orgId)).toBe(0);
  });

  it("Pflicht-Typ wird auch bei enabledTypes = [] vom Job angelegt", async () => {
    const orgId = await mkOrg(true);
    await saveNotificationSettings(orgId, { enabledTypes: [], emailDigest: false });
    const res = await runNotificationsJob(NOW, { orgId });
    expect(res.errors).toEqual([]);
    expect(res.byType.BASE_RATE_MISSING).toBe(1);
    expect(await count(orgId)).toBe(1);
  });
});
