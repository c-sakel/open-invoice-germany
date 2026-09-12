import { describe, it, expect } from "vitest";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { validateXRechnung } from "@/lib/einvoice/en16931-core";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { testPdfTheme } from "../helpers/pdf-theme";
import type { EInvoiceData } from "@/lib/einvoice/types";

const data: EInvoiceData = {
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
    name: "Test GmbH",
    addressLine1: "Hauptstr. 1",
    postalCode: "21339",
    city: "Lüneburg",
    countryCode: "DE",
    vatId: "DE123456789",
    email: "info@test.de",
    phone: "+49 4131 100",
    contactName: "Max Mustermann",
  },
  buyer: {
    name: "Kunde AG",
    addressLine1: "Marktplatz 2",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE",
    vatId: "DE987654321",
    email: "einkauf@kunde.de",
  },
  lines: [
    { id: "1", description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, lineNetCents: 20000, taxRate: 19, taxCategory: "S" },
    { id: "2", description: "Hosting", quantityMilli: 1000, unit: "MON", unitNetPriceCents: 5000, lineNetCents: 5000, taxRate: 19, taxCategory: "S" },
  ],
  taxSubtotals: [{ taxCategory: "S", taxRate: 19, netCents: 25000, taxCents: 4750 }],
  netTotalCents: 25000,
  taxTotalCents: 4750,
  grossTotalCents: 29750,
  payableCents: 29750,
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Test Bank",
};

