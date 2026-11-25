/**
 * Fix-Welle 22b-F4: Bestandsabo ohne Doppelabrechnung nach dem Klemmen, letzter Zeitraum auch bei
 * Sammelrechnungen, Audit-Typ beim Fortsetzen durch den Bediener, Endspalten im Prüfer-Export.
 * Eigenes Jahr 2265/2266, eigene Organisation.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { RecurringTimingChangeError } from "@/domain/recurring/errors";
import { emitRecurringNow, isSkipped } from "@/domain/recurring/run";
import { buildAuditExportFile } from "@/domain/audit/export";
import { createRecurringSchema } from "@/schemas";
import { createBestandRecurring } from "../helpers/recurring-bestand";

const D = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`);
const key = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let orgId: string;
let customerId: string;
const item = (description: string) => ({ lineType: "ITEM", description, quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 });

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Fixwelle GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Fixwellenkunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" } })).id;
});

describe("S1: Bestandsabo am 31. (ohne Ankertag)", () => {
  it("zweite Rechnung beginnt am Tag nach dem Ende der ersten (keine Doppelung 29.–31.)", async () => {
    const rec = await createBestandRecurring(
      orgId,
      createRecurringSchema.parse({ customerId, title: "Bestand 31.", startDate: D("2265-01-31"), interval: "MONTHLY", lines: [item("Wartung")], autoFinalize: true }),
    );
    const first = await emitRecurringNow(rec.id, { now: D("2265-01-31") });
    const second = await emitRecurringNow(rec.id, { now: D("2265-02-28") });
    expect(isSkipped(first) || isSkipped(second)).toBe(false);
    const invoices = await dbInternal.invoice.findMany({ where: { orgId, recurringInvoiceId: rec.id }, orderBy: { deliveryStart: "asc" }, select: { deliveryStart: true, deliveryEnd: true } });
    expect(invoices.map((i) => `${key(i.deliveryStart)}..${key(i.deliveryEnd)}`)).toEqual(["2265-01-01..2265-01-31", "2265-02-01..2265-02-28"]);
  });
});

describe("S2: Wechsel der Abrechnungsart bei Sammelrechnungen", () => {
  it("der Dialog nennt den letzten Zeitraum der Sammelrechnung", async () => {
    const mk = (title: string) =>
      createRecurring(orgId, createRecurringSchema.parse({ customerId, title, startDate: D("2265-05-10"), interval: "MONTHLY", lines: [item(title)], autoFinalize: true, collectiveBilling: true, invoiceHeading: `Block ${title}` }));
    const a = await mk("Sammel A");
    await mk("Sammel B");
    const out = await emitRecurringNow(a.id, { now: D("2265-05-10") });
    expect(isSkipped(out)).toBe(false);
    // Sammelrechnungen setzen das Herkunftsfeld am Beleg nicht.
    expect(await dbInternal.invoice.count({ where: { orgId, recurringInvoiceId: a.id } })).toBe(0);
    const err = await updateRecurringInvoice(orgId, a.id, { billingTiming: "ARREARS" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RecurringTimingChangeError);
    if (!(err instanceof RecurringTimingChangeError)) throw new Error("falscher Fehler");
    expect(err.details.lastBilled && `${key(err.details.lastBilled.start)}..${key(err.details.lastBilled.end)}`).toBe("2265-05-10..2265-06-09");
  });
});

describe("S3: Audit-Typ beim Fortsetzen", () => {
  it("Bediener: RECURRING_RESUMED, nicht der Regel-Typ", async () => {
    const rec = await createRecurring(orgId, createRecurringSchema.parse({ customerId, title: "Pause", startDate: D("2265-08-15"), interval: "MONTHLY", lines: [item("Pause")] }));
    await updateRecurringInvoice(orgId, rec.id, { status: "PAUSED" });
    await updateRecurringInvoice(orgId, rec.id, { status: "ACTIVE", missedPeriods: "SKIP" }, "t", { now: D("2265-09-20") });
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: rec.id, type: "RECURRING_RESUMED" } })).toBe(1);
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: rec.id, type: "RECURRING_RESUMED_BY_RULE" } })).toBe(0);
  });
});

describe("S7: Prüfer-Export trägt den Leistungszeitraum", () => {
  it.skipIf(!hasUnzip)("rechnungen.csv: Endspalten leistung_von/leistung_bis", async () => {
    const { path: file } = await buildAuditExportFile(orgId, { from: new Date("2265-01-01"), to: new Date("2265-12-31") });
    try {
      const csv = execFileSync("unzip", ["-p", file, "rechnungen.csv"]).toString("utf8");
      const rows = csv.split("\r\n").filter(Boolean).map((l) => l.split(";"));
      const header = rows[0]!;
      expect(header.slice(-2)).toEqual(["leistung_von", "leistung_bis"]);
      expect(header[header.indexOf("lieferdatum")]).toBe("lieferdatum");
      const abo = rows.find((r) => r[header.indexOf("leistung_von")] === "01.01.2265");
      expect(abo?.[header.indexOf("leistung_bis")]).toBe("31.01.2265");
      expect(abo?.[header.indexOf("lieferdatum")]).toBe("");
    } finally {
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});
