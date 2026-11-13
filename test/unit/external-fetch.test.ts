import { describe, it, expect, vi } from "vitest";
import { externalFetch, ExternalHttpError } from "@/lib/http/external";

const URL_ = "https://example.test/api";

describe("externalFetch (POST)", () => {
  it("sendet Methode, Body und Header", async () => {
    const fetchImpl = vi.fn(async (...args: [string, RequestInit?]) => new Response(args.length >= 0 ? "ok" : "", { status: 200 }));
    const out = await externalFetch(URL_, {
      method: "POST",
      body: '{"a":1}',
      headers: { "content-type": "application/json" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe("ok");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect(init.redirect).toBe("manual");
  });

  it("lehnt Weiterleitung bei POST ab", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://example.test/other" } }));
    await expect(
      externalFetch(URL_, { method: "POST", body: "{}", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ExternalHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("Groessenlimit greift auch bei POST", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(100), { status: 200 }));
    await expect(
      externalFetch(URL_, { method: "POST", body: "{}", maxBytes: 10, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/zu gross/);
  });

  it("GET bleibt unveraendert (Standard)", async () => {
    const fetchImpl = vi.fn(async (...args: [string, RequestInit?]) => new Response(args.length >= 0 ? "g" : "", { status: 200 }));
    await externalFetch(URL_, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});