describe("XRechnung / EN 16931", () => {
  it("erzeugt wohlgeformtes UBL mit Pflicht-Headern", () => {
    const xml = buildXRechnungUBL(data);
    // CustomizationID muss den XRechnung-3.0-Namespace (xeinkauf.de) tragen — sonst BR-DE-21.
    expect(xml).toContain("urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0");
    expect(xml).toContain("<cbc:ID>RE-2026-0001</cbc:ID>");
    expect(xml).toContain("<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(xml).toContain("DE123456789");
    expect(xml).toContain("<cbc:PayableAmount currencyID=\"EUR\">297.50</cbc:PayableAmount>");
  });

  it("besteht die EN-16931-Kernregeln", () => {
    const xml = buildXRechnungUBL(data);
    const result = validateXRechnung(data, xml);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("erkennt eine Rechensummen-Verletzung (BR-CO-15)", () => {
    const bad = { ...data, grossTotalCents: 99999 };
    const xml = buildXRechnungUBL(bad);
    const result = validateXRechnung(bad, xml);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/BR-CO-15/);
  });

  it("emittiert Steuernummer (BT-32 / FC) für Verkäufer ohne USt-IdNr. (Kleinunternehmer)", () => {
    const ku: EInvoiceData = { ...data, seller: { ...data.seller, vatId: null, taxNumber: "33/123/45678" } };
    const xml = buildXRechnungUBL(ku);
    expect(xml).toContain("<cbc:ID>FC</cbc:ID>");
    expect(xml).toContain("33/123/45678");
    expect(validateXRechnung(ku, xml).errors).toEqual([]);
  });

  it("erkennt einen Beleg nur mit HEADING-Zeile als Verletzung von BR-16 (keine ITEM-Position)", () => {
    // Commit 0 (Task-4-Review): BR-16 muss die ITEM-Zeilen zaehlen, nicht data.lines.length —
    // eine reine Gliederungszeile (HEADING, §8) darf nicht als "Rechnungsposition" durchgehen.
    const headingOnly: EInvoiceData = {
      ...data,
      lines: [{ id: "1", description: "Ueberschrift", quantityMilli: 0, unit: "C62", unitNetPriceCents: 0, lineNetCents: 0, taxRate: 0, taxCategory: "S", lineType: "HEADING" }],
    };
    const xml = buildXRechnungUBL(headingOnly);
    const result = validateXRechnung(headingOnly, xml);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/BR-16/);
  });

  it("erkennt Verkäufer ohne jegliche Steuer-ID (BR-CO-26)", () => {
    const bad: EInvoiceData = { ...data, seller: { ...data.seller, vatId: null, taxNumber: null } };
    const result = validateXRechnung(bad, buildXRechnungUBL(bad));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/BR-CO-26/);
  });

  it("platziert cac:Delivery nach den Parteien und vor TaxTotal (UBL-Reihenfolge)", () => {
    const xml = buildXRechnungUBL(data);
    const customerIdx = xml.indexOf("<cac:AccountingCustomerParty>");
    const deliveryIdx = xml.indexOf("<cac:Delivery>");
    const taxTotalIdx = xml.indexOf("<cac:TaxTotal>");
    expect(deliveryIdx).toBeGreaterThan(customerIdx);
    expect(deliveryIdx).toBeLessThan(taxTotalIdx);
  });

  it("erzeugt für Storno ein UBL CreditNote-Dokument (381, positive Beträge, BillingReference)", () => {
    const credit: EInvoiceData = {
      ...data,
      number: "GS-2026-0001",
      type: "CREDIT_NOTE",
      precedingInvoiceNumber: "RE-2026-0001",
      precedingInvoiceDate: new Date("2026-06-09"),
      lines: data.lines.map((l) => ({ ...l, unitNetPriceCents: -l.unitNetPriceCents, lineNetCents: -l.lineNetCents })),
      taxSubtotals: data.taxSubtotals.map((t) => ({ ...t, netCents: -t.netCents, taxCents: -t.taxCents })),
      netTotalCents: -data.netTotalCents,
      taxTotalCents: -data.taxTotalCents,
      grossTotalCents: -data.grossTotalCents,
      payableCents: -data.payableCents,
    };
    const xml = buildXRechnungUBL(credit);
    expect(xml).toContain("<CreditNote");
    expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(xml).toContain("<cac:CreditNoteLine>");
    expect(xml).toContain("<cbc:CreditedQuantity");
    expect(xml).toContain("RE-2026-0001"); // BillingReference auf Original
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">297.50</cbc:PayableAmount>'); // positiv
    expect(validateXRechnung(credit, xml).errors).toEqual([]);
  });

  it("BT-9 (Fälligkeit) bei Gutschriften: kein cbc:DueDate auf Dokumentebene (UBL-CreditNote-XSD kennt es nicht — cvc-complex-type.2.4.a), stattdessen cac:PaymentMeans/cbc:PaymentDueDate direkt nach PaymentMeansCode", () => {
    const credit: EInvoiceData = {
      ...data,
      number: "GS-2026-0001",
      type: "CREDIT_NOTE",
      precedingInvoiceNumber: "RE-2026-0001",
      precedingInvoiceDate: new Date("2026-06-09"),
    };
    const xml = buildXRechnungUBL(credit);
    expect(xml).not.toContain("<cbc:DueDate>");
    const pmIdx = xml.indexOf("<cac:PaymentMeans>");
    const codeIdx = xml.indexOf("<cbc:PaymentMeansCode>");
    const dueIdx = xml.indexOf("<cbc:PaymentDueDate>2026-06-23</cbc:PaymentDueDate>");
    const acctIdx = xml.indexOf("<cac:PayeeFinancialAccount>");
    expect(dueIdx).toBeGreaterThan(pmIdx);
    expect(dueIdx).toBeGreaterThan(codeIdx);
    expect(dueIdx).toBeLessThan(acctIdx);
    expect(validateXRechnung(credit, xml).errors).toEqual([]);
  });

  it("BT-9 bei einer normalen Rechnung bleibt unveraendert: cbc:DueDate auf Dokumentebene, KEIN PaymentMeans/PaymentDueDate", () => {
    const xml = buildXRechnungUBL(data);
    expect(xml).toContain("<cbc:DueDate>2026-06-23</cbc:DueDate>");
    expect(xml).not.toContain("<cbc:PaymentDueDate>");
  });
});

describe("ZUGFeRD / Factur-X (CII)", () => {
  it("erzeugt EN-16931-CII mit korrektem Profil + TypeCode", () => {
    const xml = buildFacturXCII(data);
    expect(xml).toContain("<rsm:CrossIndustryInvoice");
    expect(xml).toContain("urn:cen.eu:en16931:2017");
    expect(xml).toContain("<ram:TypeCode>380</ram:TypeCode>");
    expect(xml).toContain("DE123456789"); // Verkäufer-USt-IdNr.
  });

  it("bettet die factur-x.xml in ein gültiges PDF ein", async () => {
    const pdf = await renderZugferdPdf(data, testPdfTheme());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("factur-x.xml");
  });
});

