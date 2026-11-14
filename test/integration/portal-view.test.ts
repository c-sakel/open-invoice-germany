/**
 * Portalansicht (Whitelist), Archiv-Downloads, Abrufprotokoll und Aufbewahrung. Eigenes Jahr 2196.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createDunning } from "@/domain/dunning/create";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { ArchiveTamperedError } from "@/domain/errors";
import { savePortalSettings } from "@/domain/portal/settings";
import { createPortalLink, resolvePortalToken, type ResolvedPortalLink } from "@/domain/portal/link";
import { isVisible, loadPortalView } from "@/domain/portal/view";
import { getPortalFile } from "@/domain/portal/files";
import { recordPortalEvent } from "@/domain/portal/events";
import { PORTAL_EVENT_RETENTION_MS, runCleanupJob } from "@/domain/scheduler/cleanup";
import { createInvoiceSchema, type CreateInvoiceInput } from "@/schemas";

const MARKER = "GEHEIM-INTERN";
const BASE = "https://rechnung.example.org";
const FIX = new Date("2196-03-01T10:00:00.000Z");
const LATER = new Date("2196-06-01T10:00:00.000Z");
const NOW = new Date("2196-06-15T10:00:00.000Z");
const SHA = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let tmpDir: string;
let prevEnv: string | undefined;
let orgId = "";
let otherOrgId = "";
let k1 = "";
let k2 = "";
let linkK1: ResolvedPortalLink;
let invOpen = "";
let invPaidPart = "";
let invCancelled = "";
let invUsd = "";
let invK2 = "";
let invDraft = "";
let dunningSent = "";
let dunningUnsent = "";
let dunningK2 = "";

function input(customerId: string, currency = "EUR", priceCents = 10000): CreateInvoiceInput {
  return createInvoiceSchema.parse({
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency,
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX, deliveryDate: new Date("2196-02-25"),
    notes: MARKER, internalReference: MARKER,
    ...(currency === "EUR" ? {} : { fxOverrideRate: "1,1" }),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: priceCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  });
}

async function finalized(customerId: string, currency = "EUR", priceCents = 10000): Promise<string> {
  const d = await createDraftInvoice(orgId, input(customerId, currency, priceCents), { now: FIX });
  return (await finalizeInvoice(d.id, { now: FIX })).id;
}

async function mailSent(docId: string, status = "SENT"): Promise<void> {
  await dbInternal.emailLog.create({
    data: { orgId, docType: "DUNNING", docId, subject: "Mahnung", bodySnapshot: "x", status },
  });
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-portal-view-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const mkOrg = async (n: string) =>
    (
      await dbInternal.organization.create({
        data: { legalName: n, addressLine1: "Weg 1", postalCode: "21339", city: "Teststadt", vatId: "DE123456789", taxNumber: "33/123/45678" },
        select: { id: true },
      })
    ).id;
  orgId = await mkOrg("Portal-Ansicht GmbH");
  otherOrgId = await mkOrg("Portal-Fremd Ansicht GmbH");
  await ensureOrgMasterdata(dbInternal, orgId);
  const mkCustomer = async (name: string, notes?: string) =>
    (
      await dbInternal.customer.create({
        data: { orgId, name, addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", notes: notes ?? null },
        select: { id: true },
      })
    ).id;
  k1 = await mkCustomer("Kunde Eins", MARKER);
  k2 = await mkCustomer("Kunde Zwei");

  invOpen = await finalized(k1);
  invPaidPart = await finalized(k1);
  await recordPayment(invPaidPart, { amountCents: 5000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: LATER });
  invCancelled = await finalized(k1);
  await cancelInvoice(invCancelled, { orgId, now: LATER });
  invUsd = await finalized(k1, "USD", 20000);
  invK2 = await finalized(k2);
  invDraft = (await createDraftInvoice(orgId, input(k1), { now: FIX })).id;

  dunningSent = (await createDunning(invOpen, { now: LATER })).dunning.id;
  dunningUnsent = (await createDunning(invPaidPart, { now: LATER })).dunning.id;
  dunningK2 = (await createDunning(invK2, { now: LATER })).dunning.id;
  await mailSent(dunningSent);
  await mailSent(dunningK2);
  await dbInternal.emailLog.create({ data: { orgId, docType: "DUNNING", docId: dunningUnsent, subject: "x", bodySnapshot: "x", status: "FAILED" } });

  await savePortalSettings(orgId, { enabled: true }, "t");
  const { url } = await createPortalLink(orgId, k1, {}, { actor: "t", now: FIX, baseUrl: BASE });
  const resolved = await resolvePortalToken(url.slice(`${BASE}/portal/`.length), FIX);
  if (!resolved) throw new Error("Link nicht aufloesbar");
  linkK1 = resolved;
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Portalansicht", () => {
  it("zeigt nur eigene Nicht-Entwurf-Belege (inkl. Storno und Teilzahlung)", async () => {
    const view = await loadPortalView(linkK1, NOW);
    const ids = view.documents.filter((d) => d.docType === "INVOICE").map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining([invOpen, invPaidPart, invCancelled, invUsd]));
    expect(ids).not.toContain(invK2);
    expect(ids).not.toContain(invDraft);
    const storno = view.documents.filter((d) => d.kind === "CREDIT_NOTE");
    expect(storno).toHaveLength(1);
    expect(storno[0]!.publicStatus).toBe("CREDIT");
    expect(storno[0]!.openCents).toBe(0);
    expect(view.documents.find((d) => d.id === invCancelled)!.publicStatus).toBe("CANCELLED");
    const part = view.documents.find((d) => d.id === invPaidPart)!;
    expect(part.publicStatus).toBe("OVERDUE");
    expect(part.openCents).toBe(11900 - 5000);
    expect(view.customerName).toBe("Kunde Eins");
    expect(view.company.name).toBe("Portal-Ansicht GmbH");
  });

  it("enthaelt keine internen Felder", async () => {
    const view = await loadPortalView(linkK1, NOW);
    const json = JSON.stringify(view);
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain(orgId);
    expect(json).not.toContain(k1);
  });

  it("Mahnungen nur nach Versand; showDunnings=false blendet alle aus", async () => {
    const view = await loadPortalView(linkK1, NOW);
    const dun = view.documents.filter((d) => d.docType === "DUNNING").map((d) => d.id);
    expect(dun).toEqual([dunningSent]);
    const d = view.documents.find((x) => x.id === dunningSent)!;
    expect(d.files).toEqual(["PDF"]);
    expect(d.publicStatus).toBe("DUNNING");
    expect(d.relatedInvoiceNumber).toBeTruthy();
    const hidden = await loadPortalView({ ...linkK1, showDunnings: false }, NOW);
    expect(hidden.documents.some((x) => x.docType === "DUNNING")).toBe(false);
  });

  it("Dateiliste ohne UBL bei showEInvoice=false", async () => {
    const view = await loadPortalView(linkK1, NOW);
    expect(view.documents.find((d) => d.id === invOpen)!.files).toEqual(["PDF", "UBL"]);
    const off = await loadPortalView({ ...linkK1, showEInvoice: false }, NOW);
    expect(off.documents.find((d) => d.id === invOpen)!.files).toEqual(["PDF"]);
  });

  it("offene Posten je Waehrung, ueberfaellig separat", async () => {
    const view = await loadPortalView(linkK1, NOW);
    const eur = view.openItems.find((o) => o.currency === "EUR")!;
    const usd = view.openItems.find((o) => o.currency === "USD")!;
    expect(eur.openCents).toBe(11900 + (11900 - 5000));
    expect(eur.overdueCents).toBe(eur.openCents);
    expect(usd.openCents).toBe(23800);
    expect(view.openItems.map((o) => o.currency)).toEqual(["EUR", "USD"]);
  });
});

describe("Portal-Dateien", () => {
  it("PDF und UBL entsprechen dem Archiv", async () => {
    for (const kind of ["PDF", "UBL"] as const) {
      const file = await getPortalFile(linkK1, "INVOICE", invOpen, kind);
      const archived = await getArchivedInvoiceFile(orgId, invOpen, kind);
      expect(file).not.toBeNull();
      expect(SHA(file!.bytes)).toBe(SHA(archived));
    }
    const pdf = await getPortalFile(linkK1, "INVOICE", invOpen, "PDF");
    expect(pdf!.contentType).toBe("application/pdf");
    expect(pdf!.filename.endsWith(".pdf")).toBe(true);
    const ubl = await getPortalFile(linkK1, "INVOICE", invOpen, "UBL");
    expect(ubl!.contentType).toBe("application/xml");
    expect(ubl!.filename.endsWith("-xrechnung.xml")).toBe(true);
    const dun = await getPortalFile(linkK1, "DUNNING", dunningSent, "PDF");
    expect(dun!.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("fremde, Entwurf-, unversendete Mahnung und unzulaessige Arten -> null", async () => {
    expect(await getPortalFile(linkK1, "INVOICE", invK2, "PDF")).toBeNull();
    expect(await getPortalFile(linkK1, "INVOICE", invDraft, "PDF")).toBeNull();
    expect(await getPortalFile(linkK1, "DUNNING", dunningK2, "PDF")).toBeNull();
    expect(await getPortalFile(linkK1, "DUNNING", dunningUnsent, "PDF")).toBeNull();
    expect(await getPortalFile(linkK1, "DUNNING", dunningSent, "UBL")).toBeNull();
    expect(await getPortalFile(linkK1, "INVOICE", invOpen, "CII")).toBeNull();
    expect(await getPortalFile(linkK1, "QUOTE", invOpen, "PDF")).toBeNull();
    expect(await getPortalFile({ ...linkK1, showEInvoice: false }, "INVOICE", invOpen, "UBL")).toBeNull();
    expect(await isVisible({ ...linkK1, orgId: otherOrgId }, "INVOICE", invOpen)).toBe(false);
  });

  it("manipuliertes Archiv -> ArchiveTamperedError", async () => {
    const id = await finalized(k1);
    await getPortalFile(linkK1, "INVOICE", id, "PDF");
    const row = await dbInternal.archivedDocument.findFirstOrThrow({ where: { invoiceId: id, kind: "PDF" }, select: { path: true } });
    await fs.appendFile(path.join(tmpDir, row.path), "x");
    await expect(getPortalFile(linkK1, "INVOICE", id, "PDF")).rejects.toBeInstanceOf(ArchiveTamperedError);
  });
});

describe("Abrufprotokoll", () => {
  it("VIEW hoechstens einmal je Berliner Tag, DOWNLOAD immer", async () => {
    const c = await dbInternal.customer.create({
      data: { orgId, name: "Ereignis-Kunde", addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg" },
      select: { id: true },
    });
    const { url } = await createPortalLink(orgId, c.id, {}, { actor: "t", now: FIX, baseUrl: BASE });
    const link = (await resolvePortalToken(url.slice(`${BASE}/portal/`.length), FIX))!;
    const day1a = new Date("2196-04-10T08:00:00.000Z");
    const day1b = new Date("2196-04-10T20:00:00.000Z"); // 22:00 Berlin, gleicher Tag
    const day2 = new Date("2196-04-10T22:30:00.000Z"); // 00:30 Berlin am Folgetag
    await recordPortalEvent(link, { kind: "VIEW" }, day1a);
    await recordPortalEvent(link, { kind: "VIEW" }, day1b);
    expect(await dbInternal.customerPortalEvent.count({ where: { linkId: link.linkId, kind: "VIEW" } })).toBe(1);
    await recordPortalEvent(link, { kind: "VIEW" }, day2);
    expect(await dbInternal.customerPortalEvent.count({ where: { linkId: link.linkId, kind: "VIEW" } })).toBe(2);
    await recordPortalEvent(link, { kind: "DOWNLOAD", docType: "INVOICE", docId: invOpen, fileKind: "PDF" }, day2);
    await recordPortalEvent(link, { kind: "DOWNLOAD", docType: "INVOICE", docId: invOpen, fileKind: "PDF" }, day2);
    expect(await dbInternal.customerPortalEvent.count({ where: { linkId: link.linkId, kind: "DOWNLOAD" } })).toBe(2);
    const row = await dbInternal.customerPortalLink.findUniqueOrThrow({ where: { id: link.linkId }, select: { viewCount: true, lastViewedAt: true } });
    expect(row.viewCount).toBe(2);
    expect(row.lastViewedAt!.getTime()).toBe(day2.getTime());
  });

  it("Aufbewahrung: Ereignisse aelter als 730 Tage werden geloescht, juengere bleiben", async () => {
    const old = await dbInternal.customerPortalEvent.create({
      data: { orgId, linkId: linkK1.linkId, kind: "VIEW", at: new Date(NOW.getTime() - PORTAL_EVENT_RETENTION_MS - 1000) },
      select: { id: true },
    });
    const recent = await dbInternal.customerPortalEvent.create({
      data: { orgId, linkId: linkK1.linkId, kind: "VIEW", at: new Date(NOW.getTime() - 1000) },
      select: { id: true },
    });
    const result = await runCleanupJob(NOW);
    expect(result.portalEventsDeleted).toBeGreaterThanOrEqual(1);
    expect(await dbInternal.customerPortalEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await dbInternal.customerPortalEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});
