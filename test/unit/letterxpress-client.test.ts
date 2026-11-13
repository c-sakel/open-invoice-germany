/** Phase 16d T2 — LetterXpress-Client mit Fake-Transport (kein Netz, nie https.request). */
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LxpAuthError,
  LxpRequestError,
  LxpUnavailableError,
  base64Md5,
  buildPrintJobBody,
  createLetterXpressClient,
  eurAmountToCents,
  redact,
  type LxpCredentials,
} from "@/lib/postal/letterxpress";
import { PostalTransportError, type LxpTransport, type LxpTransportRequest, type LxpTransportResponse } from "@/lib/postal/transport";

const creds: LxpCredentials = { username: "lxp-test-user", apiKey: "lxp-test-key-16d-000000000000", mode: "test" };
const fx = (n: string): unknown => JSON.parse(readFileSync(path.join(__dirname, "../fixtures/letterxpress", `${n}.json`), "utf8"));

let httpsSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function fake(res: LxpTransportResponse | Error): { transport: LxpTransport; calls: LxpTransportRequest[] } {
  const calls: LxpTransportRequest[] = [];
  const transport: LxpTransport = async (req) => {
    calls.push(req);
    if (res instanceof Error) throw res;
    return res;
  };
  return { transport, calls };
}
const ok = (n: string): LxpTransportResponse => ({ status: 200, json: fx(n) });
const authOf = (r: LxpTransportRequest): unknown => (r.body as { auth: unknown }).auth;
const expectedAuth = { username: "lxp-test-user", apikey: "lxp-test-key-16d-000000000000", mode: "test" };

describe("Hilfsfunktionen", () => {
  it("eurAmountToCents", () => {
    expect(eurAmountToCents(0.67)).toBe(67);
    expect(eurAmountToCents(4.99)).toBe(499);
    expect(eurAmountToCents(1000)).toBe(100000);
    expect(eurAmountToCents(1.005)).toBe(101);
    expect(eurAmountToCents(-1.04)).toBe(-104);
    expect(eurAmountToCents(0)).toBe(0);
    for (const bad of [NaN, Infinity, -Infinity, 1e9 + 1, 1e21, 1e-7]) expect(() => eurAmountToCents(bad)).toThrow();
  });

  it("base64Md5 ist MD5 des Base64-Strings", () => {
    expect(base64Md5("JVBERi0xLjQK")).toBe("c55802b74cf3b9d15e5bac5664ad7cdf");
  });

  it("redact schwaerzt und kuerzt", () => {
    const r = redact(`fehler ${creds.apiKey} user ${creds.username} ${"x".repeat(400)}`, creds);
    expect(r).not.toContain(creds.apiKey);
    expect(r).not.toContain(creds.username);
    expect(r).toContain("***");
    expect(r.length).toBeLessThanOrEqual(300);
  });
});

