import { describe, expect, it } from "vitest";
import { createImapClient } from "@/lib/mailbox/imap-client";
import { MailboxError } from "@/lib/mailbox/client";
import { assertAllowedPort, isBlockedAddress, mailboxNetworkBlocked, resolveMailHost } from "@/lib/mailbox/net-guard";

const lookupOf = (...addresses: string[]) => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof MailboxError ? e.code : "OTHER";
  }
}

describe("Netzpruefung Postfach", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1",
    "::ffff:7f00:1", "64:ff9b::a00:1", "0.0.0.0", "224.0.0.1", "192.168.0.10", "172.16.5.5", "not-an-ip",
  ])("sperrt %s", (addr) => {
    expect(isBlockedAddress(addr, {})).toBe(true);
  });

  it.each(["8.8.8.8", "203.0.113.10", "172.32.0.1", "::ffff:8.8.8.8", "2606:4700:4700::1111"])("laesst %s zu", (addr) => {
    expect(isBlockedAddress(addr, {})).toBe(false);
  });

  it("ALLOW_PRIVATE hebt nur private Bereiche auf, nie Loopback/Metadaten", () => {
    const env = { INBOUND_MAIL_ALLOW_PRIVATE: "1" };
    expect(isBlockedAddress("10.1.2.3", env)).toBe(false);
    expect(isBlockedAddress("fd00::1", env)).toBe(false);
    expect(isBlockedAddress("127.0.0.1", env)).toBe(true);
    expect(isBlockedAddress("169.254.169.254", env)).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254", env)).toBe(true);
    expect(isBlockedAddress("::1", env)).toBe(true);
  });

  it("loest auf, prueft alle Adressen und pinnt die erste geprueft Adresse", async () => {
    const t = await resolveMailHost("imap.example.org", 993, { lookup: lookupOf("203.0.113.10"), env: {} });
    expect(t).toEqual({ host: "imap.example.org", address: "203.0.113.10", family: 4, port: 993 });
    expect(await codeOf(resolveMailHost("imap.example.org", 993, { lookup: lookupOf("203.0.113.10", "10.0.0.5"), env: {} }))).toBe("HOST_BLOCKED");
    expect(await codeOf(resolveMailHost("localhost", 993, { lookup: lookupOf("::1", "127.0.0.1"), env: {} }))).toBe("HOST_BLOCKED");
    expect(await codeOf(resolveMailHost("imap.example.org", 993, { lookup: lookupOf(), env: {} }))).toBe("DNS_FAILED");
    expect(
      await codeOf(resolveMailHost("imap.example.org", 993, { lookup: async () => { throw new Error("ENOTFOUND"); }, env: {} })),
    ).toBe("DNS_FAILED");
  });

  it("Allowlist und private Freigabe", async () => {
    const env = { INBOUND_MAIL_HOSTS: "mail.example.org, imap.example.org" };
    await expect(resolveMailHost("imap.example.org", 993, { lookup: lookupOf("203.0.113.10"), env })).resolves.toBeTruthy();
    expect(await codeOf(resolveMailHost("andere.example.org", 993, { lookup: lookupOf("203.0.113.10"), env }))).toBe("HOST_NOT_ALLOWED");
    const lan = { INBOUND_MAIL_ALLOW_PRIVATE: "1" };
    await expect(resolveMailHost("imap.example.org", 143, { lookup: lookupOf("10.0.0.5"), env: lan })).resolves.toBeTruthy();
    expect(await codeOf(resolveMailHost("imap.example.org", 143, { lookup: lookupOf("169.254.169.254"), env: lan }))).toBe("HOST_BLOCKED");
  });

  it.each(["imap.example.org:993", "https://imap.example.org", "imap.example.org\n", "imap.example.org/pfad", "a b", "u@imap.example.org", ""])(
    "lehnt Host %j ab",
    async (host) => {
      expect(await codeOf(resolveMailHost(host, 993, { lookup: lookupOf("203.0.113.10"), env: {} }))).toBe("HOST_NOT_ALLOWED");
    },
  );

  it("erlaubt nur 993 mit TLS und 143 mit STARTTLS", () => {
    expect(() => assertAllowedPort(993, "TLS")).not.toThrow();
    expect(() => assertAllowedPort(143, "STARTTLS")).not.toThrow();
    for (const [p, s] of [[25, "TLS"], [465, "TLS"], [995, "TLS"], [8993, "TLS"], [993, "STARTTLS"], [143, "TLS"]] as [number, string][]) {
      expect(() => assertAllowedPort(p, s)).toThrow(MailboxError);
    }
  });

  it("Netzsperre unter Vitest ohne Connector", async () => {
    expect(mailboxNetworkBlocked()).toBe(true);
    expect(mailboxNetworkBlocked({ INBOUND_MAIL_NETWORK: "0" })).toBe(true);
    expect(mailboxNetworkBlocked({})).toBe(false);
    const client = createImapClient();
    const code = await codeOf(client.open({ host: "imap.example.org", port: 993, security: "TLS", username: "u@example.org", password: "x", folder: "INBOX" }));
    expect(code).toBe("NETWORK_BLOCKED");
    expect(
      await codeOf(client.open({ host: "imap.example.org", port: 25 as unknown as 993, security: "TLS", username: "u@example.org", password: "x", folder: "INBOX" })),
    ).toBe("PORT_NOT_ALLOWED");
  });
});
