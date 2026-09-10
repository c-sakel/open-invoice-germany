/**
 * Phase 13b, Task 6: Anhaenge im Entwurf — kein neuer Schreibpfad. Prueft die
 * Domaenenwirkung der Reihenfolge (Entwurf zuerst ueber den bestehenden Speicherweg
 * `POST /api/invoices`, danach ueber die bestehende Route `POST /api/attachments`),
 * nicht die React-Mechanik in `AttachmentPanel`/`DocumentEditor`.
 * Muster: test/integration/attachments-route.test.ts (Org/Auth-Mock, multipart-Request,
 * ATTACHMENTS_DIR je Testlauf auf ein fs.mkdtemp-Verzeichnis).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
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
vi.mock("@/lib/auth/server", () => ({
  getCurrentUserId: async () => "tester",
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { POST as POST_invoices } from "@/app/api/invoices/route";
import { POST as POST_attachments } from "@/app/api/attachments/route";

const PDF_BYTES = Buffer.from("%PDF-1.7\nInhalt der Rechnung\n");
function pdfBytes(unique: string): Buffer {
  return Buffer.concat([PDF_BYTES, Buffer.from(`\n% ${unique}`)]);
}

let tmpDir: string;
let prevEnv: string | undefined;
let orgId: string;
let customerId: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-editor-attachments-"));
  prevEnv = process.env.ATTACHMENTS_DIR;
  process.env.ATTACHMENTS_DIR = tmpDir;
});
afterEach(async () => {
  if (prevEnv === undefined) delete process.env.ATTACHMENTS_DIR;
  else process.env.ATTACHMENTS_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Editor-Anhaenge GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);

  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;
});

function invoicePayload(overrides: Record<string, unknown> = {}) {
  return {
    customerId,
    lines: [{ description: "Beratung", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19 }],
    ...overrides,
  };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function formDataWith(fields: { docType: string; docId: string; file: Buffer; filename?: string; mime?: string }): Request {
  const fd = new FormData();
  fd.set("docType", fields.docType);
  fd.set("docId", fields.docId);
  fd.append("files", new File([new Uint8Array(fields.file)], fields.filename ?? "beleg.pdf", { type: fields.mime ?? "application/pdf" }));
  return new Request("http://localhost/api/attachments", {
    method: "POST",
    // FormData-Bodies liefern in dieser Umgebung keinen automatischen content-length-
    // Header (undici) — die Route braucht ihn fuer die Vorpruefung (siehe
    // attachments-route.test.ts), Wert weit unter dem Limit.
    headers: { "content-length": "100000" },
    body: fd,
  });
}

describe("Editor: Anhaenge im neuen Entwurf (kein Parallelpfad)", () => {
  it("gueltiger Entwurf: genau ein Beleg und ein Anhang, beide mit derselben orgId", async () => {
    const before = await dbInternal.invoice.count({ where: { orgId } });

    const res = await POST_invoices(jsonRequest("http://localhost/api/invoices", invoicePayload()));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const up = await POST_attachments(formDataWith({ docType: "INVOICE", docId: id, file: pdfBytes("gueltig") }));
    expect(up.status).toBe(201);

    expect(await dbInternal.invoice.count({ where: { orgId } })).toBe(before + 1);
    const att = await dbInternal.documentAttachment.findMany({ where: { orgId, docType: "INVOICE", docId: id } });
    expect(att).toHaveLength(1);
    expect(att[0].orgId).toBe(orgId);
  });

  it("ungueltiger Entwurf: kein Beleg und kein Anhang", async () => {
    const beforeInv = await dbInternal.invoice.count({ where: { orgId } });
    const beforeAtt = await dbInternal.documentAttachment.count({ where: { orgId } });

    const res = await POST_invoices(jsonRequest("http://localhost/api/invoices", invoicePayload({ customerId: "" })));
    expect(res.status).toBe(400);

    expect(await dbInternal.invoice.count({ where: { orgId } })).toBe(beforeInv);
    expect(await dbInternal.documentAttachment.count({ where: { orgId } })).toBe(beforeAtt);
  });

  it("Regression: dieselbe Datei zweimal am selben Beleg (orgId, sha256, docType, docId) liefert denselben Anhang, keine zweite Zeile", async () => {
    const res = await POST_invoices(jsonRequest("http://localhost/api/invoices", invoicePayload()));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const bytes = pdfBytes("dedup");
    const first = await POST_attachments(formDataWith({ docType: "INVOICE", docId: id, file: bytes, filename: "a.pdf" }));
    const second = await POST_attachments(formDataWith({ docType: "INVOICE", docId: id, file: bytes, filename: "b.pdf" }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const j1 = (await first.json()) as { saved: { id: string }[] };
    const j2 = (await second.json()) as { saved: { id: string }[] };
    expect(j2.saved[0].id).toBe(j1.saved[0].id);

    const rows = await dbInternal.documentAttachment.findMany({ where: { orgId, docType: "INVOICE", docId: id } });
    expect(rows).toHaveLength(1);
  });
});
