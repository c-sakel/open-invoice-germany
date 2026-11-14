/**
 * Oeffentliche Portalseite und Download-Route (Rate-Limit, einheitliches 404, Archivbytes, Protokoll). Eigenes Jahr 2197.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const hdrs = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.current }));
vi.mock("@/domain/portal/link", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/domain/portal/link")>();
  return { ...orig, resolvePortalToken: vi.fn(orig.resolvePortalToken) };
});

import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { savePortalSettings } from "@/domain/portal/settings";
import { createPortalLink, resolvePortalToken, revokePortalLink } from "@/domain/portal/link";
import { resetRateLimits } from "@/lib/rate-limit";
import { createInvoiceSchema, type CreateInvoiceInput } from "@/schemas";
import PortalPage from "@/app/portal/[token]/page";
import { GET } from "@/app/api/public/portal/[token]/[docType]/[docId]/[fileKind]/route";

const MARKER = "GEHEIM-INTERN";
const BASE = "https://rechnung.example.org";
const FIX = new Date("2197-03-01T10:00:00.000Z");

let tmpDir: string;
let prevEnv: string | undefined;
let orgId = "";
let otherOrgId = "";
let k1 = "";
let k2 = "";
let token1 = "";
let token2 = "";
let invK1 = "";
let invK2 = "";
let invK1Number = "";

function input(customerId: string): CreateInvoiceInput {
  return createInvoiceSchema.parse({
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
    issueDate: FIX, deliveryDate: new Date("2197-02-25"), notes: MARKER, internalReference: MARKER,
    lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  });
}

async function finalized(customerId: string, org = orgId): Promise<string> {
  const d = await createDraftInvoice(org, input(customerId), { now: FIX });
  return (await finalizeInvoice(d.id, { now: FIX })).id;
}

function req(token: string, docType: string, docId: string, fileKind: string, ip = "203.0.113.10"): [Request, { params: Promise<{ token: string; docType: string; docId: string; fileKind: string }> }] {
  return [
    new Request(`http://localhost/api/public/portal/${token}/${docType}/${docId}/${fileKind}`, { headers: { "x-forwarded-for": ip } }),
    { params: Promise.resolve({ token, docType, docId, fileKind }) },
  ];
}

async function snapshot(res: Response): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers.entries()) };
}

async function pageHtml(token: string): Promise<string> {
  return renderToStaticMarkup(await PortalPage({ params: Promise.resolve({ token }) }));
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-portal-pub-"));
  prevEnv = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const mkOrg = async (n: string) =>
    (await dbInternal.organization.create({ data: { legalName: n, addressLine1: "Weg 1", postalCode: "21339", city: "Teststadt", vatId: "DE123456789", taxNumber: "33/123/45678" }, select: { id: true } })).id;
  orgId = await mkOrg("Portal-Seite GmbH");
  otherOrgId = await mkOrg("Portal-Seite Fremd GmbH");
  await ensureOrgMasterdata(dbInternal, orgId);
  const mkCustomer = async (name: string, language: string, notes?: string) =>
    (await dbInternal.customer.create({ data: { orgId, name, addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", language, notes: notes ?? null }, select: { id: true } })).id;
  k1 = await mkCustomer("Seitenkunde Eins", "en", MARKER);
  k2 = await mkCustomer("Seitenkunde Zwei", "de");
  invK1 = await finalized(k1);
  invK2 = await finalized(k2);
  invK1Number = (await dbInternal.invoice.findUniqueOrThrow({ where: { id: invK1 }, select: { number: true } })).number ?? "";
  await savePortalSettings(orgId, { enabled: true }, "t");
  token1 = (await createPortalLink(orgId, k1, {}, { actor: "t", now: FIX, baseUrl: BASE })).url.slice(`${BASE}/portal/`.length);
  token2 = (await createPortalLink(orgId, k2, {}, { actor: "t", now: FIX, baseUrl: BASE })).url.slice(`${BASE}/portal/`.length);
});

beforeEach(() => {
  resetRateLimits();
  hdrs.current = new Headers({ "x-forwarded-for": "198.51.100.7" });
  vi.mocked(resolvePortalToken).mockClear();
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Portalseite", () => {
  it("zeigt Belegnummer und offene Posten, nie interne Felder; lang folgt der Kundensprache", async () => {
    const html = await pageHtml(token1);
    expect(html).toContain(invK1Number);
    expect(html).toContain("Open items");
    expect(html).toContain('lang="en"');
    expect(html).not.toContain(MARKER);
    expect(html).toContain(`/api/public/portal/${token1}/INVOICE/${invK1}/PDF`);
    const de = await pageHtml(token2);
    expect(de).toContain('lang="de"');
    expect(de).toContain("Offene Posten");
  });

  it("schreibt je Link und Tag genau ein VIEW-Ereignis (frischer Link: +1, zweiter Aufruf am selben Tag weiter +1)", async () => {
    const c = await dbInternal.customer.create({ data: { orgId, name: "View Kunde", addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg" }, select: { id: true } });
    const { url } = await createPortalLink(orgId, c.id, {}, { actor: "t", baseUrl: BASE });
    const fresh = url.slice(`${BASE}/portal/`.length);
    const count = () => dbInternal.customerPortalEvent.count({ where: { orgId, kind: "VIEW", link: { customerId: c.id } } });
    expect(await count()).toBe(0);
    await pageHtml(fresh);
    expect(await count()).toBe(1);
    await pageHtml(fresh);
    expect(await count()).toBe(1);
    const link = await dbInternal.customerPortalLink.findFirstOrThrow({ where: { customerId: c.id }, select: { viewCount: true } });
    expect(link.viewCount).toBe(1);
  });

  it("ohne ermittelbare IP gilt ein Notlimit (kein fail-open) und je Token ein Seitenlimit", async () => {
    hdrs.current = new Headers();
    for (let i = 0; i < 60; i++) await pageHtml(token2);
    vi.mocked(resolvePortalToken).mockClear();
    expect(await pageHtml(token2)).toContain("Too many requests");
    expect(resolvePortalToken).not.toHaveBeenCalled();
    // Anderes Token ohne IP: weiterhin im gemeinsamen Notlimit (300), also noch erlaubt.
    expect(await pageHtml(token1)).toContain("Open items");
  });

  it("Seitenlimit je Token auch bei wechselnden IPs", async () => {
    for (let i = 0; i < 60; i++) {
      hdrs.current = new Headers({ "x-forwarded-for": `198.51.100.${i + 1}` });
      await pageHtml(token2);
    }
    hdrs.current = new Headers({ "x-forwarded-for": "198.51.100.200" });
    expect(await pageHtml(token2)).toContain("Too many requests");
  });

  it("unbekanntes Token -> notFound", async () => {
    await expect(pageHtml("a".repeat(43))).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404") });
  });

  it("61. Aufruf je IP -> zweisprachiger Rate-Limit-Hinweis ohne Aufloesung", async () => {
    for (let i = 0; i < 60; i++) await pageHtml(token2);
    vi.mocked(resolvePortalToken).mockClear();
    const html = await pageHtml(token2);
    expect(html).toContain("Zu viele Anfragen");
    expect(html).toContain("Too many requests");
    expect(resolvePortalToken).not.toHaveBeenCalled();
  });
});

describe("Download-Route", () => {
  it("PDF und UBL kommen aus dem Archiv, mit Sicherheitsheadern", async () => {
    const pdf = await GET(...req(token1, "INVOICE", invK1, "PDF"));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("attachment");
    expect(pdf.headers.get("referrer-policy")).toBe("no-referrer");
    expect(pdf.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pdf.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await pdf.arrayBuffer()).equals(await getArchivedInvoiceFile(orgId, invK1, "PDF"))).toBe(true);
    const ubl = await GET(...req(token1, "INVOICE", invK1, "UBL"));
    expect(ubl.status).toBe(200);
    expect(ubl.headers.get("content-type")).toBe("application/xml");
  });

  it("schreibt DOWNLOAD nur bei Erfolg", async () => {
    const count = () => dbInternal.customerPortalEvent.count({ where: { orgId, kind: "DOWNLOAD" } });
    const c0 = await count();
    expect((await GET(...req(token1, "INVOICE", invK1, "PDF"))).status).toBe(200);
    expect(await count()).toBe(c0 + 1);
    expect((await GET(...req(token1, "INVOICE", invK2, "PDF"))).status).toBe(404);
    expect(await count()).toBe(c0 + 1);
  });

  it("404 ist fuer alle Ungueltigkeitsfaelle identisch (auch Link eines anderen Kunden derselben Org)", async () => {
    const revokedUrl = await (async () => {
      const c = await dbInternal.customer.create({ data: { orgId, name: "Widerruf", addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg" }, select: { id: true } });
      const { url } = await createPortalLink(orgId, c.id, {}, { actor: "t", now: FIX, baseUrl: BASE });
      await revokePortalLink(orgId, c.id, { actor: "t", now: FIX });
      return url.slice(`${BASE}/portal/`.length);
    })();
    const expiredToken = await (async () => {
      const c = await dbInternal.customer.create({ data: { orgId, name: "Abgelaufen", addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg" }, select: { id: true } });
      const { url } = await createPortalLink(orgId, c.id, { expiresInDays: 1 }, { actor: "t", now: new Date("2000-01-01T00:00:00Z"), baseUrl: BASE });
      return url.slice(`${BASE}/portal/`.length);
    })();
    const foreignToken = await (async () => {
      await savePortalSettings(otherOrgId, { enabled: true }, "t");
      const c = await dbInternal.customer.create({ data: { orgId: otherOrgId, name: "Fremdkunde", addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg" }, select: { id: true } });
      const { url } = await createPortalLink(otherOrgId, c.id, {}, { actor: "t", now: FIX, baseUrl: BASE });
      return url.slice(`${BASE}/portal/`.length);
    })();
    const cases: Array<[string, string, string, string]> = [
      [foreignToken, "INVOICE", invK1, "PDF"],
      ["b".repeat(43), "INVOICE", invK1, "PDF"],
      ["kurz", "INVOICE", invK1, "PDF"],
      [revokedUrl, "INVOICE", invK1, "PDF"],
      [expiredToken, "INVOICE", invK1, "PDF"],
      [token2, "INVOICE", invK1, "PDF"],
      [token1, "INVOICE", invK2, "PDF"],
      [token1, "INVOICE", invK1, "CII"],
      [token1, "QUOTE", invK1, "PDF"],
      [token1, "INVOICE", "nicht-vorhanden", "PDF"],
    ];
    const snaps = [];
    for (const c of cases) snaps.push(await snapshot(await GET(...req(...c))));
    expect(snaps[0]!.status).toBe(404);
    for (const s of snaps) expect(s).toEqual(snaps[0]);

    await savePortalSettings(orgId, { enabled: false }, "t");
    try {
      expect(await snapshot(await GET(...req(token1, "INVOICE", invK1, "PDF")))).toEqual(snaps[0]);
    } finally {
      await savePortalSettings(orgId, { enabled: true }, "t");
    }
  });

  it("Fehler beim Protokollieren verhindert den Download nicht", async () => {
    const spy = vi.spyOn(dbInternal.customerPortalEvent, "create").mockRejectedValueOnce(new Error("db weg"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await GET(...req(token1, "INVOICE", invK1, "PDF"));
      expect(res.status).toBe(200);
      expect(err).toHaveBeenCalled();
      expect(JSON.stringify(err.mock.calls)).not.toContain(token1);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });

  it("31. Download je Token -> 429", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await GET(...req(token1, "INVOICE", invK1, "PDF", `192.0.2.${i + 1}`))).status).toBe(200);
    }
    const res = await GET(...req(token1, "INVOICE", invK1, "PDF", "192.0.2.200"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("IP-Limit: 61. Aufruf je IP -> 429", async () => {
    const tok = (i: number) => String(i).padStart(43, "x");
    for (let i = 0; i < 60; i++) expect((await GET(...req(tok(i), "INVOICE", invK1, "PDF", "192.0.2.250"))).status).toBe(404);
    expect((await GET(...req(tok(60), "INVOICE", invK1, "PDF", "192.0.2.250"))).status).toBe(429);
    // andere IP bleibt unberuehrt
    expect((await GET(...req(tok(61), "INVOICE", invK1, "PDF", "192.0.2.251"))).status).toBe(404);
  });

  it("manipuliertes Archiv -> 500 neutral, Benachrichtigung ARCHIVE_TAMPERED", async () => {
    const id = await finalized(k2);
    expect((await GET(...req(token2, "INVOICE", id, "PDF"))).status).toBe(200);
    const row = await dbInternal.archivedDocument.findFirstOrThrow({ where: { invoiceId: id, kind: "PDF" }, select: { path: true } });
    await fs.appendFile(path.join(tmpDir, row.path), "x");
    const res = await GET(...req(token2, "INVOICE", id, "PDF"));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("SHA");
    expect(body).not.toContain(id);
    const n = await dbInternal.notification.count({ where: { orgId, type: "ARCHIVE_TAMPERED" } });
    expect(n).toBeGreaterThan(0);
  });
});
