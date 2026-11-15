import { describe, expect, it, vi } from "vitest";
import { ExternalHttpError, externalRequest } from "@/lib/http/external";

const reply = (status: number, body = "", headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch;

describe("externalRequest", () => {
  it("liefert 201 und 422 mit Text", async () => {
    expect(await externalRequest("https://api.example.org/x", { method: "POST", body: "{}", fetchImpl: reply(201, "ok") })).toEqual({ status: 201, text: "ok" });
    expect(await externalRequest("https://api.example.org/x", { method: "GET", fetchImpl: reply(422, "nein") })).toEqual({ status: 422, text: "nein" });
  });
  it("lehnt 3xx ohne Folgeaufruf ab", async () => {
    const f = reply(302, "", { location: "https://api.example.org/y" });
    await expect(externalRequest("https://api.example.org/x", { method: "GET", fetchImpl: f })).rejects.toBeInstanceOf(ExternalHttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("lehnt http ab, ohne aufzurufen", async () => {
    const f = reply(200);
    await expect(externalRequest("http://api.example.org/x", { method: "GET", fetchImpl: f })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it("begrenzt die Antwortgroesse", async () => {
    await expect(externalRequest("https://api.example.org/x", { method: "GET", maxBytes: 5, fetchImpl: reply(200, "0123456789") })).rejects.toThrow(/zu gross/);
  });
  it("bricht bei Zeitueberschreitung ab, ohne Details preiszugeben", async () => {
    const f = vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("secret-detail")))),
    ) as unknown as typeof fetch;
    const err = await externalRequest("https://api.example.org/x", { method: "GET", timeoutMs: 20, fetchImpl: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalHttpError);
    expect((err as Error).message).not.toContain("secret-detail");
  });
});
