/**
 * Phase 18f, Task 5: Verbrauch je Abrechnungszeitraum — erfassen, stornieren, im Lauf abrechnen,
 * Abo-Zeilen-Sync, Abo loeschen, Laufrate. Eigenes Jahr 2187 (Invoice.number global eindeutig),
 * eigene Organisation, kein Netz.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring, RecurringError } from "@/domain/recurring/create";
import { updateRecurringInvoice } from "@/domain/recurring/update";
import { deleteRecurringInvoice } from "@/domain/recurring/delete";
import { emitRecurringNow, runDueRecurring, isSkipped } from "@/domain/recurring/run";
import { recordUsage, voidUsage, listUsage, markUsageBilled, UsageError } from "@/domain/recurring/usage";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { recurringRunRate } from "@/domain/reporting/recurring-run-rate";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { createRecurringSchema, type CreateRecurringInput } from "@/schemas";

const START = new Date("2187-03-31T10:00:00.000Z");
const D = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`);
const NOW = D("2187-03-25");
const RUN = D("2187-03-31");

let orgId: string;
let customerId: string;
let otherOrgId: string;

const fixedLine = { lineType: "ITEM", description: "Grundgebühr", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const usageLine = {
  lineType: "ITEM",
  description: "API-Aufrufe",
  quantityMilli: 0,
  unitNetPriceCents: 0,
  unitNetPriceMilliCents: 200,
  taxRate: 19,
  taxCategory: "S",
  discountPermille: 0,
  discountCents: 0,
  billing: "USAGE",
  usageUnitLabel: "Aufrufe",
};

function input(extra: Record<string, unknown> = {}): CreateRecurringInput {
  return createRecurringSchema.parse({ customerId, title: "Verbrauchsabo", startDate: START, lines: [fixedLine, usageLine], autoFinalize: true, ...extra });
}

async function makeAbo(extra: Record<string, unknown> = {}) {
  const rec = await createRecurring(orgId, input(extra));
  const usageLineId = rec.lines.find((l) => l.billing === "USAGE")?.id;
  if (!usageLineId) throw new Error("USAGE-Zeile fehlt");
  const fixedLineId = rec.lines.find((l) => l.billing === "FIXED")?.id ?? "";
  return { rec, usageLineId, fixedLineId };
}

async function emitted(recurringId: string, now = RUN) {
  const out = await emitRecurringNow(recurringId, { now });
  if (isSkipped(out)) throw new Error("uebersprungen");
  return out;
}

function code(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (e instanceof UsageError ? e.code : e instanceof Error ? e.message : "OTHER"),
  );
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Verbrauch GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (
    await dbInternal.customer.create({
      data: { orgId, name: "Verbrauchskunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" },
    })
  ).id;
  otherOrgId = (await dbInternal.organization.create({ data: { legalName: "Fremd GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" } })).id;
});

describe("Verbrauch erfassen", () => {
  it("summiert, ist idempotent per externalId und lehnt Fehlbedienung ab", async () => {
    const { rec, usageLineId, fixedLineId } = await makeAbo();
    const a = await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 6_000_000, usageDate: "2187-03-10" }, { source: "API", actor: "t", now: NOW });
    expect(a.replayed).toBe(false);
    expect(a.usage).toMatchObject({ status: "open", quantityMilli: 6_000_000, source: "API", invoiceId: null });
    expect(a.usage.periodEnd.getTime()).toBe(rec.nextRunDate.getTime());

    const ev = { recurringLineId: usageLineId, quantityMilli: 4_000_000, usageDate: "2187-03-20", externalId: "ev-1" };
    const first = await recordUsage(orgId, rec.id, ev, { source: "API", actor: "t", now: NOW });
    const again = await recordUsage(orgId, rec.id, ev, { source: "API", actor: "t", now: NOW });
    expect(again.replayed).toBe(true);
    expect(again.usage.id).toBe(first.usage.id);
    expect(await dbInternal.recurringUsage.count({ where: { recurringInvoiceId: rec.id } })).toBe(2);
    expect(await code(recordUsage(orgId, rec.id, { ...ev, quantityMilli: 1 }, { source: "API", actor: "t", now: NOW }))).toBe("CONFLICT");

    expect(await code(recordUsage(orgId, rec.id, { recurringLineId: fixedLineId, quantityMilli: 1 }, { source: "UI", actor: "t", now: NOW }))).toBe("NOT_USAGE_LINE");
    expect(await code(recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1, usageDate: "2187-04-01" }, { source: "UI", actor: "t", now: NOW }))).toBe("IN_FUTURE");
    expect(await code(recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1, usageDate: "2187-02-28" }, { source: "UI", actor: "t", now: NOW }))).toBe("PERIOD_BILLED");

    await dbInternal.recurringInvoice.update({ where: { id: rec.id }, data: { status: "PAUSED" } });
    expect(await code(recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1 }, { source: "UI", actor: "t", now: NOW }))).toBe("NOT_ACTIVE");
    await dbInternal.recurringInvoice.update({ where: { id: rec.id }, data: { status: "ACTIVE" } });

    const log = await dbInternal.activityLog.findMany({ where: { orgId, entityId: rec.id, type: "USAGE_RECORDED" }, select: { dataJson: true } });
    expect(log).toHaveLength(2);
    expect(log.every((l) => !(l.dataJson ?? "").includes("note"))).toBe(true);
  });

  it("fremde Organisation und erfundene Ids -> NOT_FOUND mit gleichem Text", async () => {
    const { rec, usageLineId } = await makeAbo();
    const msgs: string[] = [];
    for (const [org, id, line] of [
      [otherOrgId, rec.id, usageLineId],
      [orgId, "gibt-es-nicht", usageLineId],
      [orgId, rec.id, "falsche-zeile"],
    ] as const) {
      try {
        await recordUsage(org, id, { recurringLineId: line, quantityMilli: 1 }, { source: "UI", actor: "t", now: NOW });
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        expect((e as UsageError).code).toBe("NOT_FOUND");
        msgs.push((e as Error).message);
      }
    }
    expect(msgs).toHaveLength(3);
    expect(new Set(msgs).size).toBe(1);
  });

  it("Storno mit Grund; zweimal und abgerechnet werden abgelehnt", async () => {
    const { rec, usageLineId } = await makeAbo();
    const rec1 = await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1000, usageDate: "2187-03-12" }, { source: "UI", actor: "t", now: NOW });
    const voided = await voidUsage(orgId, rec.id, rec1.usage.id, { reason: "Fehlbuchung" }, { actor: "t", now: NOW });
    expect(voided).toMatchObject({ status: "voided", voidReason: "Fehlbuchung" });
    expect(await code(voidUsage(orgId, rec.id, rec1.usage.id, { reason: "x" }, { actor: "t", now: NOW }))).toBe("ALREADY_VOIDED");
    const rec2 = await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 2000, usageDate: "2187-03-13" }, { source: "UI", actor: "t", now: NOW });
    await emitted(rec.id);
    expect(await code(voidUsage(orgId, rec.id, rec2.usage.id, { reason: "zu spaet" }, { actor: "t", now: NOW }))).toBe("ALREADY_BILLED");
    expect(await code(voidUsage(otherOrgId, rec.id, rec2.usage.id, { reason: "x" }, { actor: "t", now: NOW }))).toBe("NOT_FOUND");
    const list = await listUsage(orgId, rec.id, { status: "all" });
    expect(list.items.map((i) => i.status).sort()).toEqual(["billed", "voided"]);
    expect(list.items.find((i) => i.status === "billed")?.invoiceNumber).not.toBeNull();
  });
});

describe("Lauf mit Verbrauch", () => {
  it("rechnet Summe + Zeitraum ab, markiert Saetze, ChangeLog traegt usageCount, XML 5 Stellen", async () => {
    const { rec, usageLineId } = await makeAbo();
    await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 6_000_000, usageDate: "2187-03-10" }, { source: "API", actor: "t", now: NOW });
    await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 4_000_000, usageDate: "2187-03-20" }, { source: "API", actor: "t", now: NOW });
    const dropped = await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 9_000_000, usageDate: "2187-03-22" }, { source: "API", actor: "t", now: NOW });
    await voidUsage(orgId, rec.id, dropped.usage.id, { reason: "Test" }, { actor: "t", now: NOW });

    const out = await emitted(rec.id);
    const inv = await dbInternal.invoice.findUniqueOrThrow({
      where: { id: out.invoiceId },
      select: {
        netTotalCents: true,
        lines: { orderBy: { position: "asc" }, select: { description: true, quantityMilli: true, lineNetCents: true, unitNetPriceMilliCents: true, servicePeriodStart: true, servicePeriodEnd: true } },
      },
    });
    expect(inv.lines).toHaveLength(2);
    const api = inv.lines[1]!;
    expect(api).toMatchObject({ description: "API-Aufrufe", quantityMilli: 10_000_000, lineNetCents: 2000, unitNetPriceMilliCents: 200 });
    expect(api.servicePeriodStart?.toISOString().slice(0, 10)).toBe("2187-02-28");
    expect(api.servicePeriodEnd?.toISOString().slice(0, 10)).toBe("2187-03-31");
    expect(inv.netTotalCents).toBe(4900);

    const usages = await dbInternal.recurringUsage.findMany({ where: { recurringInvoiceId: rec.id }, select: { invoiceId: true, billedAt: true, voidedAt: true } });
    expect(usages.filter((u) => u.invoiceId === out.invoiceId && u.billedAt)).toHaveLength(2);
    expect(usages.find((u) => u.voidedAt)?.invoiceId).toBeNull();

    const create = await dbInternal.changeLog.findFirstOrThrow({ where: { orgId, entityId: out.invoiceId, action: "CREATE" }, select: { diffJson: true } });
    expect(JSON.parse(create.diffJson ?? "{}")).toMatchObject({ usageCount: 2, usageQuantityMilli: 10_000_000 });
    expect((await verifyOrgChain(orgId, "CLI")).valid).toBe(true);

    const loaded = await loadEInvoiceData(out.invoiceId);
    expect(buildXRechnungUBL(loaded!.data)).toContain("0.00200");
  });

  it("naechster Lauf ohne Verbrauch: nur Grundgebuehr; Verbrauch der naechsten Periode zaehlt dort", async () => {
    const { rec, usageLineId } = await makeAbo();
    await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1_000_000, usageDate: "2187-03-10" }, { source: "UI", actor: "t", now: NOW });
    await emitted(rec.id);
    const next = await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 3_000_000, usageDate: "2187-04-05" }, { source: "UI", actor: "t", now: D("2187-04-10") });
    expect(next.usage.periodEnd.toISOString().slice(0, 10)).toBe("2187-04-30");
    expect(await code(recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1, usageDate: "2187-03-30" }, { source: "UI", actor: "t", now: D("2187-04-10") }))).toBe("PERIOD_BILLED");
    const second = await emitted(rec.id, D("2187-04-30"));
    const lines = await dbInternal.invoiceLine.findMany({ where: { invoiceId: second.invoiceId }, select: { quantityMilli: true } });
    expect(lines.map((l) => l.quantityMilli)).toEqual([1000, 3_000_000]);

    const third = await emitted(rec.id, D("2187-05-31"));
    const lines3 = await dbInternal.invoiceLine.findMany({ where: { invoiceId: third.invoiceId }, select: { description: true } });
    expect(lines3.map((l) => l.description)).toEqual(["Grundgebühr"]);
  });

  it("Abo nur mit Verbrauchszeile und ohne Verbrauch -> uebersprungen, Periode rueckt weiter", async () => {
    const rec = await createRecurring(orgId, input({ title: "Nur Verbrauch", lines: [usageLine] }));
    const before = await dbInternal.invoice.count({ where: { orgId } });
    const out = await emitRecurringNow(rec.id, { now: RUN });
    expect(isSkipped(out)).toBe(true);
    const after = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id }, select: { nextRunDate: true, issuedCount: true, status: true } });
    expect(after.issuedCount).toBe(0);
    expect(after.nextRunDate.getTime()).toBeGreaterThan(rec.nextRunDate.getTime());
    expect(await dbInternal.invoice.count({ where: { orgId } })).toBe(before);
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: rec.id, type: "USAGE_EMPTY_PERIOD" } })).toBe(1);

    const batch = await runDueRecurring({ now: D("2187-05-15"), orgId, maxPerAbo: 5 });
    const summary = batch.find((s) => s.recurringId === rec.id);
    expect(summary?.emitted).toHaveLength(0);
    expect(summary?.skipped.length).toBeGreaterThan(0);
  });

  it("markUsageBilled lehnt bereits abgerechnete Saetze ab und rollt zurueck", async () => {
    const { rec, usageLineId } = await makeAbo();
    const u = await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1000, usageDate: "2187-03-10" }, { source: "UI", actor: "t", now: NOW });
    const out = await emitted(rec.id);
    const numberBefore = await dbInternal.invoice.count({ where: { orgId } });
    await expect(dbInternal.$transaction((tx) => markUsageBilled(tx, [u.usage.id], out.invoiceId, RUN))).rejects.toMatchObject({ code: "ALREADY_BILLED" });
    expect(await dbInternal.invoice.count({ where: { orgId } })).toBe(numberBefore);
  });

  it("Entwurf loeschen gibt Verbraeuche frei, Storno der festgeschriebenen Rechnung nicht", async () => {
    const draft = await makeAbo({ autoFinalize: false });
    await recordUsage(orgId, draft.rec.id, { recurringLineId: draft.usageLineId, quantityMilli: 5_000_000, usageDate: "2187-03-10" }, { source: "UI", actor: "t", now: NOW });
    const d1 = await emitted(draft.rec.id);
    await dbInternal.invoiceLine.deleteMany({ where: { invoiceId: d1.invoiceId } });
    await dbInternal.invoice.delete({ where: { id: d1.invoiceId } });
    const freed = await dbInternal.recurringUsage.findMany({ where: { recurringInvoiceId: draft.rec.id }, select: { invoiceId: true } });
    expect(freed.map((f) => f.invoiceId)).toEqual([null]);
    const d2 = await emitted(draft.rec.id, D("2187-04-30"));
    const l2 = await dbInternal.invoiceLine.findMany({ where: { invoiceId: d2.invoiceId }, orderBy: { position: "asc" }, select: { quantityMilli: true, servicePeriodStart: true } });
    expect(l2[1]?.quantityMilli).toBe(5_000_000);
    expect(l2[1]?.servicePeriodStart?.toISOString().slice(0, 10)).toBe("2187-02-28");

    const fin = await makeAbo();
    await recordUsage(orgId, fin.rec.id, { recurringLineId: fin.usageLineId, quantityMilli: 2_000_000, usageDate: "2187-03-10" }, { source: "UI", actor: "t", now: NOW });
    const f1 = await emitted(fin.rec.id);
    await cancelInvoice(f1.invoiceId, { orgId, actor: "t", now: D("2187-04-02") });
    const billed = await dbInternal.recurringUsage.findMany({ where: { recurringInvoiceId: fin.rec.id }, select: { invoiceId: true } });
    expect(billed.map((b) => b.invoiceId)).toEqual([f1.invoiceId]);
  });
});

describe("Abo bearbeiten, loeschen, Laufrate", () => {
  it("Zeilen behalten ihre Id; offener Verbrauch bleibt der Zeile zugeordnet (recurringLineId nicht NULL)", async () => {
    const { rec, usageLineId, fixedLineId } = await makeAbo();
    await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 7_000_000, usageDate: "2187-03-10" }, { source: "UI", actor: "t", now: NOW });
    const updated = await updateRecurringInvoice(orgId, rec.id, {
      lines: [
        { ...fixedLine, id: fixedLineId, unitNetPriceCents: 3100 },
        { ...usageLine, id: usageLineId, unitNetPriceMilliCents: 300, unitNetPriceCents: 0 },
        { ...fixedLine, description: "Neue Position" },
      ],
    });
    expect(updated.lines.map((l) => l.id).slice(0, 2)).toEqual([fixedLineId, usageLineId]);
    expect(updated.lines).toHaveLength(3);
    expect(updated.lines.find((l) => l.id === usageLineId)?.unitNetPriceMilliCents).toBe(300);
    const kept = await dbInternal.recurringUsage.findFirstOrThrow({ where: { recurringInvoiceId: rec.id }, select: { recurringLineId: true } });
    expect(kept.recurringLineId).toBe(usageLineId);
  });

  it("offene USAGE-Zeile entfernen oder umstellen -> Fehler, Verbrauch unveraendert", async () => {
    const { rec, usageLineId, fixedLineId } = await makeAbo();
    await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1000, usageDate: "2187-03-10" }, { source: "UI", actor: "t", now: NOW });
    await expect(updateRecurringInvoice(orgId, rec.id, { lines: [{ ...fixedLine, id: fixedLineId }] })).rejects.toThrow(RecurringError);
    await expect(
      updateRecurringInvoice(orgId, rec.id, { lines: [{ ...fixedLine, id: fixedLineId }, { ...fixedLine, id: usageLineId, description: "jetzt fest" }] }),
    ).rejects.toThrow(/offene Verbräuche/);
    const row = await dbInternal.recurringUsage.findFirstOrThrow({ where: { recurringInvoiceId: rec.id }, select: { recurringLineId: true, quantityMilli: true } });
    expect(row).toEqual({ recurringLineId: usageLineId, quantityMilli: 1000 });
    const stored = await dbInternal.recurringInvoiceLine.count({ where: { recurringInvoiceId: rec.id } });
    expect(stored).toBe(2);
  });

  it("Abo loeschen mit Verbrauchssaetzen -> klare Domain-Meldung statt Datenbankfehler", async () => {
    const { rec, usageLineId } = await makeAbo();
    await recordUsage(orgId, rec.id, { recurringLineId: usageLineId, quantityMilli: 1000, usageDate: "2187-03-10" }, { source: "UI", actor: "t", now: NOW });
    await expect(deleteRecurringInvoice(orgId, rec.id)).rejects.toThrow(/Verbrauchsätze|Verbrauchssätze/);
    await expect(deleteRecurringInvoice(orgId, rec.id)).rejects.toBeInstanceOf(RecurringError);
    expect(await dbInternal.recurringInvoice.count({ where: { id: rec.id } })).toBe(1);
    const plain = await createRecurring(orgId, input({ title: "Ohne Verbrauch" }));
    await deleteRecurringInvoice(orgId, plain.id);
    expect(await dbInternal.recurringInvoice.count({ where: { id: plain.id } })).toBe(0);
    await expect(deleteRecurringInvoice(otherOrgId, rec.id)).rejects.toThrow(/nicht gefunden/);
  });

  it("Laufrate beruecksichtigt den Milli-Preis (Select + Rechnung) und zaehlt USAGE-Zeilen mit 0", async () => {
    const org = await dbInternal.organization.create({ data: { legalName: "Rate GmbH", addressLine1: "Weg 2", postalCode: "10115", city: "Berlin" } });
    const cust = await dbInternal.customer.create({ data: { orgId: org.id, name: "K", addressLine1: "Weg 3", postalCode: "10115", city: "Berlin", type: "BUSINESS" } });
    await dbInternal.recurringInvoice.create({
      data: {
        orgId: org.id, customerId: cust.id, title: "Rate", status: "ACTIVE", interval: "MONTHLY", intervalCount: 1, startDate: START, nextRunDate: START,
        lines: {
          create: [
            { position: 1, description: "Stueckpreis", quantityMilli: 10_000_000, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, taxRate: 19 },
            { position: 2, description: "Verbrauch", quantityMilli: 0, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, taxRate: 19, billing: "USAGE" },
          ],
        },
      },
    });
    const rows = await recurringRunRate(org.id, D("2187-03-01"));
    expect(rows).toEqual([{ currency: "EUR", monthlyNetCents: 2000, activeCount: 1, skipped: 0 }]);
  });

  it("Domain schreibt Verbrauch nie ueber den geschuetzten prisma-Client", () => {
    const dir = join(process.cwd(), "src/domain/recurring");
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/\bprisma\.recurringUsage/);
    }
  });
});
