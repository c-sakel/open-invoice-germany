/**
 * Upload-Route der Oberflaeche /api/bank-statements: Same-Origin, Content-Type, Groessengrenzen vor formData(),
 * Vorschau/Import, Fehlerabbildung. Testjahr 2204, keine Belege.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "user-test" }));

import { dbInternal } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";
import { POST } from "@/app/api/bank-statements/route";
import { buildCamt } from "../helpers/camt-builder";

let orgId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Bank Upload GmbH", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin" },
    select: { id: true },
  });
  orgId = org.id;
  orgStore.id = orgId;
});
beforeEach(() => resetRateLimits());

const xml = (remittance: string, cents = 4200) =>
  buildCamt({ format: "053", version: 8, iban: "DE89370400440532013000", entries: [{ date: "2204-05-02", txs: [{ amountCents: cents, name: "Muster Kundschaft GmbH", iban: "GB82WEST12345698765432", remittance }] }] });

async function multipart(fields: Record<string, string | { name: string; bytes: Uint8Array }>, opts: { withLength?: boolean; headers?: Record<string, string> } = {}): Promise<Request> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") form.set(k, v);
    else form.set(k, new File([new Uint8Array(v.bytes)], v.name, { type: "text/xml" }));
  }
  const probe = new Request("http://x/api/bank-statements", { method: "POST", body: form });
  const buf = Buffer.from(await probe.arrayBuffer());
  const headers = new Headers({ "content-type": probe.headers.get("content-type") ?? "", ...(opts.headers ?? {}) });
  if (opts.withLength !== false) headers.set("content-length", String(buf.byteLength));
  return new Request("http://x/api/bank-statements", { method: "POST", headers, body: buf });
}
const file = (text: string, name = "auszug.xml") => ({ name, bytes: new TextEncoder().encode(text) });
const body = async (res: Response) => (await res.json()) as { result?: { status: string; importedCount: number; accountIban: string }; error?: string; code?: string; importId?: string };

describe("Upload-Route /api/bank-statements", () => {
  it("ohne Same-Origin -> 403", async () => {
    const res = await POST(await multipart({ file: file(xml("A")), mode: "preview" }, { headers: { "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(403);
    const res2 = await POST(await multipart({ file: file(xml("A")), mode: "preview" }, { headers: { origin: "http://evil.example" } }));
    expect(res2.status).toBe(403);
  });

  it("falscher Content-Type -> 415", async () => {
    const res = await POST(new Request("http://x/api/bank-statements", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" }));
    expect(res.status).toBe(415);
  });

  it("ohne Content-Length -> 413; Content-Length > Grenze -> 413 ohne formData()", async () => {
    expect((await POST(await multipart({ file: file(xml("A")), mode: "preview" }, { withLength: false }))).status).toBe(413);
    const big = new Request("http://x/api/bank-statements", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(11 * 1024 * 1024) },
      body: "irrelevant",
    });
    const spy = vi.spyOn(big, "formData");
    expect((await POST(big)).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Vorschau schreibt nichts, Import 201, Wiederholung 409 mit importId", async () => {
    const content = xml("Upload Rechnung RE-1");
    const preview = await POST(await multipart({ file: file(content), mode: "preview" }));
    expect(preview.status).toBe(200);
    const pv = await body(preview);
    expect(pv.result).toMatchObject({ status: "preview", importedCount: 1 });
    expect(pv.result?.accountIban).not.toContain("DE89370400440532013000");
    expect(await dbInternal.bankTransaction.count({ where: { orgId } })).toBe(0);

    const done = await POST(await multipart({ file: file(content), mode: "commit" }));
    expect(done.status).toBe(201);
    expect(await dbInternal.bankTransaction.count({ where: { orgId } })).toBe(1);

    const dup = await POST(await multipart({ file: file(content), mode: "commit" }));
    expect(dup.status).toBe(409);
    const d = await body(dup);
    expect(d.code).toBe("ALREADY_IMPORTED");
    expect(d.importId).toBeTruthy();
  });

  it("ungueltiger mode -> 400, fehlender mode = Vorschau", async () => {
    expect((await POST(await multipart({ file: file(xml("M1")), mode: "import" }))).status).toBe(400);
    const res = await POST(await multipart({ file: file(xml("M2")) }));
    expect(res.status).toBe(200);
    expect((await body(res)).result?.status).toBe("preview");
  });

  it("ZIP -> 422 mit Hinweis entpacken; keine Datei -> 400", async () => {
    const zip = { name: "auszug.zip", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]) };
    const res = await POST(await multipart({ file: zip, mode: "preview" }));
    expect(res.status).toBe(422);
    expect((await body(res)).error).toMatch(/entpacken/);
    expect((await POST(await multipart({ mode: "preview" }))).status).toBe(400);
  });
});