describe("BG-14 / BT-80 (Phase 12b)", () => {
  const period = { deliveryStart: new Date("2026-05-01"), deliveryEnd: new Date("2026-05-31") };
  it("UBL: InvoicePeriod nur mit Zeitraum, nach BuyerReference und vor den Parteien", () => {
    const xml = buildXRechnungUBL({ ...data, ...period });
    expect(xml).toContain("<cbc:StartDate>2026-05-01</cbc:StartDate>");
    expect(xml).toContain("<cbc:EndDate>2026-05-31</cbc:EndDate>");
    expect(xml.indexOf("<cbc:BuyerReference>")).toBeLessThan(xml.indexOf("<cac:InvoicePeriod>"));
    expect(xml.indexOf("<cac:InvoicePeriod>")).toBeLessThan(xml.indexOf("<cac:AccountingSupplierParty>"));
    expect(buildXRechnungUBL(data)).not.toContain("<cac:InvoicePeriod>");
  });
  it("UBL: BT-80 aus dem Kaeuferland, nach ActualDeliveryDate; ueberschreibbar", () => {
    const xml = buildXRechnungUBL(data);
    // Hinweis (Abweichung vom Brief): root.end({ prettyPrint: true }) fuegt zwischen Country
    // und seinem einzigen Kindelement stets Zeilenumbruch/Einrueckung ein — \s* toleriert das,
    // die Verschachtelung (DeliveryLocation > ... > Country > IdentificationCode = DE) bleibt geprueft.
    expect(xml).toMatch(/<cac:DeliveryLocation>[\s\S]*<cac:Country>\s*<cbc:IdentificationCode>DE<\/cbc:IdentificationCode>\s*<\/cac:Country>/);
    expect(xml.indexOf("<cbc:ActualDeliveryDate>")).toBeLessThan(xml.indexOf("<cac:DeliveryLocation>"));
    expect(buildXRechnungUBL({ ...data, deliverToCountryCode: "AT" }))
      .toMatch(/<cac:DeliveryLocation>[\s\S]*<cbc:IdentificationCode>AT<\/cbc:IdentificationCode>/);
  });
  it("CII: ShipToTradeParty vor ActualDeliverySupplyChainEvent, BillingSpecifiedPeriod an der richtigen Stelle", () => {
    const xml = buildFacturXCII({ ...data, ...period });
    expect(xml.indexOf("<ram:ShipToTradeParty>")).toBeLessThan(xml.indexOf("<ram:ActualDeliverySupplyChainEvent>"));
    expect(xml).toMatch(/<ram:ShipToTradeParty>[\s\S]*<ram:CountryID>DE<\/ram:CountryID>/);
    expect(xml.indexOf("<ram:ApplicableTradeTax>")).toBeLessThan(xml.indexOf("<ram:BillingSpecifiedPeriod>"));
    expect(xml.indexOf("<ram:BillingSpecifiedPeriod>")).toBeLessThan(xml.indexOf("<ram:SpecifiedTradePaymentTerms>"));
  });
});

