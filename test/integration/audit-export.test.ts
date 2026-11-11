/**
 * Phase 16a, Task 7 — Pruefer-Export (Z3) und Einstellungs-Session-Route. Eigenes Jahr 2013
 * (Invoice.number ist global @unique). ARCHIVE_DIR zeigt auf ein temporaeres Verzeichnis.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { createDunning } from "@/domain/dunning/create";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { AuditExportTooLargeError, buildAuditExport } from "@/domain/audit/export";
import { server } from "@/mcp/server";
import type { CreateInvoiceInput } from "@/schemas";
import { GET as ExportV1 } from "@/app/api/v1/AuditExport/route";
import { GET as ExportSession } from "@/app/api/settings/audit/export/route";

const FIX_DATE = new Date("2013-03-01T10:00:00.000Z");
const FILES = [
  "index.xml", "gdpdu-01-09-2004.dtd", "rechnungen.csv", "positionen.csv", "zahlungen.csv", "mahnungen.csv", "kunden.csv",
  "aenderungsprotokoll.csv", "archiv.csv", "kettenpruefung.txt",
];

let orgId: string;
let invoiceId: string;
let invoiceNumber: string;
let adminToken: string;
let writeToken: string;
let tmpDir: string;
let workDir: string;
let prevEnv: string | undefined;

function ctx() {
  return { params: Promise.resolve({}) };
}

function v1(token: string | undefined, query: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://x/api/v1/AuditExport${query}`, { headers });
}

async function unzipTo(res: Response): Promise<{ zip: string; names: string[]; read: (n: string) => Buffer }> {
  const zip = path.join(workDir, `r-${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-t", zip]);
  const names = execFileSync("unzip", ["-Z1", zip]).toString("utf8").split("\n").filter(Boolean);
  return { zip, names, read: (n) => execFileSync("unzip", ["-p", zip, n], { maxBuffer: 50_000_000 }) };
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-export-arch-"));
  workDir = mkdtempSync(path.join(os.tmpdir(), "oig-export-work-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (
    await dbInternal.organization.create({
      data: { legalName: "Export GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
    })
  ).id;
  const customerId = (
    await dbInternal.customer.create({ data: { orgId, name: "Kunde; \"AG\"", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" } })
  ).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  adminToken = (await createApiKey(orgId, { name: "Admin", scopes: ["read", "write", "admin"] })).token;
  writeToken = (await createApiKey(orgId, { name: "Write", scopes: ["read", "write"] })).token;
  orgStore.id = orgId;
  resetRateLimits();

  const input = {
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX_DATE, deliveryDate: new Date("2013-02-25"), internalNotes: "GEHEIM-16A",
    lines: [{ description: "Beratung", quantityMilli: 1500, unit: "HUR", unitNetPriceCents: 6667, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput;
  const draft = await createDraftInvoice(orgId, input, { now: FIX_DATE });
  const fin = await finalizeInvoice(draft.id, { now: FIX_DATE });
  invoiceId = fin.id;
  invoiceNumber = (await dbInternal.invoice.findUniqueOrThrow({ where: { id: fin.id }, select: { number: true } })).number ?? "";
  // Ein zweiter Entwurf darf nie im Export landen.
  await createDraftInvoice(orgId, input, { now: FIX_DATE });
  await recordPayment(fin.id, { amountCents: 11900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, actor: "test", now: FIX_DATE });
  const payment = await dbInternal.payment.findFirstOrThrow({ where: { invoiceId: fin.id } });
  await reversePayment(payment.id, { reason: "Falsch gebucht" }, { orgId, actor: "test", now: FIX_DATE });
  await createDunning(fin.id, { now: new Date("2013-04-20T10:00:00.000Z"), force: true });
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("Pruefer-Export", () => {
  it("REST liefert ein gueltiges ZIP mit allen festen Dateien, ohne interne Notizen", async () => {
    const res = await ExportV1(v1(adminToken, "?from=2013-01-01&to=2013-12-31"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="pruefer-export-2013-01-01-2013-12-31.zip"');
    const z = await unzipTo(res);
    for (const f of FILES) expect(z.names).toContain(f);
    const safe = invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_");
    expect(z.names).toContain(`belege/${safe}.pdf`);
    expect(z.names).toContain(`belege/${safe}.xml`);
    expect(z.names.filter((n) => n.startsWith("belege/"))).toHaveLength(2); // Entwurf nicht enthalten

    for (const n of z.names) {
      const text = z.read(n).toString("latin1");
      expect(text.includes("GEHEIM-16A"), n).toBe(false);
    }
    const rechnungen = z.read("rechnungen.csv").toString("utf8");
    expect(rechnungen.split("\r\n").filter(Boolean)).toHaveLength(2); // Kopf + 1 Beleg
    expect(rechnungen).toContain(invoiceNumber);
    expect(z.read("kunden.csv").toString("utf8")).toContain('"Kunde; ""AG"""');
    expect(z.read("positionen.csv").toString("utf8")).toContain("1,500");
    expect(z.read("mahnungen.csv").toString("utf8").split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(z.read("kettenpruefung.txt").toString("utf8")).toContain("Ergebnis: GUELTIG");
  });

  it("zahlungen.csv enthaelt Zahlung und Gegenbuchung REVERSAL mit -119,00", async () => {
    const z = await unzipTo(await ExportV1(v1(adminToken, "?from=2013-01-01&to=2013-12-31"), ctx()));
    const lines = z.read("zahlungen.csv").toString("utf8").split("\r\n").filter(Boolean);
    const header = lines[0].split(";");
    const col = (line: string, name: string) => line.split(";")[header.indexOf(name)];
    const rev = lines.slice(1).find((l) => col(l, "art") === "REVERSAL");
    expect(rev).toBeDefined();
    expect(col(rev ?? "", "betrag")).toBe("-119,00");
    expect(col(rev ?? "", "grund")).toBe("Falsch gebucht");
    expect(col(rev ?? "", "korrigiert_zahlung")).not.toBe("");
    expect(lines.slice(1).some((l) => col(l, "art") === "PAYMENT" && col(l, "betrag") === "119,00")).toBe(true);
  });

  it("index.xml referenziert jede CSV und die DTD, ist wohlgeformt und DTD-gueltig", async () => {
    const z = await unzipTo(await ExportV1(v1(adminToken, "?from=2013-01-01&to=2013-12-31"), ctx()));
    const xml = z.read("index.xml").toString("utf8");
    expect(xml).toContain('<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">');
    for (const f of FILES.filter((n) => n.endsWith(".csv"))) expect(xml).toContain(`<URL>${f}</URL>`);
    expect((xml.match(/<Table>/g) ?? []).length).toBe(7);
    const dir = mkdtempSync(path.join(workDir, "idx-"));
    writeFileSync(path.join(dir, "index.xml"), xml);
    writeFileSync(path.join(dir, "gdpdu-01-09-2004.dtd"), z.read("gdpdu-01-09-2004.dtd"));
    execFileSync("xmllint", ["--noout", "--dtdvalid", path.join(dir, "gdpdu-01-09-2004.dtd"), path.join(dir, "index.xml")]);
  });

  it("belege/<nr>.pdf ist byte-gleich zur Archivdatei, archiv.csv listet PDF, CII und UBL", async () => {
    const z = await unzipTo(await ExportV1(v1(adminToken, "?from=2013-01-01&to=2013-12-31"), ctx()));
    const safe = invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_");
    const archivedPdf = await getArchivedInvoiceFile(orgId, invoiceId, "PDF");
    expect(Buffer.compare(z.read(`belege/${safe}.pdf`), archivedPdf)).toBe(0);
    const ubl = await getArchivedInvoiceFile(orgId, invoiceId, "UBL");
    expect(Buffer.compare(z.read(`belege/${safe}.xml`), ubl)).toBe(0);
    const archiv = z.read("archiv.csv").toString("utf8");
    for (const k of ["PDF", "CII", "UBL"]) expect(archiv).toContain(`;${k};`);
    expect(archiv).toMatch(/;(SCHEDULER|BACKFILL);/); // Altbeleg vor der Archiv-Epoche => BACKFILL
  });

  it("aenderungsprotokoll.csv traegt Hash-Kette des Zeitraums", async () => {
    const z = await unzipTo(await ExportV1(v1(adminToken, "?from=2013-01-01&to=2013-12-31"), ctx()));
    const lines = z.read("aenderungsprotokoll.csv").toString("utf8").split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("id;at;entity;entity_id;action;actor;prev_hash;hash;diff");
    expect(lines.length).toBeGreaterThan(3);
  });

  it("Zeitraum ohne Belege liefert ein gueltiges ZIP mit nur Kopfzeilen", async () => {
    const z = await unzipTo(await ExportV1(v1(adminToken, "?from=2012-01-01&to=2012-12-31"), ctx()));
    expect(z.names.filter((n) => n.startsWith("belege/"))).toHaveLength(0);
    expect(z.read("rechnungen.csv").toString("utf8").split("\r\n").filter(Boolean)).toHaveLength(1);
  });

  it("Zeitraum von vier Jahren und umgekehrter Zeitraum -> 400", async () => {
    expect((await ExportV1(v1(adminToken, "?from=2013-01-01&to=2017-01-02"), ctx())).status).toBe(400);
    expect((await ExportV1(v1(adminToken, "?from=2013-06-01&to=2013-01-01"), ctx())).status).toBe(400);
    expect((await ExportV1(v1(adminToken, ""), ctx())).status).toBe(400);
  });

  it("Grenze maxInvoices -> AuditExportTooLargeError (413)", async () => {
    const out = createWriteStream(path.join(workDir, "big.zip"));
    const range = { from: new Date("2013-01-01T00:00:00Z"), to: new Date("2013-12-31T23:59:59.999Z") };
    const err = await buildAuditExport(orgId, range, out, { maxInvoices: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditExportTooLargeError);
    expect((err as AuditExportTooLargeError).status).toBe(413);
    out.destroy();
  });

  it("REST: Scope write -> 403, ohne Schluessel -> 401", async () => {
    expect((await ExportV1(v1(writeToken, "?from=2013-01-01&to=2013-12-31"), ctx())).status).toBe(403);
    expect((await ExportV1(v1(undefined, "?from=2013-01-01&to=2013-12-31"), ctx())).status).toBe(401);
  });

  it("Session-Route liefert das ZIP der aktiven Org, ungueltige Eingabe -> 400", async () => {
    const ok = await ExportSession(new Request("http://x/api/settings/audit/export?from=2013-01-01&to=2013-12-31"));
    expect(ok.status).toBe(200);
    const z = await unzipTo(ok);
    expect(z.names).toContain("index.xml");
    expect((await ExportSession(new Request("http://x/api/settings/audit/export?from=2013-01-01&to=2020-01-01"))).status).toBe(400);
  });

  it("MCP create_audit_export schreibt das ZIP ins Zielverzeichnis", async () => {
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools;
    const outDir = path.join(workDir, "mcp-out");
    const res = await tools["create_audit_export"].handler({ from: "2013-01-01", to: "2013-12-31", outputDir: outDir });
    expect(res.isError).toBeUndefined();
    const file = path.join(outDir, "pruefer-export-2013-01-01-2013-12-31.zip");
    expect(res.content[0].text).toContain(file);
    execFileSync("unzip", ["-t", file]);
    const bad = await tools["create_audit_export"].handler({ from: "2013-01-01", to: "2020-01-01", outputDir: outDir });
    expect(bad.isError).toBe(true);
  });
});
