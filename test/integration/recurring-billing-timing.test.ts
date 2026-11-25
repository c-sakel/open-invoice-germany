/**
 * Abrechnungsart je Abo (22b T2): Anlage (Standard, Verbrauch, Anker, Leistungsbeginn), Änderung (Wechsel mit
 * Bestätigung, Neuberechnung vor dem ersten Lauf), Bestandszeile. Eigenes Jahr 2260, eigene Organisation.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring, RecurringError } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { RecurringTimingChangeError } from "@/domain/recurring/errors";
import { emitRecurringNow, isSkipped } from "@/domain/recurring/run";
import { mapApiError } from "@/api/errors";
import { createRecurringSchema, updateRecurringSchema, type CreateRecurringInput } from "@/schemas";

const D = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`);
const day = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let orgId: string;
let customerId: string;

const fixedLine = { lineType: "ITEM", description: "Hosting", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const usageLine = { ...fixedLine, description: "API-Aufrufe", quantityMilli: 0, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, billing: "USAGE", usageUnitLabel: "Aufrufe" };

function input(extra: Record<string, unknown> = {}): CreateRecurringInput {
  return createRecurringSchema.parse({ customerId, title: "Abo", startDate: D("2260-03-25"), interval: "YEARLY", lines: [fixedLine], autoFinalize: true, ...extra });
}

async function message(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (e instanceof RecurringError ? e.message : e instanceof Error ? `OTHER:${e.message}` : "OTHER"),
  );
}

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Zeitraum GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Zeitraumkunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" } })).id;
});

describe("Anlage", () => {
  it("ohne Angabe und ohne Verbrauch: ADVANCE, Anker = Starttag, nextRunDate = Start", async () => {
    const rec = await createRecurring(orgId, input());
    expect(rec.billingTiming).toBe("ADVANCE");
    expect(rec.anchorDay).toBe(25);
    expect(day(rec.nextRunDate)).toBe("2260-03-25");
  });

  it("ohne Angabe mit Verbrauch: ARREARS; ausdrücklich ADVANCE mit Verbrauch: abgelehnt", async () => {
    const rec = await createRecurring(orgId, input({ interval: "MONTHLY", lines: [fixedLine, usageLine] }));
    expect(rec.billingTiming).toBe("ARREARS");
    const msg = await message(createRecurring(orgId, input({ billingTiming: "ADVANCE", lines: [fixedLine, usageLine] })));
    expect(msg).toContain("Verbrauchspositionen werden nachträglich abgerechnet");
  });

  it("ARREARS: Start 01.01. monatlich -> Stichtag 31.01., Anker 31; Start 30.01. abgelehnt", async () => {
    const rec = await createRecurring(orgId, input({ billingTiming: "ARREARS", interval: "MONTHLY", startDate: D("2260-01-01") }));
    expect(day(rec.nextRunDate)).toBe("2260-01-31");
    expect(rec.anchorDay).toBe(31);
    const msg = await message(createRecurring(orgId, input({ billingTiming: "ARREARS", interval: "MONTHLY", startDate: D("2260-01-30") })));
    expect(msg).toContain("1.–28.");
  });

  it("abweichender Ankertag wird abgelehnt, passender akzeptiert", async () => {
    expect(await message(createRecurring(orgId, input({ anchorDay: 3 })))).toBe("Ankertag muss dem Tag des ersten Stichtags entsprechen.");
    const ok = await createRecurring(orgId, input({ anchorDay: 25 }));
    expect(ok.anchorDay).toBe(25);
  });
});

describe("Änderung", () => {
  it("Wechsel nach einem Lauf ohne Bestätigung: 409-Fehler mit Lücke; mit Bestätigung gespeichert, nextRunDate unverändert", async () => {
    const rec = await createRecurring(orgId, input({ billingTiming: "ARREARS", interval: "YEARLY", startDate: D("2260-01-01") }));
    // ARREARS jährlich ab 01.01.2260: erster Stichtag 31.12.2260
    const run = await emitRecurringNow(rec.id, { now: D("2260-12-31") });
    expect(isSkipped(run)).toBe(false);
    const before = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id }, select: { nextRunDate: true } });

    const err = await updateRecurringInvoice(orgId, rec.id, { billingTiming: "ADVANCE" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecurringTimingChangeError);
    if (!(err instanceof RecurringTimingChangeError)) throw new Error("falscher Fehler");
    expect(err.details.gapDays).toBeGreaterThan(0);
    expect(mapApiError(err).status).toBe(409);
    const unchanged = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id }, select: { billingTiming: true } });
    expect(unchanged.billingTiming).toBe("ARREARS");

    const done = await updateRecurringInvoice(orgId, rec.id, { billingTiming: "ADVANCE", acknowledgeTimingChange: true });
    expect(done.billingTiming).toBe("ADVANCE");
    expect(done.nextRunDate.getTime()).toBe(before.nextRunDate.getTime());
  });

  it("startDate vor dem ersten Lauf (ARREARS): nextRunDate = neuer erster Stichtag", async () => {
    const rec = await createRecurring(orgId, input({ billingTiming: "ARREARS", interval: "MONTHLY", startDate: D("2260-05-01") }));
    const up = await updateRecurringInvoice(orgId, rec.id, { startDate: D("2260-06-15") });
    expect(day(up.nextRunDate)).toBe("2260-07-14");
    expect(up.anchorDay).toBe(14);
    expect(await message(updateRecurringInvoice(orgId, rec.id, { startDate: D("2260-06-30") }))).toContain("1.–28.");
  });

  it("Wechsel vor dem ersten Lauf berechnet Stichtag und Anker neu; ADVANCE mit Verbrauchszeile abgelehnt", async () => {
    const rec = await createRecurring(orgId, input({ billingTiming: "ARREARS", interval: "MONTHLY", startDate: D("2260-08-01") }));
    const up = await updateRecurringInvoice(orgId, rec.id, { billingTiming: "ADVANCE" });
    expect(day(up.nextRunDate)).toBe("2260-08-01");
    expect(up.anchorDay).toBe(1);
    const usage = await createRecurring(orgId, input({ interval: "MONTHLY", lines: [fixedLine, usageLine] }));
    expect(await message(updateRecurringInvoice(orgId, usage.id, { billingTiming: "ADVANCE" }))).toContain("Verbrauchspositionen");
  });
});

describe("Bestand", () => {
  it("Zeile ohne billingTiming liest ARREARS, Anker bleibt null", async () => {
    const row = await dbInternal.recurringInvoice.create({
      data: { orgId, customerId, title: "Bestand", startDate: D("2260-01-31"), nextRunDate: D("2260-02-28") },
      select: { billingTiming: true, anchorDay: true },
    });
    expect(row).toEqual({ billingTiming: "ARREARS", anchorDay: null });
  });

  it("Schema: billingTiming nur ADVANCE/ARREARS, anchorDay bis 31", () => {
    expect(updateRecurringSchema.safeParse({ billingTiming: "SOMETIME" }).success).toBe(false);
    expect(updateRecurringSchema.safeParse({ anchorDay: 31 }).success).toBe(true);
    expect(updateRecurringSchema.safeParse({ anchorDay: 32 }).success).toBe(false);
  });
});