describe("BG-13/BG-15 — eigene Lieferanschrift (Phase 14a, Task 5)", () => {
  // Stadt bewusst NICHT "Hamburg" (= data.buyer.city) — sonst faende ein content-basierter
  // indexOf-Vergleich das FALSCHE (fruehere) Vorkommen in der Kaeuferadresse.
  const deliverTo: NonNullable<EInvoiceData["deliverTo"]> = {
    name: "Lager Nord",
    addressLine1: "Industriestr. 9",
    addressLine2: "Halle 3",
    postalCode: "22525",
    city: "Bremen",
    countryCode: "AT",
  };
  const withShipping: EInvoiceData = { ...data, deliverTo, deliverToCountryCode: deliverTo.countryCode };

  it("UBL: ohne Lieferanschrift bleibt die Ausgabe byte-gleich zum Bestand (DeliveryLocation ohne StreetName, keine DeliveryParty)", () => {
    // cbc:StreetName existiert schon heute in Seller-/BuyerTradeParty (appendParty) — der
    // Regressionscheck muss daher auf den DeliveryLocation-Ausschnitt beschraenkt sein.
    const xml = buildXRechnungUBL(data);
    const locStart = xml.indexOf("<cac:DeliveryLocation>");
    const locEnd = xml.indexOf("</cac:DeliveryLocation>");
    expect(xml.slice(locStart, locEnd)).not.toContain("<cbc:StreetName>");
    expect(xml).not.toContain("<cac:DeliveryParty>");
  });

  it("UBL: mit Lieferanschrift StreetName/AdditionalStreetName/CityName/PostalZone/Country (BT-75/76/77/78/80) in DeliveryLocation, DeliveryParty mit Name (BT-70) danach", () => {
    const xml = buildXRechnungUBL(withShipping);
    const streetIdx = xml.indexOf("<cbc:StreetName>Industriestr. 9</cbc:StreetName>");
    const addStreetIdx = xml.indexOf("<cbc:AdditionalStreetName>Halle 3</cbc:AdditionalStreetName>");
    const cityIdx = xml.indexOf("<cbc:CityName>Bremen</cbc:CityName>");
    const zoneIdx = xml.indexOf("<cbc:PostalZone>22525</cbc:PostalZone>");
    const countryIdx = xml.indexOf("<cbc:IdentificationCode>AT</cbc:IdentificationCode>");
    const partyIdx = xml.indexOf("<cac:DeliveryParty>");
    const nameIdx = xml.indexOf("<cbc:Name>Lager Nord</cbc:Name>");
    expect(streetIdx).toBeGreaterThan(-1);
    expect(addStreetIdx).toBeGreaterThan(streetIdx);
    expect(cityIdx).toBeGreaterThan(addStreetIdx);
    expect(zoneIdx).toBeGreaterThan(cityIdx);
    expect(countryIdx).toBeGreaterThan(zoneIdx);
    expect(partyIdx).toBeGreaterThan(countryIdx);
    expect(nameIdx).toBeGreaterThan(partyIdx);
    expect(validateXRechnung(withShipping, xml).errors).toEqual([]);
  });

  it("UBL: ohne Label (name null) bleibt cac:DeliveryParty aus", () => {
    const xml = buildXRechnungUBL({ ...withShipping, deliverTo: { ...deliverTo, name: null } });
    expect(xml).not.toContain("<cac:DeliveryParty>");
  });

  it("CII: ohne Lieferanschrift bleibt die Ausgabe byte-gleich (ShipToTradeParty ohne LineOne/Name)", () => {
    // ram:LineOne existiert schon heute in Seller-/BuyerTradeParty (appendAddress) — der
    // Regressionscheck muss daher auf den ShipToTradeParty-Ausschnitt beschraenkt sein.
    const xml = buildFacturXCII(data);
    const shipStart = xml.indexOf("<ram:ShipToTradeParty>");
    const shipEnd = xml.indexOf("</ram:ShipToTradeParty>");
    const shipToXml = xml.slice(shipStart, shipEnd);
    expect(shipToXml).not.toContain("<ram:LineOne>");
    expect(shipToXml).not.toContain("<ram:Name>");
  });

  it("CII: mit Lieferanschrift Name (BT-70) vor PostalTradeAddress, LineOne/LineTwo/CityName/CountryID vor ActualDeliverySupplyChainEvent", () => {
    const xml = buildFacturXCII(withShipping);
    const nameIdx = xml.indexOf("<ram:Name>Lager Nord</ram:Name>");
    // ram:PostalTradeAddress existiert auch bei Seller-/BuyerTradeParty (frueher im
    // Dokument) — Suche ab nameIdx, um sicher das ShipToTradeParty-Vorkommen zu treffen.
    const addrIdx = xml.indexOf("<ram:PostalTradeAddress>", nameIdx);
    const lineOneIdx = xml.indexOf("<ram:LineOne>Industriestr. 9</ram:LineOne>");
    const lineTwoIdx = xml.indexOf("<ram:LineTwo>Halle 3</ram:LineTwo>");
    const cityIdx = xml.indexOf("<ram:CityName>Bremen</ram:CityName>");
    const countryIdx = xml.indexOf("<ram:CountryID>AT</ram:CountryID>");
    const eventIdx = xml.indexOf("<ram:ActualDeliverySupplyChainEvent>");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(addrIdx).toBeGreaterThan(nameIdx);
    expect(lineOneIdx).toBeGreaterThan(addrIdx);
    expect(lineTwoIdx).toBeGreaterThan(lineOneIdx);
    expect(cityIdx).toBeGreaterThan(lineTwoIdx);
    expect(countryIdx).toBeGreaterThan(cityIdx);
    expect(eventIdx).toBeGreaterThan(countryIdx);
  });
});

describe("§ 14b-Aufbewahrungshinweis (Phase 12b, Task 5)", () => {
  it("§ 14b-Hinweis erscheint als eigener Note in UBL und CII, sonst nicht", () => {
    const hint = "Sie sind verpflichtet, diese Rechnung zwei Jahre aufzubewahren (§ 14b Abs. 1 Satz 5 UStG).";
    expect(buildXRechnungUBL({ ...data, consumerRetentionHint: true })).toContain(hint);
    expect(buildFacturXCII({ ...data, consumerRetentionHint: true })).toContain(hint);
    expect(buildXRechnungUBL(data)).not.toContain("§ 14b Abs. 1 Satz 5");
  });
});

