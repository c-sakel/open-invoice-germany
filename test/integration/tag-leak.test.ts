/**
 * Phase 13d, Task 6 (Koordinator-Nachtrag Punkt 1, DoD-Lecktests) — Tags sind reine
 * interne Metadaten (src/domain/tag/*, src/schemas/tag.ts) und duerfen NIE in einer nach
 * aussen gehenden Ausgabe auftauchen: PDF, XRechnung-/ZUGFeRD-XML, Kunden-Mail,
 * oeffentlicher Angebots-Annahmelink. Je ein Regressionstest. Die Vorlagen-Variante
 * ("keine internen Notizen", §48) existiert bereits — test/integration/templates.test.ts,
 * "interne Notizen landen nicht in der Vorlage" — und wird hier nicht dupliziert.
 *
 * Keiner der vier Generatoren importiert `src/domain/tag`/`DocumentTag` (verifiziert) —
 * diese Tests sind reine Regressionssicherung gegen eine spaetere, unbedachte Verdrahtung,
 * kein Fund eines bestehenden Lecks. Testjahr 2093 (Testjahr-Konvention) — 2091/2092
 * waren trotz erster Pruefung bereits belegt (tag-filter.test.ts/reporting-revenue.test.ts
 * nutzen Date.UTC(2091,…), dashboard-overview.test.ts new Date(2092,…) — ein reiner Grep
 * auf ISO-Datumsstrings findet solche Konstruktor-Aufrufe nicht, siehe Nachbesserung).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import type { Tag } from "@/generated/prisma/client";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createBusinessDocument } from "@/domain/document/create";
import { createInvoiceSchema, type CreateInvoiceInput, type CreateDocumentInput } from "@/schemas";
import { saveTag } from "@/domain/tag/manage";
import { tagDocument } from "@/domain/tag/assign";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { testPdfTheme, parsePdf } from "../helpers/pdf-theme";
import { saveMailSettings } from "@/domain/email/settings";
import { prefillEmail } from "@/domain/email/compose";
import { sendDocumentEmail } from "@/domain/email/send";
import { createMemoryProvider } from "@/lib/mail/memory";
import type { SendEmailRawInput } from "@/schemas/email";
import { createShareLink, resolveShareToken } from "@/domain/quote-share/link";

const FIX_DATE = new Date("2093-06-09T10:00:00.000Z");
// Ungewoehnlicher, garantiert nirgends sonst im Beleg vorkommender Tag-Name — jeder Fund
// im gerenderten Text/XML/Mailinhalt waere eindeutig ein Leck, kein Zufallstreffer.
const TAG_NAME = "GEHEIM-INTERN-NIEMALS-SICHTBAR";

let orgId: string;
let customerId: string;
let tag: Tag;

beforeAll(async () => {
  // createShareLink verschluesselt das Token-Secret (AES-GCM, src/lib/crypto/secrets.ts).
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";

  const org = await dbInternal.organization.create({
    data: { legalName: "Tag-Leck Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999996", taxNumber: "1" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Tag-Leck-Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" },
  });
  customerId = customer.id;

  await saveMailSettings(orgId, {
    host: "localhost",
    port: 2525,
    security: "NONE",
    fromName: "Tag-Leck Test GmbH",
    fromEmail: "rechnung@example.org",
    defaultBcc: "",
    copyToSelf: false,
    defaultCc: "",
  });

  tag = await saveTag(orgId, null, { name: TAG_NAME });
});

async function makeTaggedInvoice() {
  const draft = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: FIX_DATE,
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 }],
    } as CreateInvoiceInput),
  );
  const finalized = await finalizeInvoice(draft.id, { now: FIX_DATE });
  await tagDocument(orgId, tag.id, { docType: "INVOICE", docId: finalized.id });
  return finalized;
}

describe("Tags erscheinen in keiner nach aussen gehenden Ausgabe", () => {
  it("PDF: Tagname erscheint nicht im gerenderten Rechnungstext", async () => {
    const invoice = await makeTaggedInvoice();
    const loaded = await loadEInvoiceData(invoice.id);
    expect(loaded).not.toBeNull();

    const pdf = await renderInvoicePdf(loaded!.data, testPdfTheme());
    const parsed = await parsePdf(pdf);
    expect(parsed.text).not.toContain(TAG_NAME);
  });

  it("XRechnung/ZUGFeRD-XML: Tagname erscheint in keinem der beiden Exporte", async () => {
    const invoice = await makeTaggedInvoice();
    const loaded = await loadEInvoiceData(invoice.id);
    expect(loaded).not.toBeNull();

    const ubl = buildXRechnungUBL(loaded!.data);
    const cii = buildFacturXCII(loaded!.data);
    expect(ubl).not.toContain(TAG_NAME);
    expect(cii).not.toContain(TAG_NAME);
  });

  it("Kunden-Mail: Tagname erscheint weder in Betreff noch im Text der gesendeten Mail", async () => {
    const invoice = await makeTaggedInvoice();
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoice.id });
    const memProvider = createMemoryProvider();
    const input: SendEmailRawInput = {
      docType: "INVOICE",
      docId: invoice.id,
      to: pre.to.join(", "),
      cc: pre.cc.join(", "),
      bcc: pre.bcc.join(", "),
      subject: pre.subject,
      body: pre.body,
      signature: pre.signature,
      copyToSelf: pre.copyToSelf,
      standardAttachments: pre.attachments.map((a) => a.filename),
      templateId: pre.templateId,
      warnings: pre.warnings,
    };
    const res = await sendDocumentEmail(orgId, "system", input, [], memProvider);
    expect(res.status).toBe("SENT");
    expect(memProvider.sent).toHaveLength(1);
    expect(memProvider.sent[0].subject).not.toContain(TAG_NAME);
    expect(memProvider.sent[0].text).not.toContain(TAG_NAME);
  });

  it("Oeffentlicher Angebotslink: Tagname erscheint nicht in den fuer die Seite geladenen Angebotsdaten", async () => {
    const quote = await createBusinessDocument(
      orgId,
      {
        kind: "ANGEBOT",
        customerId,
        taxScheme: "REGULAR",
        currency: "EUR",
        lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0 }],
      } as CreateDocumentInput,
      { now: FIX_DATE },
    );
    await tagDocument(orgId, tag.id, { docType: "QUOTE", docId: quote.id });

    const { token } = await createShareLink(orgId, quote.id, {}, { now: FIX_DATE });
    const resolved = await resolveShareToken(token, FIX_DATE);
    expect(resolved).not.toBeNull();
    // resolveShareToken laedt exakt die Daten, die die oeffentliche Seite (src/app/angebot/
    // [token]/page.tsx) rendert (lines/org/customer) -- kein Tag-Join, siehe loadQuoteForShare.
    expect(JSON.stringify(resolved!.quote)).not.toContain(TAG_NAME);
  });
});
