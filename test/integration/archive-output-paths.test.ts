/**
 * Phase 16a, Task 5 — alle Ausgabewege liefern das Belegarchiv. Testjahr 2101, eigene
 * Nummernpraefixe (Invoice.number ist global @unique). ARCHIVE_DIR zeigt auf ein Tempverzeichnis.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { getArchivedDunningPdf } from "@/domain/dunning/archive";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import { createDunning } from "@/domain/dunning/create";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { readArchiveFile } from "@/lib/archive/storage";
import { buildStandardAttachments } from "@/domain/email/attachments";
import { getDocumentFile } from "@/api/files";
import { server } from "@/mcp/server";
import { GET as SessionPdf } from "@/app/api/invoices/[id]/pdf/route";
import { GET as SessionZugferd } from "@/app/api/invoices/[id]/zugferd/route";
import { GET as SessionXRechnung } from "@/app/api/invoices/[id]/xrechnung/route";
import { GET as SessionDunningPdf } from "@/app/api/dunnings/[id]/pdf/route";
import { GET as V1Pdf } from "@/app/api/v1/Invoice/[id]/pdf/route";
import { GET as V1Archive } from "@/app/api/v1/Invoice/[id]/archive/route";
import type { CreateInvoiceInput } from "@/schemas";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<ToolResult> }> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}

let orgId: string;
let customerId: string;
let token: string;
let tmpDir: string;
let prevEnv: string | undefined;
const FIX_DATE = new Date("2101-03-01T10:00:00.000Z");
const DUNNING_DATE = new Date("2101-04-15T10:00:00.000Z");
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-archive-out-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (
    await dbInternal.organization.create({
      data: { legalName: "Ausgabe GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    })
  ).id;
  orgStore.id = orgId;
  customerId = (
    await dbInternal.customer.create({
      data: { orgId, name: "Ausgabe-Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", leitwegId: "04011000-1234512345-06" },
    })
  ).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await updateNumberRange(orgId, "INVOICE", { pattern: "{PREFIX}{SEQ}", prefix: "AO99-RE-", seqPadding: 4, yearlyReset: false, nextValue: 1 }, "test");
  await updateNumberRange(orgId, "DUNNING", { pattern: "{PREFIX}{SEQ}", prefix: "AO99-MA-", seqPadding: 4, yearlyReset: false, nextValue: 1 }, "test");
  token = (await createApiKey(orgId, { name: "Archiv-Key", scopes: ["read"] })).token;
  resetRateLimits();
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function input(): CreateInvoiceInput {
  return {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX_DATE, deliveryDate: new Date("2101-02-25"), dueDate: new Date("2101-03-15"),
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
}
const draft = async () => (await createDraftInvoice(orgId, input(), { now: FIX_DATE })).id;
const finalized = async () => (await finalizeInvoice(await draft(), { now: FIX_DATE })).id;
const archivedBytes = async (id: string, kind: string): Promise<Buffer> => {
  const row = await dbInternal.archivedDocument.findFirstOrThrow({ where: { invoiceId: id, kind }, select: { path: true } });
  const b = await readArchiveFile(row.path);
  if (!b) throw new Error("Archivdatei fehlt");
  return b;
};

describe("Ausgabewege liefern das Belegarchiv", () => {
  it("Session-/pdf, /zugferd, REST /pdf, getDocumentFile, Mailanhang und MCP liefern die archivierten Bytes", async () => {
    const id = await finalized();
    const number = (await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { number: true } })).number ?? "";

    const sessionPdf = await bytes(await SessionPdf(new Request("http://x"), ctxFor(id)));
    const archivePdf = await archivedBytes(id, "PDF");
    const archiveUbl = await archivedBytes(id, "UBL");
    expect(Buffer.compare(sessionPdf, archivePdf)).toBe(0);

    expect(Buffer.compare(await bytes(await SessionZugferd(new Request("http://x"), ctxFor(id))), archivePdf)).toBe(0);
    expect(Buffer.compare(await bytes(await SessionXRechnung(new Request("http://x"), ctxFor(id))), archiveUbl)).toBe(0);
    const v1 = await V1Pdf(new Request("http://x", { headers: { authorization: `Bearer ${token}` } }), ctxFor(id));
    expect(Buffer.compare(await bytes(v1), archivePdf)).toBe(0);

    expect(Buffer.compare((await getDocumentFile(orgId, "INVOICE", id, "pdf")).buffer, archivePdf)).toBe(0);
    expect(Buffer.compare((await getDocumentFile(orgId, "INVOICE", id, "zugferd")).buffer, archivePdf)).toBe(0);
    expect(Buffer.compare((await getDocumentFile(orgId, "INVOICE", id, "xrechnung")).buffer, archiveUbl)).toBe(0);

    const attachments = await buildStandardAttachments(orgId, "INVOICE", id);
    expect(Buffer.compare(attachments.find((a) => a.filename === `${number}.pdf`)!.content, archivePdf)).toBe(0);
    expect(Buffer.compare(attachments.find((a) => a.filename === `${number}-xrechnung.xml`)!.content, archiveUbl)).toBe(0);

    const mcp = await callTool("get_document_file", { kind: "INVOICE", document: number, format: "pdf" });
    const payload = JSON.parse(mcp.content.map((c) => c.text).join("\n")) as { data: string };
    expect(Buffer.compare(Buffer.from(payload.data, "base64"), archivePdf)).toBe(0);

    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-archive-export-"));
    try {
      const exp = await callTool("export_invoice", { invoice: number, format: "both", outputDir: outDir });
      expect(exp.isError).toBeFalsy();
      expect(Buffer.compare(await fs.readFile(path.join(outDir, `${number}.pdf`)), archivePdf)).toBe(0);
      expect(Buffer.compare(await fs.readFile(path.join(outDir, `${number}.xml`)), archiveUbl)).toBe(0);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
    expect(await dbInternal.archivedDocument.count({ where: { invoiceId: id } })).toBe(3);
  });

  it("Entwurf-PDF wird live gerendert und nicht archiviert", async () => {
    const id = await draft();
    const res = await SessionPdf(new Request("http://x"), ctxFor(id));
    expect(res.status).toBe(200);
    expect((await bytes(res)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const attachments = await buildStandardAttachments(orgId, "INVOICE", id);
    expect(attachments[0]!.filename.endsWith("-ENTWURF.pdf")).toBe(true);
    expect(await dbInternal.archivedDocument.count({ where: { invoiceId: id } })).toBe(0);
  });

  it("Mahnung: Anhang MA-….pdf ist archiviert, zweiter Abruf byte-gleich", async () => {
    const id = await finalized();
    const { dunning } = await createDunning(id, { now: DUNNING_DATE });
    const first = await buildStandardAttachments(orgId, "DUNNING", dunning.id);
    const maName = `${dunning.number}.pdf`;
    const ma = first.find((a) => a.filename === maName);
    expect(ma).toBeDefined();
    const row = await dbInternal.dunning.findUniqueOrThrow({ where: { id: dunning.id }, select: { pdfPath: true, pdfSha256: true } });
    expect(row.pdfPath).toBeTruthy();
    expect(row.pdfSha256).toHaveLength(64);
    const stored = await readArchiveFile(row.pdfPath!);
    expect(Buffer.compare(ma!.content, stored!)).toBe(0);

    const second = await buildStandardAttachments(orgId, "DUNNING", dunning.id);
    expect(Buffer.compare(second.find((a) => a.filename === maName)!.content, ma!.content)).toBe(0);
    expect(Buffer.compare(await bytes(await SessionDunningPdf(new Request("http://x"), ctxFor(dunning.id))), ma!.content)).toBe(0);
    // die Rechnung im Mahnanhang ist ebenfalls das archivierte PDF
    const invAttachment = first.find((a) => a.filename !== maName);
    expect(Buffer.compare(invAttachment!.content, await archivedBytes(id, "PDF"))).toBe(0);
  });

  it("REST /archive: vor Ausgabe archived:false, danach drei Dokumente ohne Pfad; MCP gleiche Form", async () => {
    const id = await finalized();
    const headers = { authorization: `Bearer ${token}` };
    const before = await (await V1Archive(new Request("http://x", { headers }), ctxFor(id))).json();
    expect(before.data).toEqual({ archived: false, documents: [] });

    await getDocumentFile(orgId, "INVOICE", id, "pdf");
    const res = await V1Archive(new Request("http://x", { headers }), ctxFor(id));
    const body = await res.json();
    expect(body.data.archived).toBe(true);
    expect(body.data.documents.map((d: { kind: string }) => d.kind).sort()).toEqual(["CII", "PDF", "UBL"]);
    for (const d of body.data.documents) {
      expect(Object.keys(d).sort()).toEqual(["createdAt", "kind", "sha256", "source"]);
      expect(d.source).toBe("OUTPUT");
    }
    const number = (await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { number: true } })).number ?? "";
    const mcp = JSON.parse((await callTool("get_invoice_archive", { invoice: number })).content[0]!.text) as typeof body.data;
    expect(mcp).toEqual(body.data);
  });

  it("REST /archive einer fremden Organisation: 404", async () => {
    const other = await dbInternal.organization.create({ data: { legalName: "Fremd GmbH", addressLine1: "Weg 3", postalCode: "21339", city: "Lüneburg" } });
    const otherToken = (await createApiKey(other.id, { name: "Fremd-Key", scopes: ["read"] })).token;
    const id = await finalized();
    const res = await V1Archive(new Request("http://x", { headers: { authorization: `Bearer ${otherToken}` } }), ctxFor(id));
    expect(res.status).toBe(404);
  });

  it("Webshop-Fluss: festschreiben, voll zahlen, erster Abruf -> archiviertes CII zeigt den bezahlten Stand und bleibt bytegleich", async () => {
    const id = await finalized();
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { grossTotalCents: true } });
    await recordPayment(id, { amountCents: inv.grossTotalCents, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: DUNNING_DATE });
    expect(await dbInternal.archivedDocument.count({ where: { invoiceId: id } })).toBe(0);

    const first = await getDocumentFile(orgId, "INVOICE", id, "pdf");
    const cii = (await archivedBytes(id, "CII")).toString("utf8");
    const gross = (inv.grossTotalCents / 100).toFixed(2);
    expect(cii).toMatch(new RegExp(`<ram:TotalPrepaidAmount>${gross}</ram:TotalPrepaidAmount>`));
    expect(cii).toMatch(/<ram:DuePayableAmount>0\.00<\/ram:DuePayableAmount>/);

    await dbInternal.customer.update({ where: { id: customerId }, data: { name: "Spaeter umbenannt AG" } });
    const second = await getDocumentFile(orgId, "INVOICE", id, "pdf");
    expect(Buffer.compare(second.buffer, first.buffer)).toBe(0);
    expect(Buffer.compare(await archivedBytes(id, "CII"), Buffer.from(cii, "utf8"))).toBe(0);
    await dbInternal.customer.update({ where: { id: customerId }, data: { name: "Ausgabe-Kunde AG" } });
  });

  it("Mahnung: veraenderte oder fehlende Archivdatei -> ArchiveTamperedError und ARCHIVE_TAMPERED, kein Neurendern", async () => {
    const id = await finalized();
    const { dunning } = await createDunning(id, { now: DUNNING_DATE });
    await getArchivedDunningPdf(orgId, dunning.id);
    const row = await dbInternal.dunning.findUniqueOrThrow({ where: { id: dunning.id }, select: { pdfPath: true } });
    const abs = path.join(tmpDir, ...row.pdfPath!.split("/"));
    await fs.writeFile(abs, Buffer.from("manipuliert"));
    await expect(getArchivedDunningPdf(orgId, dunning.id)).rejects.toBeInstanceOf(ArchiveTamperedError);
    await fs.rm(abs);
    await expect(getArchivedDunningPdf(orgId, dunning.id)).rejects.toBeInstanceOf(ArchiveTamperedError);
    expect(await dbInternal.notification.count({ where: { orgId, type: "ARCHIVE_TAMPERED", entityId: id } })).toBe(1);
    expect(await readArchiveFile(row.pdfPath!)).toBeNull();
  });

  it("Mahnung: Archivierung schreibt ChangeLog DUNNING/ARCHIVE; zurueckgesetzter Pfad -> kein Neurendern", async () => {
    const id = await finalized();
    const { dunning } = await createDunning(id, { now: DUNNING_DATE });
    await getArchivedDunningPdf(orgId, dunning.id);
    await getArchivedDunningPdf(orgId, dunning.id);
    const row = await dbInternal.dunning.findUniqueOrThrow({ where: { id: dunning.id }, select: { pdfSha256: true, pdfPath: true } });
    const logs = await dbInternal.changeLog.findMany({ where: { orgId, entity: "DUNNING", entityId: dunning.id, action: "ARCHIVE" }, select: { diffJson: true } });
    expect(logs).toHaveLength(1);
    const diff = JSON.parse(logs[0]!.diffJson) as { pdf: string; source: string; invoiceId: string };
    expect(diff).toMatchObject({ pdf: row.pdfSha256, invoiceId: id });
    expect(["OUTPUT", "BACKFILL"]).toContain(diff.source);
    // An der Anwendung vorbei zurueckgesetzt:
    await dbInternal.$executeRaw`UPDATE "Dunning" SET "pdfPath" = NULL, "pdfSha256" = NULL WHERE "id" = ${dunning.id}`;
    await expect(getArchivedDunningPdf(orgId, dunning.id)).rejects.toBeInstanceOf(ArchiveTamperedError);
    const after = await dbInternal.dunning.findUniqueOrThrow({ where: { id: dunning.id }, select: { pdfPath: true } });
    expect(after.pdfPath).toBeNull();
    // Wiederherstellen, damit der globale Archiv-Nachlauf anderer Tests nicht darueber stolpert.
    await dbInternal.$executeRaw`UPDATE "Dunning" SET "pdfPath" = ${row.pdfPath}, "pdfSha256" = ${row.pdfSha256} WHERE "id" = ${dunning.id}`;
  });

  it("Org-Scope: fremde Organisation erhaelt 404 auf /pdf, /zugferd, /xrechnung und Mahn-PDF; Mahnungsarchiv wirft NotFound", async () => {
    const id = await finalized();
    const { dunning } = await createDunning(id, { now: DUNNING_DATE });
    const other = await dbInternal.organization.create({ data: { legalName: "Scope GmbH", addressLine1: "Weg 4", postalCode: "21339", city: "Lüneburg" } });
    orgStore.id = other.id;
    try {
      for (const route of [SessionPdf, SessionZugferd, SessionXRechnung]) {
        expect((await route(new Request("http://x"), ctxFor(id))).status).toBe(404);
      }
      expect((await SessionDunningPdf(new Request("http://x"), ctxFor(dunning.id))).status).toBe(404);
      await expect(getArchivedDunningPdf(other.id, dunning.id)).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      orgStore.id = orgId;
    }
    expect(await dbInternal.archivedDocument.count({ where: { invoiceId: id } })).toBe(0);
    expect((await SessionPdf(new Request("http://x"), ctxFor(id))).status).toBe(200);
  });
});
