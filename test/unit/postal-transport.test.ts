/**
 * Phase 16d T2 — Transport: nur lokaler http-Server auf 127.0.0.1 (nie das echte Netz).
 * `https.request` darf in keinem Test aufgerufen werden.
 */
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PostalNetworkForbiddenError,
  PostalTransportError,
  createHttpsTransport,
  defaultTransport,
} from "@/lib/postal/transport";

let server: http.Server;
let base = "";
const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let redirectTargetHits = 0;
let httpsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.startsWith("/v3/target")) {
        redirectTargetHits += 1;
        res.end("{}");
        return;
      }
      seen.push({ method: req.method, url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (url.startsWith("/v3/big")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ pad: "x".repeat(5000) }));
      } else if (url.startsWith("/v3/redirect")) {
        res.statusCode = 302;
        res.setHeader("location", `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3/target`);
        res.end();
      } else if (url.startsWith("/v3/hang")) {
        // antwortet nie
      } else if (url.startsWith("/v3/bad")) {
        res.end("<html>");
      } else if (url.startsWith("/v3/401")) {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: "Unauthorized." }));
      } else if (url.startsWith("/v3/500")) {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: "boom" }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
  redirectTargetHits = 0;
  httpsSpy = vi.spyOn(https, "request");
});

afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const t = (opts: { maxResponseBytes?: number } = {}) =>
  createHttpsTransport({ requestImpl: http.request as unknown as typeof https.request, baseUrl: base, ...opts });

describe("createHttpsTransport", () => {
  it("sendet bei GET JSON-Body, Header und kodierte Query", async () => {
    const res = await t()({ method: "GET", path: "/printjobs", query: { filter: "queue", q: "a b&c" }, body: { auth: { x: 1 } }, timeoutMs: 2000 });
    expect(res).toEqual({ status: 200, json: { ok: true } });
    const r = seen[0]!;
    expect(r.method).toBe("GET");
    expect(r.url).toBe("/v3/printjobs?filter=queue&q=a+b%26c");
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers.accept).toBe("application/json");
    expect(JSON.parse(r.body)).toEqual({ auth: { x: 1 } });
    expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(r.body));
  });

  it("zu grosse Antwort -> too_large", async () => {
    await expect(t({ maxResponseBytes: 100 })({ method: "GET", path: "/big", body: {}, timeoutMs: 2000 })).rejects.toMatchObject({
      name: "PostalTransportError",
      kind: "too_large",
    });
  });

  it("302 -> redirect, Ziel wird nie aufgerufen", async () => {
    await expect(t()({ method: "GET", path: "/redirect", body: {}, timeoutMs: 2000 })).rejects.toMatchObject({ kind: "redirect" });
    await new Promise((r) => setTimeout(r, 50));
    expect(redirectTargetHits).toBe(0);
  });

  it("keine Antwort -> timeout", async () => {
    const started = Date.now();
    await expect(t()({ method: "GET", path: "/hang", body: {}, timeoutMs: 150 })).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("kaputtes JSON -> bad_json", async () => {
    const p = t()({ method: "GET", path: "/bad", body: {}, timeoutMs: 2000 });
    await expect(p).rejects.toBeInstanceOf(PostalTransportError);
    await expect(p).rejects.toMatchObject({ kind: "bad_json" });
  });

  it("Status 401 und 500 werden durchgereicht", async () => {
    expect(await t()({ method: "POST", path: "/401", body: {}, timeoutMs: 2000 })).toEqual({ status: 401, json: { message: "Unauthorized." } });
    expect(await t()({ method: "DELETE", path: "/500", body: {}, timeoutMs: 2000 })).toEqual({ status: 500, json: { message: "boom" } });
  });

  it("ohne requestImpl nur HTTPS", () => {
    expect(() => createHttpsTransport({ baseUrl: "http://127.0.0.1:1/v3" })).toThrow("Nur HTTPS");
  });
});

describe("defaultTransport (Notschalter)", () => {
  it("unter Vitest -> PostalNetworkForbiddenError", async () => {
    await expect(defaultTransport()({ method: "GET", path: "/balance", body: {}, timeoutMs: 1000 })).rejects.toBeInstanceOf(
      PostalNetworkForbiddenError,
    );
  });

  it("mit POSTAL_NETWORK=0 ebenfalls", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("POSTAL_NETWORK", "0");
    await expect(defaultTransport()({ method: "GET", path: "/balance", body: {}, timeoutMs: 1000 })).rejects.toBeInstanceOf(
      PostalNetworkForbiddenError,
    );
  });
});

describe("Notbremse im Request-Pfad", () => {
  it("createHttpsTransport ohne requestImpl sendet unter Vitest nie", async () => {
    const spy = vi.spyOn(https, "request");
    const t = createHttpsTransport();
    await expect(t({ method: "GET", path: "/balance", body: {}, timeoutMs: 1000 })).rejects.toBeInstanceOf(PostalNetworkForbiddenError);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
