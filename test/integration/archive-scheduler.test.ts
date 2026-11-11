/** Phase 16a, Task 5 — Nachlauf des Belegarchivs im Scheduler. Testjahr 2014. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Beleg-IDs, deren Archivierung dauerhaft fehlschlaegt (simulierter Render-/Ablagefehler).
const failingIds = vi.hoisted(() => new Set<string>());
vi.mock("@/domain/invoice/archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/invoice/archive")>();
  return {
    ...actual,
    ensureInvoiceArchive: (...args: Parameters<typeof actual.ensureInvoiceArchive>) => {
      if (failingIds.has(args[1])) return Promise.reject(new Error("simulierter Archivfehler"));
      return actual.ensureInvoiceArchive(...args);
    },
  };
});
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { ARCHIVE_BATCH, runArchiveJob } from "@/domain/scheduler/archive-job";
import { onArchiveFailed } from "@/domain/notifications/hooks";
import { runScheduledJobs } from "@/domain/scheduler/runner";
import type { CreateInvoiceInput } from "@/schemas";

let orgId: string;
let customerId: string;
let tmpDir: string;
let prevEnv: string | undefined;
const FIX_DATE = new Date("2014-03-01T10:00:00.000Z");
const NOW = new Date("2014-03-02T02:00:00.000Z");

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-archive-sched-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (
    await dbInternal.organization.create({
      data: { legalName: "Nachlauf GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    })
  ).id;
  customerId = (
    await dbInternal.customer.create({ data: { orgId, name: "Nachlauf-Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })
  ).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await updateNumberRange(orgId, "INVOICE", { pattern: "{PREFIX}{SEQ}", prefix: "AS14-RE-", seqPadding: 4, yearlyReset: false, nextValue: 1 }, "test");
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function input(): CreateInvoiceInput {
  return {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX_DATE, deliveryDate: new Date("2014-02-25"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
}
const draft = async () => (await createDraftInvoice(orgId, input(), { now: FIX_DATE })).id;
// Quelle SCHEDULER gilt nur fuer Belege NACH der archive-epoch (sonst BACKFILL). Die Epoche
// liegt migrationsbedingt nach 2014 und wird von invoice-archive.test.ts zeitweise verschoben —
// daher wird finalizedAt hier testintern auf ein Datum weit nach der Epoche gesetzt.
const AFTER_EPOCH = new Date("2098-01-01T00:00:00.000Z");
const finalized = async (finalizedAt: Date = AFTER_EPOCH) => {
  const id = (await finalizeInvoice(await draft(), { now: FIX_DATE })).id;
  await dbInternal.invoice.update({ where: { id }, data: { finalizedAt }, select: { id: true } });
  return id;
};
/** Nachlauf leeren (Altlasten anderer Testdateien), mit Obergrenze gegen Endlosschleifen. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) if ((await runArchiveJob(NOW)).archived === 0) return;
  throw new Error("Nachlauf wird nicht leer");
}
const archivedCount = (ids: string[]) => dbInternal.archivedDocument.count({ where: { invoiceId: { in: ids }, kind: "PDF" } });

describe("runArchiveJob", () => {
  it("archiviert festgeschriebene Rechnungen mit Quelle SCHEDULER, Entwuerfe nicht; zweiter Lauf archiviert nichts", async () => {
    // Erst die Altlasten anderer Testdateien nachholen, damit die Zaehlung exakt ist.
    await drain();
    const ids = [await finalized(), await finalized(), await finalized()];
    const d = await draft();
    const result = await runArchiveJob(NOW);
    expect(result).toEqual({ archived: 3, failed: 0 });
    expect(await archivedCount(ids)).toBe(3);
    expect(await dbInternal.archivedDocument.count({ where: { invoiceId: d } })).toBe(0);
    const sources = await dbInternal.archivedDocument.findMany({ where: { invoiceId: { in: ids } }, select: { source: true } });
    expect(new Set(sources.map((s) => s.source))).toEqual(new Set(["SCHEDULER"]));
    expect(await runArchiveJob(NOW)).toEqual({ archived: 0, failed: 0 });
  });

  it("Limit: batch 2 bei 3 offenen Belegen archiviert 2, Default-Batch ist 50", async () => {
    await drain();
    const ids = [await finalized(), await finalized(), await finalized()];
    expect(ARCHIVE_BATCH).toBe(50);
    expect((await runArchiveJob(NOW, { batch: 2 })).archived).toBe(2);
    expect(await archivedCount(ids)).toBe(2);
    expect((await runArchiveJob(NOW, { batch: 2 })).archived).toBe(1);
  });

  it("dauerhaft fehlschlagender Beleg vor gueltigen blockiert den Lauf nicht; ARCHIVE_FAILED je Beleg und Tag nur einmal", async () => {
    await drain();
    const bad = await finalized(new Date("2097-01-01T00:00:00.000Z")); // aeltester -> steht ganz vorn
    failingIds.add(bad);
    try {
      const good = [await finalized(), await finalized()];
      expect(await runArchiveJob(NOW, { batch: 2 })).toEqual({ archived: 2, failed: 1 });
      expect(await archivedCount(good)).toBe(2);
      expect(await archivedCount([bad])).toBe(0);
      // zweiter Lauf: der fehlerhafte Beleg wird erneut versucht, blockiert aber nichts
      expect(await runArchiveJob(NOW, { batch: 2 })).toEqual({ archived: 0, failed: 1 });
    } finally {
      failingIds.delete(bad);
    }
    // Alarm-Dedupe: derselbe Beleg am selben Tag erzeugt genau eine Benachrichtigung
    await onArchiveFailed(orgId, { invoiceId: bad, message: "x", at: NOW });
    await onArchiveFailed(orgId, { invoiceId: bad, message: "x", at: NOW });
    expect(await dbInternal.notification.count({ where: { orgId, type: "ARCHIVE_FAILED", entityId: bad } })).toBe(1);
  });

  it("laeuft als Scheduler-Job 'archive' im Runner", async () => {
    const results = await runScheduledJobs({ jobs: ["archive"], trigger: "MANUAL", now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ job: "archive", ok: true });
  });
});