describe("buildPrintJobBody", () => {
  const spec = { color: "1", mode: "duplex", shipping: "auto" } as const;
  it("baut Letter-Objekt und Zusammenfassung", () => {
    const pdf = Buffer.from("%PDF-1.4\n");
    const { body, summary } = buildPrintJobBody(creds, { pdf, spec, registered: null, filename: "RE-1.pdf", notice: "n".repeat(300) });
    const b = body as { auth: unknown; letter: Record<string, unknown> };
    expect(b.auth).toEqual(expectedAuth);
    expect(b.letter.base64_file).toBe("JVBERi0xLjQK");
    expect(b.letter.base64_file_checksum).toBe("c55802b74cf3b9d15e5bac5664ad7cdf");
    expect(b.letter.filename_original).toBe("RE-1.pdf");
    expect((b.letter.notice as string).length).toBe(255);
    expect(b.letter).not.toHaveProperty("registered");
    expect(b.letter.specification).toEqual(spec);
    const s = JSON.stringify(summary);
    expect(s).not.toContain("base64_file\"");
    expect(s).not.toContain("auth");
    expect(s).not.toContain(creds.apiKey);
    expect(summary).toMatchObject({ base64Length: 12, base64Md5: "c55802b74cf3b9d15e5bac5664ad7cdf", registered: null });
    expect(summary.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("setzt registered, wenn gewaehlt", () => {
    const { body } = buildPrintJobBody(creds, { pdf: Buffer.from("x"), spec, registered: "r2", filename: "a.pdf", notice: "" });
    expect((body as { letter: Record<string, unknown> }).letter.registered).toBe("r2");
  });
});

describe("Client", () => {
  it("balance", async () => {
    const f = fake(ok("balance"));
    expect(await createLetterXpressClient(creds, f.transport).balance()).toEqual({ balanceCents: 5489, currency: "EUR" });
    expect(f.calls[0]).toMatchObject({ method: "GET", path: "/balance" });
    expect(authOf(f.calls[0]!)).toEqual(expectedAuth);
  });

  it("price sendet specification und registered nur wenn gesetzt", async () => {
    const f = fake(ok("price"));
    const c = createLetterXpressClient(creds, f.transport);
    expect(await c.price({ pages: 3, color: "4", duplex: true, shipping: "national", registered: "r1" })).toEqual({ priceCents: 499 });
    await c.price({ pages: 1, color: "1", duplex: false, shipping: "international", registered: null });
    expect(f.calls[0]).toMatchObject({ method: "GET", path: "/price" });
    expect((f.calls[0]!.body as { letter: unknown }).letter).toEqual({
      specification: { pages: 3, color: "4", mode: "duplex", shipping: "national" },
      registered: "r1",
    });
    expect((f.calls[1]!.body as { letter: unknown }).letter).toEqual({
      specification: { pages: 1, color: "1", mode: "simplex", shipping: "international" },
    });
    expect(authOf(f.calls[1]!)).toEqual(expectedAuth);
    // @ts-expect-error "auto" ist bei der Preisabfrage nicht erlaubt
    void c.price({ pages: 1, color: "1", duplex: false, shipping: "auto", registered: null }).catch(() => undefined);
  });

  it("submit parst den Auftrag (draft erlaubt)", async () => {
    const { body } = buildPrintJobBody(creds, {
      pdf: Buffer.from("%PDF-1.4\n"),
      spec: { color: "1", mode: "simplex", shipping: "national" },
      registered: null,
      filename: "RE-2123-00001.pdf",
      notice: "",
    });
    const f = fake(ok("printjob-submit"));
    const job = await createLetterXpressClient(creds, f.transport).submit(body);
    expect(f.calls[0]).toMatchObject({ method: "POST", path: "/printjobs" });
    expect(authOf(f.calls[0]!)).toEqual(expectedAuth);
    expect(job.items[0]).toMatchObject({
      address: "Erika Beispiel, Musterweg 1, 12345 Beispielstadt",
      pages: 1,
      amountCents: 68,
      vatCents: 13,
      trackingCode: null,
    });
    expect(job).toMatchObject({ id: 6035143, status: "queue", filenameOriginal: "RE-2123-00001.pdf" });

    const draft = await createLetterXpressClient(creds, fake(ok("printjob-get-draft")).transport).get(6035143);
    expect(draft.status).toBe("draft");
    const done = await createLetterXpressClient(creds, fake(ok("printjob-get-done")).transport).get(6035143);
    expect(done.items[0]).toMatchObject({ status: "sent", trackingCode: "RC000000000DE", trackingStatus: "Zugestellt" });
  });

  it("get nutzt GET /printjobs/{id}", async () => {
    const f = fake(ok("printjob-get-done"));
    await createLetterXpressClient(creds, f.transport).get(42);
    expect(f.calls[0]).toMatchObject({ method: "GET", path: "/printjobs/42" });
  });

  it("list setzt filter/page und liefert lastPage", async () => {
    const f = fake(ok("printjobs-list"));
    const r = await createLetterXpressClient(creds, f.transport).list("queue", 2);
    expect(f.calls[0]).toMatchObject({ method: "GET", path: "/printjobs", query: { filter: "queue", page: "2" } });
    expect(r.lastPage).toBe(3);
    expect(r.jobs).toHaveLength(2);
  });

  it("remove nutzt DELETE mit Body", async () => {
    const f = fake({ status: 200, json: { status: 200, message: "OK", data: [] } });
    await createLetterXpressClient(creds, f.transport).remove(7);
    expect(f.calls[0]).toMatchObject({ method: "DELETE", path: "/printjobs/7" });
    expect(authOf(f.calls[0]!)).toEqual(expectedAuth);
  });

  it("Timeouts: POST 60 s, sonst 15 s", async () => {
    const f = fake(ok("printjob-submit"));
    const c = createLetterXpressClient(creds, f.transport);
    await c.submit({});
    await c.get(1);
    expect(f.calls.map((x) => x.timeoutMs)).toEqual([60_000, 15_000]);
  });

  it("401 -> LxpAuthError", async () => {
    const c = createLetterXpressClient(creds, fake({ status: 401, json: fx("unauthorized") }).transport);
    await expect(c.balance()).rejects.toBeInstanceOf(LxpAuthError);
    await expect(c.balance()).rejects.toThrow("Zugangsdaten abgelehnt");
  });

  it("400 -> LxpRequestError mit geschwaerztem Text", async () => {
    const c = createLetterXpressClient(
      creds,
      fake({ status: 400, json: { message: `Fehler bei ${creds.apiKey} und ${creds.username}` } }).transport,
    );
    const err = await c.balance().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LxpRequestError);
    expect((err as LxpRequestError).status).toBe(400);
    expect((err as Error).message).not.toContain(creds.apiKey);
    expect((err as Error).message).not.toContain(creds.username);
    expect((err as Error).message).toContain("***");
  });

  it("500, 429 und PostalTransportError -> LxpUnavailableError", async () => {
    for (const r of [
      fake({ status: 500, json: {} }),
      fake({ status: 429, json: {} }),
      fake(new PostalTransportError("Zeitueberschreitung.", "timeout")),
    ]) {
      await expect(createLetterXpressClient(creds, r.transport).balance()).rejects.toBeInstanceOf(LxpUnavailableError);
    }
  });

  it("200 ohne data oder mit unlesbarem Inhalt -> LxpUnavailableError", async () => {
    const noData = createLetterXpressClient(creds, fake({ status: 200, json: { status: 200, message: "OK" } }).transport);
    await expect(noData.balance()).rejects.toBeInstanceOf(LxpUnavailableError);
    const garbage = createLetterXpressClient(creds, fake({ status: 200, json: "x" }).transport);
    await expect(garbage.get(1)).rejects.toBeInstanceOf(LxpUnavailableError);
    const badAmount = createLetterXpressClient(
      creds,
      fake({ status: 200, json: { status: 200, data: { balance: 1e12, currency: "EUR" } } }).transport,
    );
    await expect(badAmount.balance()).rejects.toBeInstanceOf(LxpUnavailableError);
  });
});
