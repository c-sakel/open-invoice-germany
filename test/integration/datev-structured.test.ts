/**
 * DATEV: Abschlags-/Schlussrechnung und Sammelrechnung im Exportlauf (Summenpruefung) sowie Einschaltzeitpunkt des
 * Zahlungsexports (Zahlungen frueher exportierter Monate sind kein Nachtrag). Nummernkennung 2228, Belegdaten 2096.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { createBusinessDocument } from "@/domain/document/create";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { datevStatus, readDatevExportFile, runDatevExport } from "@/domain/export/datev/run";
import { confirmDatevMapping, getDatevSettings, saveDatevSettings } from "@/domain/export/datev/settings";
import type { CreateInvoiceInput } from "@/schemas";
import { have, mkDatevInvoice, mkDatevOrg, parseExtf, setupDatev, unzipBuffer, type DatevTestOrg } from "../helpers/datev-fixtures";

const MAR = new Date("2096-03-10T10:00:00.000Z");
const MAR_PAY = new Date("2096-03-20T10:00:00.000Z");
const APR = new Date("2096-04-12T10:00:00.000Z");
const APR_PAY = new Date("2096-04-20T10:00:00.000Z");
const MAR_EXPORT = new Date("2096-04-05T10:00:00.000Z");
const ENABLE = new Date("2096-04-10T10:00:00.000Z");
const APR_EXPORT = new Date("2096-05-05T10:00:00.000Z");
const LATE = new Date("2096-05-20T10:00:00.000Z");
const NOW = new Date("2096-06-10T10:00:00.000Z");

let tmpDir: string;
let prevArchive: string | undefined;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-struct-"));
  prevArchive = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
});

afterAll(async () => {
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Stapelzeilen eines Monatslaufs: [Betrag in Cent, Soll/Haben, Konto, Gegenkonto, Belegfeld 1]. */
async function runRows(orgId: string, month: string, now: Date): Promise<{ cents: number; side: string; counter: string; beleg: string; reversal: boolean }[]> {
  const view = await runDatevExport(orgId, { from: month, to: month, mode: "PERIOD" }, "tester", now);
  const { bytes } = await readDatevExportFile(orgId, view.id);
  const z = unzipBuffer(bytes);
  try {
    return parseExtf(z.read(`EXTF_Buchungsstapel_${month}.csv`)).rows.map((r) => ({
      cents: Number(r[0].replace(",", "")),
      side: r[1].replace(/"/g, ""),
      counter: r[7],
      beleg: r[10].replace(/"/g, ""),
      reversal: r[117] === '"1"' || r[117] === "1",
    }));
  } finally {
    z.cleanup();
  }
}

const signed = (r: { cents: number; side: string; reversal: boolean }): number => {
  const v = r.side === "S" ? r.cents : -r.cents;
  return r.reversal ? -v : v;
};

describe.skipIf(!have("unzip", "-v"))("Abschlag und Schlussrechnung", () => {
  it("Abschlag S auf Anzahlungskonto, Schlussrechnung voller Erloes + Abzug H, Personenkonto-Saldo = Gesamtleistung", async () => {
    const org: DatevTestOrg = await mkDatevOrg("Datev Struktur GmbH", "2228", MAR);
    await setupDatev(org.orgId);
    const quote = await createBusinessDocument(
      org.orgId,
      {
        kind: "ANGEBOT",
        customerId: org.customerId,
        taxScheme: "REGULAR",
        currency: "EUR",
        lines: [{ lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1_000_000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      },
      { now: MAR },
    );
    const dp = await finalizeInvoice((await createDownpaymentInvoice(org.orgId, { sourceType: "QUOTE", sourceId: quote.id, mode: "PERCENT", permille: 300 }, { now: MAR })).id, { now: MAR });
    expect(dp.grossTotalCents).toBe(357_000);
    const final = await finalizeInvoice((await createFinalInvoice(org.orgId, { sourceType: "QUOTE", sourceId: quote.id }, { now: MAR })).id, { now: MAR });
    expect(final.grossTotalCents).toBe(1_190_000);
    expect(final.payableCents).toBe(833_000);

    const rows = await runRows(org.orgId, "2096-03", NOW);
    const dpRows = rows.filter((r) => r.beleg === (dp.number ?? "").replace(/[^A-Za-z0-9_$&%*+\-/]/g, "_"));
    const finRows = rows.filter((r) => r.beleg === (final.number ?? "").replace(/[^A-Za-z0-9_$&%*+\-/]/g, "_"));
    expect(dpRows.map((r) => [r.side, r.cents])).toEqual([["S", 357_000]]);
    expect(finRows.map((r) => [r.side, r.cents])).toEqual([["S", 1_190_000], ["H", 357_000]]);
    // Anzahlungskonto (Abschlag und Abzug) ist dasselbe Gegenkonto, der Erloes ein anderes.
    expect(dpRows[0].counter).toBe(finRows[1].counter);
    expect(finRows[0].counter).not.toBe(dpRows[0].counter);
    // Saldo des Personenkontos = Brutto der Gesamtleistung.
    expect([...dpRows, ...finRows].reduce((s, r) => s + signed(r), 0)).toBe(1_190_000);
    const items = await dbInternal.datevExportItem.findMany({ where: { orgId: org.orgId }, select: { status: true, amountCents: true } });
    expect(items.every((i) => i.status === "EXPORTED")).toBe(true);
  });
});

describe.skipIf(!have("unzip", "-v"))("Sammelrechnung", () => {
  it("viele Positionen in zwei Steuersaetzen -> je Satz eine Zeile, Summe = Brutto", async () => {
    const org = await mkDatevOrg("Datev Sammel GmbH", "2228", MAR);
    await setupDatev(org.orgId);
    const lines = Array.from({ length: 12 }, (_, i) => ({
      description: `Position ${i + 1}`,
      quantityMilli: 1000 + i * 250,
      unit: "HUR",
      unitNetPriceCents: 1234 + i * 77,
      taxRate: i % 3 === 0 ? 7 : 19,
      taxCategory: "S",
      discountPermille: 0,
      discountCents: 0,
    }));
    const input = {
      customerId: org.customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
      documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
      issueDate: MAR, deliveryDate: MAR, lines,
    } as CreateInvoiceInput;
    const draft = await createDraftInvoice(org.orgId, input, { now: MAR });
    const fin = await finalizeInvoice(draft.id, { now: MAR });
    const rows = await runRows(org.orgId, "2096-03", NOW);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.side === "S")).toBe(true);
    expect(rows.reduce((s, r) => s + r.cents, 0)).toBe(fin.grossTotalCents);
    expect(new Set(rows.map((r) => r.counter)).size).toBe(2);
  });
});

describe.skipIf(!have("unzip", "-v"))("Einschaltzeitpunkt des Zahlungsexports", () => {
  it("Zahlungen frueher exportierter Monate sind kein Nachtrag, spaetere Monate schon", async () => {
    const org = await mkDatevOrg("Datev Zahlung GmbH", "2228", MAR);
    await setupDatev(org.orgId, { exportPayments: false });
    expect((await getDatevSettings(org.orgId)).exportPaymentsSince).toBeNull();
    const a = await mkDatevInvoice(org, { issue: MAR, netCents: 10000 });
    await recordPayment(a.id, { amountCents: a.grossCents, paidAt: MAR_PAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org.orgId, now: MAR_PAY, provider: "BANK", providerPaymentId: "bk_dv2228a" });
    await runDatevExport(org.orgId, { from: "2096-03", to: "2096-03", mode: "PERIOD" }, "tester", MAR_EXPORT);

    const on = await saveDatevSettings(org.orgId, { exportPayments: true }, "test", ENABLE);
    expect(on.exportPaymentsSince?.toISOString()).toBe(ENABLE.toISOString());
    expect(on.confirmed).toBe(false); // Zeitpunkt und Schalter gehoeren zur Bestaetigung
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "test");
    // Die Zahlung gehoert zu einem Monat, der vor dem Einschalten exportiert wurde: kein Nachtrag.
    expect((await datevStatus(org.orgId, LATE)).pendingLate).toEqual([]);

    const b = await mkDatevInvoice(org, { issue: APR, netCents: 20000 });
    await runDatevExport(org.orgId, { from: "2096-04", to: "2096-04", mode: "PERIOD" }, "tester", APR_EXPORT);
    await recordPayment(b.id, { amountCents: b.grossCents, paidAt: APR_PAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org.orgId, now: LATE, provider: "BANK", providerPaymentId: "bk_dv2228b" });
    const st = await datevStatus(org.orgId, LATE);
    expect(st.pendingLate).toHaveLength(1);
    expect(st.pendingLate[0]).toMatchObject({ month: "2096-04", count: 1 });

    const off = await saveDatevSettings(org.orgId, { exportPayments: false }, "test", LATE);
    expect(off.exportPaymentsSince).toBeNull();
  });
});
