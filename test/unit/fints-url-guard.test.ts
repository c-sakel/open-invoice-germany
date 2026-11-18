import { describe, expect, it } from "vitest";
import { FintsError } from "@/lib/fints/client";
import { fintsNetworkBlocked, parseFintsUrl, resolveFintsHost } from "@/lib/fints/url-guard";

const lookupOf = (...addresses: string[]) => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
    return "OK";
  } catch (e) {
    return e instanceof FintsError ? e.code : "OTHER";
  }
}

describe("FinTS-Adresse", () => {
  it("nimmt eine schlichte https-Adresse an", () => {
    expect(parseFintsUrl("https://fints.example.org/fints")).toEqual({ host: "fints.example.org", path: "/fints" });
    expect(parseFintsUrl("https://FINTS.Example.org:443/a/b")).toEqual({ host: "fints.example.org", path: "/a/b" });
    expect(parseFintsUrl("https://fints.example.org")).toEqual({ host: "fints.example.org", path: "/" });
  });

  it.each([
    "http://fints.example.org/",
    "https://fints.example.org:8443/",
    "https://u:p@fints.example.org/",
    "https://fints.example.org/?a=1",
    "https://fints.example.org/?",
    "https://fints.example.org/#x",
    "https://fints.example.org/a b",
    "https://fints.example.org/\u0000",
    "https://fints.example.org/a\\b",
    "https://[::1]/",
    "ftp://fints.example.org/",
    "fints.example.org",
    "",
    `https://fints.example.org/${"a".repeat(300)}`,
    "https://fints.example.org/%2e%2e",
  ])("lehnt %j ab", (raw) => {
    expect(() => parseFintsUrl(raw)).toThrowError(expect.objectContaining({ code: "URL_INVALID" }));
  });

  it("Netzsperre unter Vitest, NODE_ENV=test und FINTS_NETWORK=0", () => {
    expect(fintsNetworkBlocked({ VITEST: "true" })).toBe(true);
    expect(fintsNetworkBlocked({ NODE_ENV: "test" })).toBe(true);
    expect(fintsNetworkBlocked({ FINTS_NETWORK: "0" })).toBe(true);
    expect(fintsNetworkBlocked({ NODE_ENV: "production" })).toBe(false);
    expect(fintsNetworkBlocked({})).toBe(false);
  });
});

describe("Aufloesung des Bankservers", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1", "::ffff:192.168.1.1", "64:ff9b::a00:1", "100.64.0.1", "224.0.0.1"])(
    "sperrt %s",
    async (addr) => {
      expect(await codeOf(resolveFintsHost("fints.example.org", { lookup: lookupOf(addr), env: {} }))).toBe("HOST_BLOCKED");
    },
  );

  it("sperrt den Host, sobald eine Adresse der Antwort gesperrt ist", async () => {
    expect(await codeOf(resolveFintsHost("fints.example.org", { lookup: lookupOf("203.0.113.10", "10.0.0.5"), env: {} }))).toBe("HOST_BLOCKED");
  });

  it("es gibt keinen Schalter fuer private Adressen", async () => {
    const env = { INBOUND_MAIL_ALLOW_PRIVATE: "1", FINTS_ALLOW_PRIVATE: "1" };
    expect(await codeOf(resolveFintsHost("fints.example.org", { lookup: lookupOf("10.0.0.5"), env }))).toBe("HOST_BLOCKED");
  });

  it("loest einmal auf und bevorzugt IPv4", async () => {
    let calls = 0;
    const lookup = async () => {
      calls++;
      return [{ address: "2606:4700:4700::1111", family: 6 }, { address: "203.0.113.10", family: 4 }];
    };
    expect(await resolveFintsHost("Fints.Example.org", { lookup, env: {} })).toEqual({ host: "fints.example.org", address: "203.0.113.10", family: 4 });
    expect(calls).toBe(1);
  });

  it("Allowlist FINTS_HOSTS", async () => {
    const env = { FINTS_HOSTS: "fints.example.org, andere.example.org" };
    expect((await resolveFintsHost("andere.example.org", { lookup: lookupOf("203.0.113.10"), env })).address).toBe("203.0.113.10");
    expect(await codeOf(resolveFintsHost("fremd.example.org", { lookup: lookupOf("203.0.113.10"), env }))).toBe("HOST_NOT_ALLOWED");
  });

  it("DNS-Fehler, leere Antwort und Zeitablauf", async () => {
    expect(await codeOf(resolveFintsHost("fints.example.org", { lookup: async () => { throw new Error("x"); }, env: {} }))).toBe("DNS_FAILED");
    expect(await codeOf(resolveFintsHost("fints.example.org", { lookup: lookupOf(), env: {} }))).toBe("DNS_FAILED");
    const hang = () => new Promise<{ address: string; family: number }[]>(() => undefined);
    expect(await codeOf(resolveFintsHost("fints.example.org", { lookup: hang, env: {}, dnsTimeoutMs: 50 }))).toBe("DNS_FAILED");
  });

  it("ungueltige Hostnamen", async () => {
    for (const host of ["", "a b", "x/y", "x@y", "[::1]"]) {
      expect(await codeOf(resolveFintsHost(host, { lookup: lookupOf("203.0.113.10"), env: {} }))).toBe("URL_INVALID");
    }
  });
});
