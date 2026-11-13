/**
 * Task 6 (17b) — Abgleich haengengebliebener QUEUED-EmailLogs
 * (src/domain/email/email-log.ts#reconcileStaleQueuedEmails). Kein Rechnungsbezug,
 * daher kein eigenes Testjahr; "jetzt" liegt in 2148, die Zeilen werden zurueckdatiert.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { createQueuedEmailLog, reconcileStaleQueuedEmails, QUEUED_RECONCILE_ERROR, QUEUED_STALE_MS } from "@/domain/email/email-log";
import { verifyOrgChain } from "@/domain/audit/verify-chain";

const NOW = new Date("2148-03-10T10:00:00.000Z");
const OLD = new Date(NOW.getTime() - QUEUED_STALE_MS - 60_000);
const FRESH = new Date(NOW.getTime() - QUEUED_STALE_MS + 60_000);

async function makeOrg(name: string): Promise<string> {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Weg 1", postalCode: "10117", city: "Berlin", vatId: "DE444444444", taxNumber: "44/444/44444" },
  });
  return org.id;
}

async function makeLog(orgId: string, createdAt: Date, status: "QUEUED" | "SENT" | "FAILED" = "QUEUED"): Promise<string> {
  const log = await createQueuedEmailLog({
    orgId,
    docType: "INVOICE",
    docId: "doc-1",
    fromEmail: "absender@example.com",
    to: ["kunde@example.com"],
    cc: [],
    bcc: [],
    subject: "Ihre Rechnung",
    bodySnapshot: "Text",
    sentByUserId: "u1",
  });
  await dbInternal.emailLog.update({ where: { id: log.id }, data: { createdAt, status } });
  return log.id;
}

async function changeLogs(orgId: string, entityId: string) {
  return dbInternal.changeLog.findMany({ where: { orgId, entity: "EMAIL", entityId }, select: { action: true, actor: true, diffJson: true } });
}

let orgId: string;
beforeAll(async () => {
  orgId = await makeOrg("Mail-Abgleich Test GmbH");
  // Fremd-QUEUED aelter als die Schwelle (andere Testdateien) nicht in die Zaehlung einmischen:
  await dbInternal.emailLog.updateMany({ where: { status: "QUEUED", orgId: { not: orgId } }, data: { createdAt: new Date(NOW.getTime() + 86_400_000) } });
});

afterEach(() => vi.restoreAllMocks());

describe("reconcileStaleQueuedEmails", () => {
  it("setzt alte QUEUED auf FAILED mit ChangeLog, Outbox-Eintrag und gruener Kette; laesst Junge/SENT/FAILED unberuehrt; zweiter Lauf 0", async () => {
    const endpoint = await dbInternal.webhookEndpoint.create({
      data: { orgId, url: "https://93.184.216.50/hook", secretEnc: "v1:x:x:x", eventsJson: '["email.failed"]' },
    });
    const stale = await makeLog(orgId, OLD);
    const fresh = await makeLog(orgId, FRESH);
    const sent = await makeLog(orgId, OLD, "SENT");
    const failed = await makeLog(orgId, OLD, "FAILED");

    expect(await reconcileStaleQueuedEmails(NOW)).toBe(1);

    const row = await dbInternal.emailLog.findUniqueOrThrow({ where: { id: stale } });
    expect(row.status).toBe("FAILED");
    expect(row.error).toBe(QUEUED_RECONCILE_ERROR);
    expect(row.sentAt).toBeNull();
    for (const [id, st] of [[fresh, "QUEUED"], [sent, "SENT"], [failed, "FAILED"]] as const) {
      expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id } })).status).toBe(st);
      expect(await changeLogs(orgId, id)).toHaveLength(0);
    }

    const logs = await changeLogs(orgId, stale);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe("FAILED");
    expect(logs[0]!.actor).toBe("scheduler");
    const diff = JSON.stringify(JSON.parse(logs[0]!.diffJson));
    expect(diff).toContain("kunde@example.com");
    expect(diff).toContain("Ihre Rechnung");
    expect(diff).toContain(QUEUED_RECONCILE_ERROR);

    const outbox = await dbInternal.webhookDelivery.findMany({ where: { orgId, endpointId: endpoint.id, event: "email.failed", objectId: stale } });
    expect(outbox).toHaveLength(1);

    expect((await verifyOrgChain(orgId, "UI")).valid).toBe(true);

    expect(await reconcileStaleQueuedEmails(NOW)).toBe(0);
    expect(await changeLogs(orgId, stale)).toHaveLength(1);
  });

  it("Zeile wird zwischen Auswahl und Update SENT -> bleibt SENT, kein ChangeLog", async () => {
    const id = await makeLog(orgId, OLD);
    // Auswahl simulieren: findMany einmal ausfuehren lassen, dann vor dem Update auf SENT setzen.
    const original = dbInternal.emailLog.findMany.bind(dbInternal.emailLog);
    const spy2 = vi.spyOn(dbInternal.emailLog, "findMany").mockImplementationOnce((async (args: Parameters<typeof original>[0]) => {
      const rows = await original(args);
      await dbInternal.emailLog.update({ where: { id }, data: { status: "SENT", sentAt: NOW } });
      return rows;
    }) as never);

    await reconcileStaleQueuedEmails(NOW);
    expect(spy2).toHaveBeenCalled();
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id } })).status).toBe("SENT");
    expect(await changeLogs(orgId, id)).toHaveLength(0);
  });

  it("zwei Organisationen -> je Org eigene Kette, beide abgeglichen", async () => {
    const orgB = await makeOrg("Mail-Abgleich B GmbH");
    const a = await makeLog(orgId, OLD);
    const b = await makeLog(orgB, OLD);
    expect(await reconcileStaleQueuedEmails(NOW)).toBe(2);
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id: a } })).status).toBe("FAILED");
    expect((await dbInternal.emailLog.findUniqueOrThrow({ where: { id: b } })).status).toBe("FAILED");
    expect((await verifyOrgChain(orgId, "UI")).valid).toBe(true);
    expect((await verifyOrgChain(orgB, "UI")).valid).toBe(true);
  });
});
