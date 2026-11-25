/**
 * Fortsetzen pausierter Abos mit Rückstand (22b T6): Auswahl SKIP/BILL ist Pflicht, sonst 409
 * (MISSED_PERIODS_REQUIRED); Umsetzung über resumePausedRecurringWithinTx. Eigenes Jahr 2262.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring, RecurringError } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { RecurringMissedPeriodsError } from "@/domain/recurring/errors";
import { InvalidOperationError } from "@/domain/errors";
import { resumePausedRecurringWithinTx } from "@/domain/recurring/resume";
import { runDueRecurring } from "@/domain/recurring/run";
import { recordUsage } from "@/domain/recurring/usage";
import { mapApiError } from "@/api/errors";
import { createRecurringSchema, updateRecurringSchema, type CreateRecurringInput } from "@/schemas";

const D = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`);
const key = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

let orgId: string;
let customerId: string;

const fixedLine = { lineType: "ITEM", description: "Hosting", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const usageLine = { ...fixedLine, description: "API-Aufrufe", quantityMilli: 0, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, billing: "USAGE", usageUnitLabel: "Aufrufe" };

function input(extra: Record<string, unknown> = {}): CreateRecurringInput {
  return createRecurringSchema.parse({ customerId, title: "Abo", startDate: D("2262-01-15"), interval: "MONTHLY", lines: [fixedLine], ...extra });
}

async function pausedAbo(extra: Record<string, unknown> = {}): Promise<string> {
  const rec = await createRecurring(orgId, input(extra));
  await updateRecurringInvoice(orgId, rec.id, { status: "PAUSED" });
  return rec.id;
}

const state = (id: string) => dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id }, select: { status: true, nextRunDate: true, issuedCount: true } });

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Fortsetzen GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Fortsetzenkunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" } })).id;
});

describe("Fortsetzen mit Rückstand", () => {
  it("ohne Angabe: 409 mit Anzahl, Status bleibt PAUSED", async () => {
    const id = await pausedAbo();
    const err = await updateRecurringInvoice(orgId, id, { status: "ACTIVE" }, "t", { now: D("2262-04-10") }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecurringMissedPeriodsError);
    if (!(err instanceof RecurringMissedPeriodsError)) throw new Error("falscher Fehler");
    expect(err.missedCount).toBe(3);
    const mapped = mapApiError(err);
    expect(mapped.status).toBe(409);
    expect(JSON.stringify(mapped.body)).toContain("MISSED_PERIODS_REQUIRED");
    expect((await state(id)).status).toBe("PAUSED");
  });

  it("SKIP: nächster Stichtag ab heute, 3 Zeiträume übersprungen, keine Rechnung, Protokoll", async () => {
    const id = await pausedAbo();
    await updateRecurringInvoice(orgId, id, { status: "ACTIVE", missedPeriods: "SKIP" }, "t", { now: D("2262-04-10") });
    const s = await state(id);
    expect(s.status).toBe("ACTIVE");
    expect(key(s.nextRunDate)).toBe("2262-04-15");
    expect(s.issuedCount).toBe(0);
    expect(await dbInternal.invoice.count({ where: { orgId, recurringInvoiceId: id } })).toBe(0);
    const log = await dbInternal.activityLog.findFirst({ where: { orgId, entityId: id, type: "RECURRING_RESUMED_BY_RULE" }, select: { dataJson: true } });
    expect(log?.dataJson).toContain('"skipped":3');
  });

  it("BILL: ACTIVE, nächster Lauf erzeugt 3 Rechnungen mit lückenlosen Zeiträumen", async () => {
    const id = await pausedAbo();
    await updateRecurringInvoice(orgId, id, { status: "ACTIVE", missedPeriods: "BILL" }, "t", { now: D("2262-04-10") });
    expect(key((await state(id)).nextRunDate)).toBe("2262-01-15");
    await runDueRecurring({ now: D("2262-04-10"), orgId });
    const invoices = await dbInternal.invoice.findMany({
      where: { orgId, recurringInvoiceId: id },
      orderBy: { deliveryStart: "asc" },
      select: { deliveryStart: true, deliveryEnd: true },
    });
    expect(invoices.map((i) => `${key(i.deliveryStart)}..${key(i.deliveryEnd)}`)).toEqual([
      "2262-01-15..2262-02-14",
      "2262-02-15..2262-03-14",
      "2262-03-15..2262-04-14",
    ]);
  });

  it("ohne Rückstand gelingt das Fortsetzen ohne Angabe", async () => {
    const id = await pausedAbo();
    await updateRecurringInvoice(orgId, id, { status: "ACTIVE" }, "t", { now: D("2262-01-10") });
    const s = await state(id);
    expect(s.status).toBe("ACTIVE");
    expect(key(s.nextRunDate)).toBe("2262-01-15");
  });

  it("SKIP mit offenem Verbrauch im Bedienerpfad: abgelehnt (409), Status bleibt PAUSED, nichts verändert", async () => {
    const rec = await createRecurring(orgId, input({ billingTiming: "ARREARS", startDate: D("2262-01-01"), lines: [fixedLine, usageLine] }));
    const full = await dbInternal.recurringInvoiceLine.findFirstOrThrow({ where: { recurringInvoiceId: rec.id, billing: "USAGE" }, select: { id: true } });
    await recordUsage(orgId, rec.id, { recurringLineId: full.id, quantityMilli: 5000, usageDate: "2262-01-10" }, { source: "API", actor: "t", now: D("2262-01-20") });
    await updateRecurringInvoice(orgId, rec.id, { status: "PAUSED" });
    const before = await state(rec.id);
    const err = await updateRecurringInvoice(orgId, rec.id, { status: "ACTIVE", missedPeriods: "SKIP" }, "t", { now: D("2262-04-10") }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidOperationError);
    expect(mapApiError(err).status).toBe(409);
    expect(String((err as Error).message)).toContain("Offener Verbrauch");
    const after = await state(rec.id);
    expect(after.status).toBe("PAUSED");
    expect(key(after.nextRunDate)).toBe(key(before.nextRunDate));
    // BILL bleibt möglich.
    await updateRecurringInvoice(orgId, rec.id, { status: "ACTIVE", missedPeriods: "BILL" }, "t", { now: D("2262-04-10") });
    expect((await state(rec.id)).status).toBe("ACTIVE");
  });

  it("Regel-Pfad (nicht strikt): SKIP mit offenem Verbrauch fällt auf Abrechnen zurück", async () => {
    const rec = await createRecurring(orgId, input({ billingTiming: "ARREARS", startDate: D("2262-01-01"), lines: [fixedLine, usageLine] }));
    const full = await dbInternal.recurringInvoiceLine.findFirstOrThrow({ where: { recurringInvoiceId: rec.id, billing: "USAGE" }, select: { id: true } });
    await recordUsage(orgId, rec.id, { recurringLineId: full.id, quantityMilli: 5000, usageDate: "2262-01-10" }, { source: "API", actor: "t", now: D("2262-01-20") });
    await updateRecurringInvoice(orgId, rec.id, { status: "PAUSED" });
    const res = await dbInternal.$transaction((tx) =>
      resumePausedRecurringWithinTx(tx, orgId, rec.id, { missedPeriods: "SKIP", now: D("2262-04-10"), actor: "regel" }),
    );
    expect(res.resumed).toBe(true);
    expect(key((await state(rec.id)).nextRunDate)).toBe("2262-01-31");
  });

  it("Enddatum im übersprungenen Zeitraum: SKIP lehnt ab, Status bleibt PAUSED (Rollback)", async () => {
    const id = await pausedAbo({ endDate: D("2262-02-20") });
    await expect(updateRecurringInvoice(orgId, id, { status: "ACTIVE", missedPeriods: "SKIP" }, "t", { now: D("2262-04-10") })).rejects.toThrow(RecurringError);
    const s = await state(id);
    expect(s.status).toBe("PAUSED");
    expect(key(s.nextRunDate)).toBe("2262-01-15");
  });

  it("Fortsetzen mit Rückstand und Startdatum/Intervall im selben Patch: abgelehnt, Status bleibt PAUSED", async () => {
    const id = await pausedAbo();
    for (const extra of [{ startDate: D("2262-03-01") }, { interval: "WEEKLY" }, { intervalCount: 2 }]) {
      const err = await updateRecurringInvoice(orgId, id, { status: "ACTIVE", missedPeriods: "SKIP", ...extra }, "t", { now: D("2262-04-10") }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(InvalidOperationError);
      const s = await state(id);
      expect(s.status).toBe("PAUSED");
      expect(key(s.nextRunDate)).toBe("2262-01-15");
    }
  });

  it("BILL mit Auto-Festschreiben: je versäumtem Zeitraum eine festgeschriebene Rechnung", async () => {
    const id = await pausedAbo({ autoFinalize: true });
    await updateRecurringInvoice(orgId, id, { status: "ACTIVE", missedPeriods: "BILL" }, "t", { now: D("2262-04-10") });
    await runDueRecurring({ now: D("2262-04-10"), orgId });
    const invoices = await dbInternal.invoice.findMany({ where: { orgId, recurringInvoiceId: id }, select: { status: true, number: true } });
    expect(invoices).toHaveLength(3);
    expect(invoices.every((i) => i.status !== "DRAFT" && i.number !== null)).toBe(true);
  });

  it("Schema: missedPeriods nur SKIP oder BILL", () => {
    expect(updateRecurringSchema.safeParse({ status: "ACTIVE", missedPeriods: "ALL" }).success).toBe(false);
    expect(updateRecurringSchema.safeParse({ status: "ACTIVE", missedPeriods: "BILL" }).success).toBe(true);
  });
});