describe("Betreff als BT-22-Note mit Subjektcode BT-21 AAI (Phase 13b, Task 5)", () => {
  // Die Fixture `data` traegt `paymentTerms`, das (unabhaengig vom Betreff) selbst ein
  // eigenes <cbc:Note> unter <cac:PaymentTerms> erzeugt (BT-20, kein BT-22) — fuer die
  // reinen BT-22-Zaehltests hier neutralisiert, damit /<cbc:Note>/g nur die
  // Dokumentebene-Notes (BG-1) zaehlt, nicht die (gleichnamige) Zahlungsbedingungs-Note.
  const noPaymentTerms = { paymentTerms: null, paymentTermsNote: null };

  it("UBL: Betreff als zusaetzliches cbc:Note mit #AAI#-Praefix", () => {
    const xml = buildXRechnungUBL({ ...data, ...noPaymentTerms, notes: "Danke.", subject: "Wartung Anlage 4711" });
    expect(xml).toContain("<cbc:Note>#AAI#Wartung Anlage 4711</cbc:Note>");
    expect(xml).toContain("<cbc:Note>Danke.</cbc:Note>"); // Bestandsnote unveraendert
    expect(xml.match(/<cbc:Note>/g)).toHaveLength(2);
  });
  it("CII: ram:IncludedNote mit ram:Content vor ram:SubjectCode", () => {
    const xml = buildFacturXCII({ ...data, subject: "Wartung Anlage 4711" });
    // prettyPrint:true fuegt Zeilenumbrueche/Einrueckung zwischen den Elementen ein —
    // Reihenfolge (Content VOR SubjectCode) ist der eigentliche Pruefgegenstand (XSD).
    expect(xml).toMatch(/<ram:IncludedNote>\s*<ram:Content>Wartung Anlage 4711<\/ram:Content>\s*<ram:SubjectCode>AAI<\/ram:SubjectCode>\s*<\/ram:IncludedNote>/);
  });
  it("ohne Betreff entsteht kein zusaetzliches Element", () => {
    expect(buildXRechnungUBL(data)).toBe(buildXRechnungUBL({ ...data, subject: null }));
    expect(buildFacturXCII(data)).toBe(buildFacturXCII({ ...data, subject: "" }));
  });
  it("Pflichthinweis und § 14b-Note bleiben eigene Elemente", () => {
    const xml = buildXRechnungUBL({ ...data, ...noPaymentTerms, subject: "S", consumerRetentionHint: true });
    expect(xml.match(/<cbc:Note>/g)).toHaveLength(3); // notes + Betreff + Aufbewahrungshinweis
  });
  it("Nachtrag Task 7: nur Whitespace zaehlt wie leer (getrimmt)", () => {
    expect(buildXRechnungUBL(data)).toBe(buildXRechnungUBL({ ...data, subject: "   " }));
    expect(buildFacturXCII(data)).toBe(buildFacturXCII({ ...data, subject: "\t\n  " }));
  });
  it("Nachtrag Task 7: Betreff wird vor der Ausgabe getrimmt (fuehrend/nachgestellt)", () => {
    const xml = buildXRechnungUBL({ ...data, ...noPaymentTerms, subject: "  Wartung  " });
    expect(xml).toContain("<cbc:Note>#AAI#Wartung</cbc:Note>");
    const cii = buildFacturXCII({ ...data, subject: "  Wartung  " });
    expect(cii).toContain("<ram:Content>Wartung</ram:Content>");
  });
  it("Nachtrag Task 7: Sonderzeichen im Betreff werden XML-escaped (&, <, Umlaute)", () => {
    const subject = "Wartung & Reparatur <Anlage> für Müller";
    const xml = buildXRechnungUBL({ ...data, ...noPaymentTerms, subject });
    expect(xml).toContain("<cbc:Note>#AAI#Wartung &amp; Reparatur &lt;Anlage&gt; für Müller</cbc:Note>");
    expect(xml).not.toContain("<Anlage>");
    const cii = buildFacturXCII({ ...data, subject });
    expect(cii).toContain("<ram:Content>Wartung &amp; Reparatur &lt;Anlage&gt; für Müller</ram:Content>");
    expect(cii).not.toContain("<Anlage>");
  });
});
