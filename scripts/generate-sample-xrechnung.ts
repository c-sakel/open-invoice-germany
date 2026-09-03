/**
 * Erzeugt Beispiel-E-Rechnungen (ohne DB) und schreibt sie als Datei.
 * Wird im CI vom offiziellen KoSIT-/EN-16931-Validator geprüft.
 *
 * Aufruf: npx tsx scripts/generate-sample-xrechnung.ts [ausgabepfad] [beispiel] [format]
 *   ausgabepfad  Default: tmp/sample-xrechnung.xml
 *   beispiel     Default: "base" (Bestandsregression, unveraendert) — siehe SAMPLE_NAMES
 *   format       "ubl" (Default) | "cii"
 *
 * Ohne Argumente bzw. mit nur ausgabepfad bleibt das Verhalten byte-identisch zum
 * bisherigen Skript (CI-Job xrechnung-kosit ruft es genau so auf).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { validateXRechnung } from "@/lib/einvoice/en16931-core";
import { buildEInvoiceData, type MapInput } from "@/lib/einvoice/mapper";
import { computeLineNet } from "@/lib/pricing/line";
import { computeTaxBreakdown } from "@/lib/tax";
import type { DocumentAdjustments } from "@/lib/pricing/allocate";
import type { EInvoiceData } from "@/lib/einvoice/types";

// Reine "base"-Regression: EXAKT das bisherige Literal (keine Rabatte/Skonto/
// Zahlungsmethode) — bleibt byte-identisch zum Verhalten vor Phase 4a.
const base: EInvoiceData = {
  number: "RE-2026-0001",
  type: "INVOICE",
  issueDate: new Date("2026-06-09"),
  dueDate: new Date("2026-06-23"),
  deliveryDate: new Date("2026-06-01"),
  currency: "EUR",
  buyerReference: "04011000-12345-86",
  paymentTerms: "Zahlbar innerhalb von 14 Tagen ohne Abzug.",
  notes: "Vielen Dank für Ihren Auftrag.",
  seller: {
    name: "Muster Handwerk GmbH",
    addressLine1: "Lindenstr. 5",
    postalCode: "21337",
    city: "Lüneburg",
    countryCode: "DE",
    vatId: "DE123456789",
    email: "info@muster-handwerk.de",
    phone: "+49 4131 999000",
    contactName: "Erika Muster",
  },
  buyer: {
    name: "Beispiel AG",
    addressLine1: "Hafenstr. 12",
    postalCode: "20457",
    city: "Hamburg",
    countryCode: "DE",
    vatId: "DE987654321",
    email: "buchhaltung@beispiel.de",
  },
  lines: [
    { id: "1", description: "Beratung vor Ort", quantityMilli: 3000, unit: "HUR", unitNetPriceCents: 9500, lineNetCents: 28500, taxRate: 19, taxCategory: "S" },
    { id: "2", description: "Wartungspauschale", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 14900, lineNetCents: 14900, taxRate: 19, taxCategory: "S" },
  ],
  taxSubtotals: [{ taxCategory: "S", taxRate: 19, netCents: 43400, taxCents: 8246 }],
  netTotalCents: 43400,
  taxTotalCents: 8246,
  grossTotalCents: 51646,
  payableCents: 51646,
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Muster Bank",
};

// ── Phase 4a: fünf zusätzliche Beispiele, über den echten Mapper (buildEInvoiceData)
// aus rohen Positions-/Beleg-/Skonto-/Zahlungsmethoden-Angaben aufgebaut — derselbe
// Pfad wie bei einer echten Rechnung, damit die Beispiele die Produktionslogik prüfen.
const ORG: MapInput["org"] = {
  legalName: "Muster Handwerk GmbH",
  addressLine1: "Lindenstr. 5",
  addressLine2: null,
  postalCode: "21337",
  city: "Lüneburg",
  country: "DE",
  vatId: "DE123456789",
  taxNumber: null,
  email: "info@muster-handwerk.de",
  phone: "+49 4131 999000",
  electronicAddress: null,
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Muster Bank",
};
const CUSTOMER: MapInput["customer"] = {
  name: "Beispiel AG",
  contactName: null,
  addressLine1: "Hafenstr. 12",
  addressLine2: null,
  postalCode: "20457",
  city: "Hamburg",
  countryCode: "DE",
  vatId: "DE987654321",
  email: "buchhaltung@beispiel.de",
  leitwegId: null,
};

interface SampleLine {
  description: string;
  quantityMilli: number;
  unit: string;
  unitNetPriceCents: number;
  taxRate: number;
  taxCategory: string;
  discountPermille?: number;
  discountCents?: number;
}

function buildSample(opts: {
  number: string;
  lines: SampleLine[];
  adjustments?: DocumentAdjustments;
  documentChargeReason?: string | null;
  skonto1?: { permille: number; days: number };
  skonto2?: { permille: number; days: number };
  paymentMethod?: {
    code: string;
    name: string;
    invoiceText: string | null;
    untdidCode: string;
    bankIban: string | null;
    bankBic: string | null;
    bankName: string | null;
  };
  paidAmountCents?: number;
}): EInvoiceData {
  const lines = opts.lines.map((l) => ({
    ...l,
    lineNetCents: computeLineNet({
      quantityMilli: l.quantityMilli,
      unitNetPriceCents: l.unitNetPriceCents,
      discountPermille: l.discountPermille,
      discountCents: l.discountCents,
    }).lineNetCents,
  }));
  const totals = computeTaxBreakdown(
    lines.map((l) => ({ lineNetCents: l.lineNetCents, taxRate: l.taxRate, taxCategory: l.taxCategory })),
    opts.adjustments,
  );

  const mapInput: MapInput = {
    number: opts.number,
    type: "INVOICE",
    issueDate: new Date("2034-06-09"),
    dueDate: new Date("2034-07-09"),
    deliveryDate: new Date("2034-06-01"),
    currency: "EUR",
    buyerReference: "04011000-12345-86",
    paymentTerms: opts.skonto1 ? null : "Zahlbar innerhalb von 30 Tagen ohne Abzug.",
    notes: "Vielen Dank für Ihren Auftrag.",
    netTotalCents: totals.netTotalCents,
    taxTotalCents: totals.taxTotalCents,
    grossTotalCents: totals.grossTotalCents,
    paidAmountCents: opts.paidAmountCents ?? 0,
    taxBreakdownJson: JSON.stringify(totals.breakdown),
    documentChargeReason: opts.documentChargeReason ?? null,
    skonto1Permille: opts.skonto1?.permille ?? null,
    skonto1Days: opts.skonto1?.days ?? null,
    skonto2Permille: opts.skonto2?.permille ?? null,
    skonto2Days: opts.skonto2?.days ?? null,
    paymentMethodSnapshotJson: opts.paymentMethod ? JSON.stringify(opts.paymentMethod) : null,
    org: ORG,
    customer: CUSTOMER,
    lines: lines.map((l, i) => ({
      id: String(i + 1),
      description: l.description,
      quantityMilli: l.quantityMilli,
      unit: l.unit,
      unitNetPriceCents: l.unitNetPriceCents,
      lineNetCents: l.lineNetCents,
      taxRate: l.taxRate,
      taxCategory: l.taxCategory,
      discountPermille: l.discountPermille,
      discountCents: l.discountCents,
    })),
  };
  return buildEInvoiceData(mapInput);
}

// 1) Positionsrabatt (BG-27): 10 % auf eine einzelne Zeile.
const lineDiscount = () =>
  buildSample({
    number: "RE-2034-0002",
    lines: [
      { description: "Beratung vor Ort", quantityMilli: 3000, unit: "HUR", unitNetPriceCents: 9500, taxRate: 19, taxCategory: "S", discountPermille: 100 },
      { description: "Wartungspauschale", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 14900, taxRate: 19, taxCategory: "S" },
    ],
  });

// 2) Belegrabatt über zwei Steuersätze (19 % und 7 %) — proportionale Verteilung.
const docDiscountTwoRates = () =>
  buildSample({
    number: "RE-2034-0003",
    lines: [
      { description: "Beratung vor Ort", quantityMilli: 3000, unit: "HUR", unitNetPriceCents: 9500, taxRate: 19, taxCategory: "S" },
      { description: "Fachliteratur", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 8000, taxRate: 7, taxCategory: "S" },
    ],
    adjustments: { discountPermille: 100 },
  });

// 3) Belegaufschlag (z. B. Express-Zuschlag) mit Freitext-Grund.
const charge = () =>
  buildSample({
    number: "RE-2034-0004",
    lines: [{ description: "Beratung vor Ort", quantityMilli: 3000, unit: "HUR", unitNetPriceCents: 9500, taxRate: 19, taxCategory: "S" }],
    adjustments: { chargePermille: 50 },
    documentChargeReason: "Express-Zuschlag",
  });

// 4) Skonto mit zwei Zielen (BT-20 #SKONTO#-Syntax).
const skontoTwoTerms = () =>
  buildSample({
    number: "RE-2034-0005",
    lines: [{ description: "Beratung vor Ort", quantityMilli: 3000, unit: "HUR", unitNetPriceCents: 9500, taxRate: 19, taxCategory: "S" }],
    skonto1: { permille: 20, days: 7 },
    skonto2: { permille: 10, days: 14 },
  });

// 5) Barzahlung (CASH, UNTDID 4461 = 10) — KEIN PayeeFinancialAccount (BR-DE-23).
const cash = () =>
  buildSample({
    number: "RE-2034-0006",
    lines: [{ description: "Beratung vor Ort", quantityMilli: 3000, unit: "HUR", unitNetPriceCents: 9500, taxRate: 19, taxCategory: "S" }],
    paymentMethod: { code: "CASH", name: "Barzahlung", invoiceText: "Zahlung bar bei Übergabe.", untdidCode: "10", bankIban: null, bankBic: null, bankName: null },
  });

// Namensraum aller Beispiele. "base" bleibt die reine Bestandsregression.
const SAMPLES: Record<string, () => EInvoiceData> = {
  base: () => base,
  "line-discount": lineDiscount,
  "doc-discount-two-rates": docDiscountTwoRates,
  charge,
  "skonto-two-terms": skontoTwoTerms,
  cash,
};

export const SAMPLE_NAMES = Object.keys(SAMPLES);

function buildXml(data: EInvoiceData, format: string): string {
  return format === "cii" ? buildFacturXCII(data) : buildXRechnungUBL(data);
}

function main(): void {
  const out = process.argv[2] ?? "tmp/sample-xrechnung.xml";
  const sampleName = process.argv[3] ?? "base";
  const format = process.argv[4] ?? "ubl";

  const factory = SAMPLES[sampleName];
  if (!factory) {
    console.error(`Unbekanntes Beispiel "${sampleName}". Bekannt: ${SAMPLE_NAMES.join(", ")}`);
    process.exit(1);
  }
  const data = factory();

  // EN-16931-Kernvalidierung (nur für UBL implementiert — die Rechenregeln sind
  // formatunabhängig, das XML-Cross-Check in en16931-core.ts liest UBL-Tags).
  if (format === "ubl") {
    const xml = buildXRechnungUBL(data);
    const report = validateXRechnung(data, xml);
    if (!report.valid) {
      console.error(`EN-16931-Kernvalidierung fehlgeschlagen (${sampleName}):\n- ` + report.errors.join("\n- "));
      process.exit(1);
    }
  }

  const xml = buildXml(data, format);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, xml, "utf8");
  console.log(`E-Rechnung geschrieben: ${out} (${sampleName}/${format}, EN-16931-Kernregeln ok)`);
}

main();
