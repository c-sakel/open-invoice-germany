/**
 * Phase 16b, Task 8: Kurs und EUR-Betraege einer festgeschriebenen USD-Rechnung bleiben im
 * Archiv (PDF und CII) stabil, auch wenn der Monatskurs danach korrigiert wird.
 * Eigenes Testjahr (2111): Invoice.number und ExchangeRate sind instanzweit eindeutig.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { upsertManualRate } from "@/domain/fx/store";
import { createInvoiceSchema } from "@/schemas";
import { exchangeRateUpsertSchema } from "@/schemas/fx";
import { sha256Hex } from "@/lib/archive/storage";
import { parsePdf } from "../helpers/pdf-theme";

const NOW = new Date("2111-03-20T10:00:00.000Z");
const DELIVERY = new Date("2111-03-12T00:00:00.000Z");

let orgId: string;
let customerId: string;
let tmpDir: string;
let prevEnv: string | undefined;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-fx-archive-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Archiv Kurs GmbH", addressLine1: "Kursweg 1", postalCode: "10115", city: "Berlin", vatId: "DE211121101", taxNumber: "21/111/00000" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await dbInternal.documentSettings.upsert({ where: { orgId }, create: { orgId, fxRateSource: "BMF_MONTHLY" }, update: { fxRateSource: "BMF_MONTHLY" } });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 2111 } },
    create: { orgId, docType: "INVOICE", year: 2111, currentValue: 0, prefix: "FXA-", pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: {},
  });
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Overseas Ltd", addressLine1: "1 Main Street", postalCode: "10001", city: "Dublin", type: "BUSINESS" } })).id;
  await upsertManualRate(exchangeRateUpsertSchema.parse({ source: "MONTHLY", currency: "USD", rateDate: "2111-03-01", rate: "1,1214" }), "test", orgId);
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Archiv einer Fremdwaehrungsrechnung", () => {
  it("Kursaenderung nach dem Archivieren laesst PDF und CII unveraendert; die Kurszeile zeigt den alten Kurs", async () => {
    const draft = await createDraftInvoice(
      orgId,
      createInvoiceSchema.parse({
        customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "USD", issueDate: NOW, deliveryDate: DELIVERY,
        lines: [{ description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 11214, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      }),
      { now: NOW },
    );
    await finalizeInvoice(draft.id, { now: NOW });
    const pdf = await getArchivedInvoiceFile(orgId, draft.id, "PDF");
    const cii = await getArchivedInvoiceFile(orgId, draft.id, "CII");
    const before = await dbInternal.archivedDocument.findMany({ where: { invoiceId: draft.id }, select: { kind: true, sha256: true }, orderBy: { kind: "asc" } });
    expect((await parsePdf(pdf)).text).toContain("Umrechnungskurs: 1 EUR = 1,1214 USD (Monatsdurchschnittskurs März 2111)");

    await upsertManualRate(exchangeRateUpsertSchema.parse({ source: "MONTHLY", currency: "USD", rateDate: "2111-03-01", rate: "1,3000" }), "test", orgId);

    const pdfAfter = await getArchivedInvoiceFile(orgId, draft.id, "PDF");
    const ciiAfter = await getArchivedInvoiceFile(orgId, draft.id, "CII");
    expect(sha256Hex(pdfAfter)).toBe(sha256Hex(pdf));
    expect(sha256Hex(ciiAfter)).toBe(sha256Hex(cii));
    expect(await dbInternal.archivedDocument.findMany({ where: { invoiceId: draft.id }, select: { kind: true, sha256: true }, orderBy: { kind: "asc" } })).toEqual(before);
    const text = (await parsePdf(pdfAfter)).text;
    expect(text).toContain("1 EUR = 1,1214 USD");
    expect(text).not.toContain("1,3000");
  });
});
