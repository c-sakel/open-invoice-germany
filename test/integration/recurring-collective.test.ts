/**
 * Sammelrechnung im Abo-Lauf: Gruppenbildung, Bloecke, Zeitraeume, Aufteilung, Obergrenze mit
 * Folgegruppe, maxRuns/Enddatum je Abo, Fehler, Versand und GoBD-Guard. Eigenes Jahr 2205
 * (Invoice.number global eindeutig), eigene Organisation, kein Netz.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal, prisma, GobdImmutabilityError } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { emitOne, emitRecurringNow, runDueRecurring, isSkipped } from "@/domain/recurring/run";
import { emitCollective } from "@/domain/recurring/collective-run";
import { RecurringNotDueError } from "@/domain/recurring/errors";
import { recordUsage } from "@/domain/recurring/usage";
import { createMemoryProvider } from "@/lib/mail/memory";
import { saveMailSettings } from "@/domain/email/settings";
import { createRecurringSchema } from "@/schemas";

const START = "2205-03-01T10:00:00.000Z";
let orgId: string;
let seq = 0;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Sammel Lauf GmbH", addressLine1: "Weg 3", postalCode: "99903", city: "Teststadt", vatId: "DE123456789", taxNumber: "33/123/45678" },
    select: { id: true },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveMailSettings(orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Sammel Lauf GmbH", fromEmail: "rechnung@example.org", defaultCc: "", defaultBcc: "", copyToSelf: false });
});

async function customer(email: string | null = "sammel@example.org"): Promise<string> {
  seq += 1;
  const c = await dbInternal.customer.create({
    data: { orgId, name: `Sammelkunde ${seq}`, addressLine1: "Kundenweg 3", postalCode: "99903", city: "Teststadt", countryCode: "DE", type: "BUSINESS", ...(email ? { email } : {}) },
    select: { id: true },
  });
  return c.id;
}

const item = (description: string, cents: number) => ({ lineType: "ITEM", description, quantityMilli: 1000, unit: "C62", unitNetPriceCents: cents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 });

async function abo(customerId: string, title: string, cents: number, extra: Record<string, unknown> = {}) {
  return createRecurring(
    orgId,
    createRecurringSchema.parse({
      customerId,
      title,
      startDate: START,
      collectiveBilling: true,
      invoiceHeading: `Block ${title}`,
      lines: [item(`Leistung ${title}`, cents)],
      ...extra,
    }),
  );
}

async function invoiceLines(invoiceId: string) {
  return dbInternal.invoiceLine.findMany({ where: { invoiceId }, orderBy: { position: "asc" }, select: { lineType: true, description: true, recurringInvoiceId: true, servicePeriodStart: true, servicePeriodEnd: true } });
}

async function run(rec: { nextRunDate: Date }, extra: { provider?: ReturnType<typeof createMemoryProvider> } = {}) {
  return runDueRecurring({ now: rec.nextRunDate, orgId, ...extra });
}

describe("Sammelrechnung im Lauf", () => {
  it("zwei Festpreis-Abos ergeben eine Rechnung mit Bloecken je Abo", async () => {
    const c = await customer();
    const a = await abo(c, "A", 1000);
    const b = await abo(c, "B", 2000);
    const sums = await run(a);
    const emittedAll = sums.flatMap((s) => s.emitted).filter((e) => e.collectiveRecurringIds);
    expect(emittedAll).toHaveLength(1);
    expect(emittedAll[0].collectiveRecurringIds).toEqual([a.id, b.id].sort());
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emittedAll[0].invoiceId }, select: { recurringInvoiceId: true, netTotalCents: true, id: true } });
    expect(inv.recurringInvoiceId).toBeNull();
    expect(inv.netTotalCents).toBe(3000);
    const lines = await invoiceLines(inv.id);
    expect(lines.map((l) => l.lineType)).toEqual(["HEADING", "ITEM", "SUBTOTAL", "HEADING", "ITEM", "SUBTOTAL"]);
    expect(lines.map((l) => l.description)[0]).toBe("Block A");
    expect(lines.map((l) => l.recurringInvoiceId)).toEqual([a.id, a.id, a.id, b.id, b.id, b.id]);
    expect(await dbInternal.documentRelation.count({ where: { orgId, fromId: inv.id, relationType: "GENERATED_BY" } })).toBe(2);
    for (const r of [a, b]) {
      const after = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: r.id }, select: { issuedCount: true, nextRunDate: true, lastRunAt: true } });
      expect(after.issuedCount).toBe(1);
      expect(after.nextRunDate.getTime()).toBeGreaterThan(r.nextRunDate.getTime());
      expect(after.lastRunAt).not.toBeNull();
    }
    const cl = await dbInternal.changeLog.findMany({ where: { orgId, entityId: inv.id, action: "CREATE" }, select: { diffJson: true } });
    expect(cl).toHaveLength(1);
    expect(JSON.parse(cl[0].diffJson).collective).toEqual([a.id, b.id].sort());
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: inv.id, type: "CREATED" } })).toBe(1);
  });

  it("eigene HEADING/SUBTOTAL-Struktur im Abo erzeugt keine zusaetzliche Zwischensumme", async () => {
    const c = await customer();
    const a = await abo(c, "S1", 1000, {
      lines: [
        { lineType: "HEADING", description: "Eigene Struktur", quantityMilli: 0, unit: "C62", unitNetPriceCents: 0, taxRate: 0, taxCategory: "S", discountPermille: 0, discountCents: 0 },
        item("Posten", 1000),
        { lineType: "SUBTOTAL", description: "Summe", quantityMilli: 0, unit: "C62", unitNetPriceCents: 0, taxRate: 0, taxCategory: "S", discountPermille: 0, discountCents: 0 },
      ],
    });
    await abo(c, "S2", 500);
    const out = (await run(a)).flatMap((s) => s.emitted)[0];
    const types = (await invoiceLines(out.invoiceId)).map((l) => l.lineType);
    expect(types).toEqual(["HEADING", "HEADING", "ITEM", "SUBTOTAL", "HEADING", "ITEM", "SUBTOTAL"]);
  });

  it("Zeitraumtext: nur A an -> BG-26 und BG-14 aus A; beide an -> Min/Max im Kopftext", async () => {
    const c = await customer();
    const a = await abo(c, "P1", 1000, { showPeriodText: true });
    await abo(c, "P2", 500, { showPeriodText: false });
    const out = (await run(a)).flatMap((s) => s.emitted)[0];
    const lines = (await invoiceLines(out.invoiceId)).filter((l) => l.lineType === "ITEM");
    expect(lines[0].servicePeriodStart).not.toBeNull();
    expect(lines[1].servicePeriodStart).toBeNull();
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: out.invoiceId }, select: { headerText: true, deliveryStart: true, deliveryEnd: true } });
    expect(inv.deliveryStart?.getTime()).toBe(lines[0].servicePeriodStart?.getTime());

    const c2 = await customer();
    const m = await abo(c2, "M1", 1000, { showPeriodText: true });
    await abo(c2, "Q1", 500, { showPeriodText: true, interval: "MONTHLY", intervalCount: 3 });
    const out2 = (await run(m)).flatMap((s) => s.emitted).find((e) => e.collectiveRecurringIds)!;
    const inv2 = await dbInternal.invoice.findUniqueOrThrow({ where: { id: out2.invoiceId }, select: { headerText: true } });
    expect(inv2.headerText).toContain("Abrechnungszeitraum");
  });

  it("abweichende Waehrung -> zwei Einzelrechnungen mit COLLECTIVE_SPLIT; anderer Kunde und pausierter Partner nicht beteiligt", async () => {
    const c = await customer();
    const a = await abo(c, "W1", 1000);
    const b = await abo(c, "W2", 1000, { currency: "USD" });
    const paused = await abo(c, "W3", 1000);
    await dbInternal.recurringInvoice.update({ where: { id: paused.id }, data: { status: "PAUSED" } });
    const other = await customer();
    const o = await abo(other, "W4", 1000);
    const sums = await run(a);
    const mine = sums.filter((s) => [a.id, b.id, o.id].includes(s.recurringId));
    const all = mine.flatMap((s) => s.emitted);
    expect(all).toHaveLength(3);
    expect(all.every((e) => !e.collectiveRecurringIds)).toBe(true);
    for (const r of [a, b]) {
      const inv = await dbInternal.invoice.findFirstOrThrow({ where: { orgId, recurringInvoiceId: r.id }, select: { id: true } });
      expect(inv.id).toBeTruthy();
    }
    const splitA = await dbInternal.activityLog.findFirstOrThrow({ where: { orgId, entityId: b.id, type: "COLLECTIVE_SPLIT" }, select: { dataJson: true } });
    expect(JSON.parse(splitA.dataJson ?? "{}").reasons).toEqual(["currency"]);
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: o.id, type: "COLLECTIVE_SPLIT" } })).toBe(0);
    expect(await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: paused.id }, select: { issuedCount: true } })).toEqual({ issuedCount: 0 });
  });

  it("Sammel-Abo ohne Partner entspricht einem Abo ohne Schalter", async () => {
    const c1 = await customer();
    const c2 = await customer();
    const solo = await abo(c1, "Solo", 1234, { showPeriodText: true });
    const plain = await abo(c2, "Solo", 1234, { showPeriodText: true, collectiveBilling: false, invoiceHeading: undefined });
    const o1 = (await emitRecurringNow(solo.id, { now: solo.nextRunDate }));
    const o2 = (await emitRecurringNow(plain.id, { now: plain.nextRunDate }));
    if (isSkipped(o1) || isSkipped(o2)) throw new Error("uebersprungen");
    const sel = { headerText: true, netTotalCents: true, deliveryStart: true, deliveryEnd: true, recurringInvoiceId: true } as const;
    const i1 = await dbInternal.invoice.findUniqueOrThrow({ where: { id: o1.invoiceId }, select: sel });
    const i2 = await dbInternal.invoice.findUniqueOrThrow({ where: { id: o2.invoiceId }, select: sel });
    expect({ ...i1, recurringInvoiceId: !!i1.recurringInvoiceId }).toEqual({ ...i2, recurringInvoiceId: !!i2.recurringInvoiceId });
    expect(i1.recurringInvoiceId).toBe(solo.id);
    expect((await invoiceLines(o1.invoiceId)).map((l) => l.lineType)).toEqual(["ITEM"]);
    expect(o1.collectiveRecurringIds).toBeUndefined();
  });

  it("maxRuns 1 beendet nur A; B laeuft im Folgemonat einzeln weiter", async () => {
    const c = await customer();
    const a = await abo(c, "R1", 1000, { maxRuns: 1 });
    const b = await abo(c, "R2", 1000);
    await run(a);
    expect((await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } })).status).toBe("ENDED");
    const bAfter = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: b.id }, select: { status: true, nextRunDate: true } });
    expect(bAfter.status).toBe("ACTIVE");
    const next = (await runDueRecurring({ now: bAfter.nextRunDate, orgId })).flatMap((s) => s.emitted).filter((e) => e.invoiceId);
    const own = await dbInternal.invoice.findFirstOrThrow({ where: { orgId, recurringInvoiceId: b.id }, select: { id: true } });
    expect(next.map((e) => e.invoiceId)).toContain(own.id);
  });

  it("Enddatum je Abo: A endet nach dem Lauf, B bleibt aktiv", async () => {
    const c = await customer();
    const a = await abo(c, "E1", 1000, { endDate: "2205-03-15T10:00:00.000Z" });
    const b = await abo(c, "E2", 1000);
    await run(a);
    expect((await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } })).status).toBe("ENDED");
    expect((await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: b.id }, select: { status: true } })).status).toBe("ACTIVE");
  });

  it("autoFinalize + autoSend: Nummer und genau eine Mail", async () => {
    const c = await customer("sammel-mail@example.org");
    const a = await abo(c, "V1", 1000, { autoFinalize: true, autoSend: true });
    await abo(c, "V2", 1000, { autoFinalize: true, autoSend: true });
    const provider = createMemoryProvider();
    const out = (await run(a, { provider })).flatMap((s) => s.emitted).find((e) => e.collectiveRecurringIds)!;
    expect(out.finalized).toBe(true);
    expect(out.number).toBeTruthy();
    expect(out.emailStatus).toBe("SENT");
    expect(provider.sent).toHaveLength(1);
  });

  it("GoBD-Guard: festgeschriebene Sammelrechnung ist nur ueber recurringInvoiceId der Zeile aenderbar", async () => {
    const c = await customer();
    const a = await abo(c, "G1", 1000, { autoFinalize: true });
    await abo(c, "G2", 1000, { autoFinalize: true });
    const out = (await run(a)).flatMap((s) => s.emitted).find((e) => e.collectiveRecurringIds)!;
    const line = await dbInternal.invoiceLine.findFirstOrThrow({ where: { invoiceId: out.invoiceId, lineType: "ITEM" }, select: { id: true } });
    await expect(prisma.invoiceLine.update({ where: { id: line.id }, data: { description: "x" } })).rejects.toBeInstanceOf(GobdImmutabilityError);
    await expect(prisma.invoiceLine.update({ where: { id: line.id }, data: { recurringInvoiceId: null } })).rejects.toBeInstanceOf(GobdImmutabilityError);
  });

  it("emitRecurringNow(B) vor dem Stichtag rechnet A und B gemeinsam ab", async () => {
    const c = await customer();
    const a = await abo(c, "N1", 1000);
    const b = await abo(c, "N2", 1000);
    const out = await emitRecurringNow(b.id, { now: new Date(a.nextRunDate.getTime() - 5 * 86_400_000) });
    if (isSkipped(out)) throw new Error("uebersprungen");
    expect(out.collectiveRecurringIds).toEqual([a.id, b.id].sort());
  });

  it("Rueckstand von zwei Perioden ergibt zwei Sammelrechnungen", async () => {
    const c = await customer();
    const a = await abo(c, "B1", 1000);
    const b = await abo(c, "B2", 1000);
    const now = new Date(a.nextRunDate.getTime() + 40 * 86_400_000);
    const sums = (await runDueRecurring({ now, orgId })).filter((s) => [a.id, b.id].includes(s.recurringId));
    const coll = sums.flatMap((s) => s.emitted).filter((e) => e.collectiveRecurringIds);
    expect(coll).toHaveLength(2);
    expect(coll[0].periodDate.getTime()).toBeLessThan(coll[1].periodDate.getTime());
  });

  it("maxMembers 2 bei drei Abos: 2 + 1", async () => {
    const c = await customer();
    const a = await abo(c, "K1", 1000);
    const b = await abo(c, "K2", 1000);
    const d = await abo(c, "K3", 1000);
    const first = await emitCollective(a.id, a.nextRunDate, "t", { mode: "batch", maxMembers: 2 });
    expect(first.memberIds).toEqual([a.id, b.id]);
    const second = await emitCollective(d.id, a.nextRunDate, "t", { mode: "batch", maxMembers: 2 });
    expect(second.memberIds).toEqual([d.id]);
    const o = second.outcome;
    expect("invoiceId" in o && o.collectiveRecurringIds).toBeFalsy();
  });

  it("mehr als 50 Abos: alle werden im selben Lauf genau einmal abgerechnet (50 + 1)", async () => {
    const c = await customer();
    const recs: Awaited<ReturnType<typeof abo>>[] = [];
    for (let i = 0; i < 51; i++) recs.push(await abo(c, `X${i}`, 100 + i));
    const sums = (await runDueRecurring({ now: recs[0].nextRunDate, orgId })).filter((s) => recs.some((r) => r.id === s.recurringId));
    const invoiceIds = new Set(sums.flatMap((s) => s.emitted).map((e) => e.invoiceId));
    expect(invoiceIds.size).toBe(2);
    expect(sums.every((s) => !s.error)).toBe(true);
    for (const r of recs) {
      const after = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: r.id }, select: { issuedCount: true } });
      expect(after.issuedCount).toBe(1);
      expect(await dbInternal.documentRelation.count({ where: { orgId, toId: r.id, relationType: "GENERATED_BY" } })).toBe(1);
    }
    const sizes = await Promise.all([...invoiceIds].map((id) => dbInternal.documentRelation.count({ where: { orgId, fromId: id, relationType: "GENERATED_BY" } })));
    expect(sizes.sort((x, y) => x - y)).toEqual([1, 50]);
    // zweiter Lauf: nichts mehr faellig, keine Doppelabrechnung
    const again = (await runDueRecurring({ now: recs[0].nextRunDate, orgId })).filter((s) => recs.some((r) => r.id === s.recurringId));
    expect(again.flatMap((s) => s.emitted)).toHaveLength(0);
  }, 120_000);

  async function defectiveUsageAbo(c: string, title: string) {
    const usageLine = { lineType: "ITEM", description: "Verbrauch", quantityMilli: 0, unit: "C62", unitNetPriceCents: 0, unitNetPriceMilliCents: 200, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, billing: "USAGE", usageUnitLabel: "Stk" };
    const b = await abo(c, title, 0, { lines: [usageLine] });
    const usageLineId = b.lines.find((l) => l.billing === "USAGE")!.id;
    for (const q of [2_000_000_000, 1_000_000_000]) {
      await recordUsage(orgId, b.id, { recurringLineId: usageLineId, quantityMilli: q, usageDate: "2205-03-01" }, { source: "API", actor: "t", now: new Date("2205-03-02T10:00:00Z") });
    }
    return b;
  }

  it("Fehler in einem Mitglied: uebrige werden abgerechnet, defektes bleibt faellig, eine Benachrichtigung", async () => {
    const c = await customer();
    const a = await abo(c, "F1", 1000);
    const b = await defectiveUsageAbo(c, "F2");
    const now = new Date(a.nextRunDate.getTime() + 86_400_000);
    const sums = (await runDueRecurring({ now, orgId })).filter((s) => [a.id, b.id].includes(s.recurringId));
    expect(sums.flatMap((s) => s.emitted)).toHaveLength(1);
    expect(sums.filter((s) => s.error).map((s) => s.recurringId)).toEqual([b.id]);
    const afterA = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: a.id }, select: { issuedCount: true } });
    expect(afterA.issuedCount).toBe(1);
    const afterB = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: b.id }, select: { issuedCount: true, nextRunDate: true } });
    expect(afterB.issuedCount).toBe(0);
    expect(afterB.nextRunDate.getTime()).toBe(b.nextRunDate.getTime());
    expect(await dbInternal.recurringUsage.count({ where: { recurringInvoiceId: b.id, invoiceId: null } })).toBe(2);
    expect(await dbInternal.notification.count({ where: { orgId, type: "RECURRING_FAILED", entityId: b.id } })).toBe(1);
    expect(await dbInternal.notification.count({ where: { orgId, type: "RECURRING_FAILED", entityId: a.id } })).toBe(0);
  });

  it("defektes Mitglied als Ausloeser: die uebrigen Abos werden trotzdem abgerechnet", async () => {
    const c = await customer();
    const b = await defectiveUsageAbo(c, "G1");
    const a = await abo(c, "G2", 1000);
    const d = await abo(c, "G3", 2000);
    const now = new Date(a.nextRunDate.getTime() + 86_400_000);
    const sums = (await runDueRecurring({ now, orgId })).filter((s) => [a.id, b.id, d.id].includes(s.recurringId));
    const coll = sums.flatMap((s) => s.emitted).filter((e) => e.collectiveRecurringIds);
    expect(coll).toHaveLength(1);
    expect(coll[0].collectiveRecurringIds).toEqual([a.id, d.id].sort());
    expect(sums.filter((s) => s.error).map((s) => s.recurringId)).toEqual([b.id]);
  });

  it("Ueberhang mit defektem Mitglied: Folgeausloeser wird nicht blockiert", async () => {
    const c = await customer();
    const recs: { id: string; nextRunDate: Date }[] = [];
    recs.push(await abo(c, "Y0", 100));
    const bad = await defectiveUsageAbo(c, "Y1");
    recs.push(bad);
    for (let i = 2; i < 51; i++) recs.push(await abo(c, `Y${i}`, 100 + i));
    const now = new Date(recs[0].nextRunDate.getTime() + 86_400_000);
    const ids = recs.map((r) => r.id);
    const sums = (await runDueRecurring({ now, orgId })).filter((s) => ids.includes(s.recurringId));
    expect(sums.filter((s) => s.error).map((s) => s.recurringId)).toEqual([bad.id]);
    const invoiceIds = new Set(sums.flatMap((s) => s.emitted).map((e) => e.invoiceId));
    expect(invoiceIds.size).toBe(1);
    const billed = await dbInternal.recurringInvoice.count({ where: { id: { in: ids }, issuedCount: 1 } });
    expect(billed).toBe(50);
  }, 240_000);
  it("Fehler im Gruppenpfad: jedes Abo wird einzeln abgerechnet, eine Benachrichtigung, zweiter Lauf erzeugt nichts", async () => {
    const c = await customer();
    const a = await abo(c, "H1", 1000);
    const b = await abo(c, "H2", 2000);
    const d = await abo(c, "H3", 3000);
    const ids = [a.id, b.id, d.id];
    const failGroupPathForTest = () => { throw new Error("Zusammenfuehrung gescheitert"); };
    const sums = (await runDueRecurring({ now: a.nextRunDate, orgId, failGroupPathForTest })).filter((s) => ids.includes(s.recurringId));
    expect(sums.every((s) => !s.error)).toBe(true);
    const emitted = sums.flatMap((s) => s.emitted);
    expect(emitted).toHaveLength(3);
    expect(emitted.every((e) => !e.collectiveRecurringIds)).toBe(true);
    expect(new Set(emitted.map((e) => e.invoiceId)).size).toBe(3);
    for (const r of [a, b, d]) {
      const after = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: r.id }, select: { issuedCount: true, nextRunDate: true } });
      expect(after.issuedCount).toBe(1);
      expect(after.nextRunDate.getTime()).toBeGreaterThan(r.nextRunDate.getTime());
      expect(await dbInternal.documentRelation.count({ where: { orgId, toId: r.id, relationType: "GENERATED_BY" } })).toBe(1);
    }
    const notes = await dbInternal.notification.findMany({ where: { orgId, type: "RECURRING_FAILED", entityId: { in: ids } }, select: { title: true } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("Sammelrechnung nicht moeglich");
    const again = (await runDueRecurring({ now: a.nextRunDate, orgId, failGroupPathForTest })).filter((s) => ids.includes(s.recurringId));
    expect(again.flatMap((s) => s.emitted)).toHaveLength(0);
  });

  it("Einzelabrechnung mit Faelligkeitspruefung: nicht faelliges Abo wird nicht vorgezogen", async () => {
    const c = await customer();
    const a = await abo(c, "N1", 1000);
    const before = a.nextRunDate.getTime() - 86_400_000;
    await expect(emitOne(a.id, new Date(before), "test", undefined, true)).rejects.toBeInstanceOf(RecurringNotDueError);
    const after = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: a.id }, select: { issuedCount: true, nextRunDate: true } });
    expect(after.issuedCount).toBe(0);
    expect(after.nextRunDate.getTime()).toBe(a.nextRunDate.getTime());
  });

  it("fehlende Blockueberschrift: neutrale Ueberschrift, nie der interne Abo-Titel", async () => {
    const c = await customer();
    const a = await abo(c, "GEHEIMTITEL-X", 1000);
    const b = await abo(c, "Y9", 2000);
    await dbInternal.recurringInvoice.update({ where: { id: a.id }, data: { invoiceHeading: null } });
    const out = (await run(a)).flatMap((s) => s.emitted).find((e) => e.collectiveRecurringIds);
    expect(out).toBeDefined();
    const lines = await invoiceLines(out!.invoiceId);
    expect(lines.map((l) => l.description)).toContain("Abonnement");
    expect(lines.filter((l) => l.lineType !== "ITEM").map((l) => l.description).join("|")).not.toContain("GEHEIMTITEL");
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: out!.invoiceId }, select: { notes: true, headerText: true } });
    expect(`${inv.notes ?? ""}${inv.headerText ?? ""}`).not.toContain("GEHEIMTITEL");
    expect(b.id).toBeTruthy();
  });

  it("manuell: Fehler eines Partner-Abos nennt dessen Namen", async () => {
    const c = await customer();
    const a = await abo(c, "M1", 1000);
    const b = await abo(c, "M2", 2000);
    await dbInternal.recurringInvoiceLine.deleteMany({ where: { recurringInvoiceId: b.id } });
    await expect(emitRecurringNow(a.id, { now: a.nextRunDate })).rejects.toThrow(/M2/);
  });
});
