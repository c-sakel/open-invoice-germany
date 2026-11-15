/**
 * DATEV: Sonderfaelle (Fremdwaehrung, innergemeinschaftliche Lieferung, Teilgutschrift mit Verrechnung,
 * Kleinunternehmer, Skonto, Zahlungsexport aus). Nummernkennung 2225, Belegdaten 2096.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { readDatevExportFile, runDatevExport } from "@/domain/export/datev/run";
import { recordPayment } from "@/domain/invoice/payment";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { upsertManualRate } from "@/domain/fx/store";
import { exchangeRateUpsertSchema } from "@/schemas/fx";
import { have, mkCustomer, mkDatevInvoice, mkDatevOrg, parseExtf, setupDatev, unzipBuffer, type DatevTestOrg } from "../helpers/datev-fixtures";

const MAR = new Date("2096-03-10T10:00:00.000Z");
const PAY = new Date("2096-03-13T10:00:00.000Z");
const NOW = new Date("2096-06-10T10:00:00.000Z");

let tmpDir: string;
let prevArchive: string | undefined;
let org: DatevTestOrg;
let rows: string[][] = [];
let items: { itemKey: string; status: string; reason: string | null; lineCount: number }[] = [];
const refs: { usd: string; usdPay: string; ig: string; part: string; partCredit: string; klein: string; skonto: string; skontoAmount: number; skontoPay: string } = {
  usd: "", usdPay: "", ig: "", part: "", partCredit: "", klein: "", skonto: "", skontoAmount: 0, skontoPay: "",
};

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-special-"));
  prevArchive = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  org = await mkDatevOrg("Datev Sonder GmbH", "2225", MAR);
  await setupDatev(org.orgId);
  await upsertManualRate(exchangeRateUpsertSchema.parse({ source: "MONTHLY", currency: "USD", rateDate: "2096-03-01", rate: "1,2" }), "test", org.orgId);

  const usd = await mkDatevInvoice(org, { issue: MAR, currency: "USD", netCents: 12000 });
  const usdPay = await recordPayment(usd.id, { amountCents: usd.grossCents, paidAt: PAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org.orgId, now: PAY, provider: "BANK", providerPaymentId: "bk_usd_2225" });
  const fr = await mkCustomer(org, "Societe Francaise SARL", "FR-1", { vatId: "FR12345678901", countryCode: "FR" });
  const ig = await mkDatevInvoice(org, { issue: MAR, customerId: fr, taxScheme: "IG_LIEFERUNG", taxRate: 0, taxCategory: "K", notes: "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG)" });
  const part = await mkDatevInvoice(org, { issue: MAR, netCents: 10000 });
  const partCredit = await createPartialCreditNote(part.id, { lines: [{ description: "Teilrueckgabe", quantityMilli: 1000, unitNetPriceCents: 4000, taxRate: 19, taxCategory: "S" }] }, { orgId: org.orgId, now: PAY });
  const klein = await mkDatevInvoice(org, { issue: MAR, customerId: await mkCustomer(org, "Klein Kunde", "KL-1"), taxScheme: "KLEINUNTERNEHMER", taxRate: 0, taxCategory: "E", notes: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer" });
  const skonto = await mkDatevInvoice(org, { issue: MAR, customerId: await mkCustomer(org, "Skonto Kunde", "SK-1"), skonto: true });
  const sk = await recordPayment(skonto.id, { amountCents: Math.round(skonto.grossCents * 0.98), paidAt: PAY, method: "TRANSFER", isSkonto: false, applySkonto: true }, { orgId: org.orgId, now: PAY, provider: "BANK", providerPaymentId: "bk_sk_2225" });
  Object.assign(refs, {
    usd: usd.id, usdPay: usdPay.recorded.id, ig: ig.id, part: part.id, partCredit: partCredit.creditNote.id, klein: klein.id, skonto: skonto.id,
    skontoAmount: sk.skontoPayment?.amountCents ?? 0, skontoPay: sk.recorded.id,
  });
});

afterAll(async () => {
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!have("unzip", "-v"))("Sonderfaelle", () => {
  it("Lauf", async () => {
    const view = await runDatevExport(org.orgId, { from: "2096-03", to: "2096-03", mode: "PERIOD" }, "tester", NOW);
    const { bytes } = await readDatevExportFile(org.orgId, view.id);
    const z = unzipBuffer(bytes);
    try {
      rows = parseExtf(z.read("EXTF_Buchungsstapel_2096-03.csv")).rows;
    } finally {
      z.cleanup();
    }
    items = await dbInternal.datevExportItem.findMany({ where: { exportId: view.id }, select: { itemKey: true, status: true, reason: true, lineCount: true } });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("USD-Rechnung bucht EUR-Zeilen mit Zusatzinformation, USD-Zahlung ist MANUAL", () => {
    const line = rows.find((r) => r[47] === '"Fremdwaehrung"');
    expect(line).toBeDefined();
    expect(line?.[48]).toContain("USD");
    expect(line?.[48]).toContain("Kurs 1,200000");
    const pay = items.find((i) => i.itemKey === `pay:${refs.usdPay}`);
    expect(pay?.status).toBe("MANUAL");
    expect(pay?.reason).toContain("Fremdwaehrung");
  });

  it("IG_LIEFERUNG traegt Feld 40", () => {
    const line = rows.find((r) => r[39] === '"FR12345678901"');
    expect(line).toBeDefined();
  });

  it("Teilgutschrift mit Verrechnung: Gutschriftzeile, keine Zahlungszeile fuer die Verrechnung", async () => {
    const credit = items.find((i) => i.itemKey === `doc:${refs.partCredit}`);
    expect(credit?.status).toBe("EXPORTED");
    const offset = await dbInternal.payment.findMany({ where: { invoiceId: refs.part, method: "CREDIT_NOTE" }, select: { id: true } });
    expect(offset.length).toBeGreaterThan(0);
    for (const p of offset) expect(items.some((i) => i.itemKey === `pay:${p.id}`)).toBe(false);
    expect(rows.some((r) => r[117] === '"1"')).toBe(true);
  });

  it("Kleinunternehmer-Beleg wird gebucht", () => {
    expect(items.find((i) => i.itemKey === `doc:${refs.klein}`)?.status).toBe("EXPORTED");
  });

  it("Skonto steht im Skontofeld der Zahlung; die Skontozahlung ist mitgebucht", () => {
    expect(refs.skontoAmount).toBeGreaterThanOrEqual(100);
    const expected = `${Math.floor(refs.skontoAmount / 100)},${String(refs.skontoAmount % 100).padStart(2, "0")}`;
    expect(rows.some((r) => r[12] === expected)).toBe(true);
    expect(items.filter((i) => i.itemKey.startsWith("pay:")).some((i) => i.lineCount === 0 && i.status === "EXPORTED")).toBe(true);
  });

  it("exportPayments false: keine Zahlungszeilen, Zahlungen ohne Item", async () => {
    const o = await mkDatevOrg("Datev Ohne Zahlung GmbH", "2225", MAR);
    await setupDatev(o.orgId, { exportPayments: false });
    const inv = await mkDatevInvoice(o, { issue: MAR });
    await recordPayment(inv.id, { amountCents: inv.grossCents, paidAt: PAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: o.orgId, now: PAY, provider: "BANK", providerPaymentId: "bk_np_2225" });
    const view = await runDatevExport(o.orgId, { from: "2096-03", to: "2096-03", mode: "PERIOD" }, "tester", NOW);
    const { bytes } = await readDatevExportFile(o.orgId, view.id);
    const z = unzipBuffer(bytes);
    try {
      const f = parseExtf(z.read("EXTF_Buchungsstapel_2096-03.csv"));
      expect(f.rows).toHaveLength(1);
      expect(f.rows[0][1]).toBe('"S"');
    } finally {
      z.cleanup();
    }
    expect(await dbInternal.datevExportItem.count({ where: { exportId: view.id, itemKey: { startsWith: "pay:" } } })).toBe(0);
  });
});
