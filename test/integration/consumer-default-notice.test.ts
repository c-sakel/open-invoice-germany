/**
 * Verzugshinweis fuer Verbraucher (§ 286 Abs. 3 BGB) in PDF und E-Rechnung (BT-20): Entwurf,
 * festgeschriebener Beleg, archivierte Ausgabe, Einstellung nachtraeglich aus, Geschaeftskunde,
 * Altbeleg ohne Kennzeichen. Testjahr 2231.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { saveDocumentSettings, loadDocumentSettings } from "@/domain/document/settings";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { testPdfTheme, parsePdf } from "../helpers/pdf-theme";
import type { CreateInvoiceInput } from "@/schemas";

const SENTENCE = "Hinweis nach § 286 Abs. 3 BGB: Sie kommen spätestens in Verzug, wenn Sie nicht innerhalb von 30 Tagen nach Fälligkeit und Zugang dieser Rechnung zahlen.";
const FIX = new Date("2231-03-01T10:00:00.000Z");

let tmpDir: string;
let prevArchive: string | undefined;
let orgId: string;
let consumerId: string;
let businessId: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-verzug-"));
  prevArchive = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (
    await dbInternal.organization.create({
      data: { legalName: "Verzug GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE223100001", taxNumber: "22/231/00001" },
    })
  ).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const mk = async (name: string, type: "BUSINESS" | "CONSUMER") =>
    (await dbInternal.customer.create({ data: { orgId, name, addressLine1: "Weg 1", postalCode: "20095", city: "Hamburg", type } })).id;
  consumerId = await mk("Privatkunde", "CONSUMER");
  businessId = await mk("Geschaeftskunde", "BUSINESS");
});

afterAll(async () => {
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function setting(enabled: boolean): Promise<void> {
  const cur = await loadDocumentSettings(orgId);
  await saveDocumentSettings(orgId, { ...cur, consumerDefaultNotice: enabled });
}

function input(customerId: string, extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
  return {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX, deliveryDate: new Date("2231-02-25"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    ...extra,
  } as CreateInvoiceInput;
}

const draft = async (customerId: string, extra: Partial<CreateInvoiceInput> = {}) => (await createDraftInvoice(orgId, input(customerId, extra), { now: FIX })).id;
const norm = (s: string) => s.replace(/\s+/g, " ");

async function pdfOf(id: string): Promise<string> {
  const loaded = await loadEInvoiceData(id, orgId);
  if (!loaded) throw new Error("Beleg fehlt");
  return norm((await parsePdf(await renderInvoicePdf(loaded.data, testPdfTheme()))).text);
}

async function archived(id: string, kind: "PDF" | "UBL" | "CII"): Promise<Buffer> {
  return getArchivedInvoiceFile(orgId, id, kind);
}

describe("Verzugshinweis fuer Verbraucher", () => {
  it("Entwurfs-PDF, festgeschriebenes PDF und archiviertes UBL/CII tragen den Satz bei Verbraucher und aktiver Einstellung", async () => {
    await setting(true);
    const id = await draft(consumerId);
    expect(await pdfOf(id)).toContain(norm(SENTENCE));

    await finalizeInvoice(id, { now: FIX });
    expect(await pdfOf(id)).toContain(norm(SENTENCE));

    const ubl = (await archived(id, "UBL")).toString("utf8");
    const cii = (await archived(id, "CII")).toString("utf8");
    expect(ubl).toContain(SENTENCE);
    expect(cii).toContain(SENTENCE);
    expect(norm((await parsePdf(await archived(id, "PDF"))).text)).toContain(norm(SENTENCE));
  });

  it("Einstellung danach aus: archivierte und neu geladene Ausgabe bleiben unveraendert", async () => {
    await setting(true);
    const id = await draft(consumerId);
    await finalizeInvoice(id, { now: FIX });
    const ublBefore = await archived(id, "UBL");
    await setting(false);
    expect(Buffer.compare(await archived(id, "UBL"), ublBefore)).toBe(0);
    expect(await pdfOf(id)).toContain(norm(SENTENCE));
    const loaded = await loadEInvoiceData(id, orgId);
    expect(loaded?.data.consumerDefaultNotice).toBe(true);
    expect(loaded?.data.paymentTermsNote?.split("\n").at(-1)).toBe(SENTENCE);
  });

  it("Geschaeftskunde ohne Vorgabe: kein Satz; Vorgabe 'immer' erzwingt ihn, Vorgabe 'nie' unterdrueckt ihn", async () => {
    await setting(true);
    const biz = await draft(businessId);
    expect(await pdfOf(biz)).not.toContain("§ 286");
    const forced = await draft(businessId, { consumerDefaultNotice: true });
    expect(await pdfOf(forced)).toContain(norm(SENTENCE));
    const never = await draft(consumerId, { consumerDefaultNotice: false });
    expect(await pdfOf(never)).not.toContain("§ 286");
  });

  it("Altbeleg (festgeschrieben, NULL) bekommt auch bei aktiver Einstellung keinen Satz", async () => {
    await setting(false);
    const id = await draft(consumerId);
    await finalizeInvoice(id, { now: FIX });
    await setting(true);
    // Alt-Zustand nachstellen: Spalte NULL (Belege vor Einfuehrung der Spalte).
    await dbInternal.$executeRaw`UPDATE "Invoice" SET "consumerDefaultNotice" = NULL WHERE "id" = ${id}`;
    const loaded = await loadEInvoiceData(id, orgId);
    expect(loaded?.data.consumerDefaultNotice).toBeUndefined();
    expect(loaded?.data.paymentTermsNote ?? "").not.toContain("§ 286");
    expect(await pdfOf(id)).not.toContain("§ 286");
  });
});
