import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MailboxError, type MailboxAccount } from "@/lib/mailbox/client";
import { createImapClient, type TestConnector } from "@/lib/mailbox/imap-client";
import { buildMail, xmlBytes } from "../helpers/mail-fixtures";
import {
  createTestTlsMaterial,
  opensslAvailable,
  startImapTestServer,
  type ImapTestServer,
  type TlsMaterial,
} from "../helpers/imap-test-server";

const HOST = "imap.example.org";
const USER = "rechnungen@example.org";
const PASS = "pw-test-123";
// In CI Pflicht, lokal ohne openssl uebersprungen.
const hasOpenssl = opensslAvailable();
if (process.env.CI && !hasOpenssl) throw new Error("openssl fehlt in CI");
const tlsDescribe = hasOpenssl ? describe : describe.skip;

const mails = [
  { raw: buildMail({ subject: "eins", messageId: "<1@l.example.org>", attachments: [{ name: "a.xml", type: "application/xml", data: xmlBytes("a") }] }), internalDate: "2026-10-01T10:00:00Z" },
  { raw: buildMail({ subject: "zwei", messageId: "<2@l.example.org>" }), internalDate: "2026-11-10T10:00:00Z" },
  { raw: buildMail({ subject: "drei", messageId: "<3@l.example.org>" }), flags: ["\\Seen"], internalDate: "2026-11-10T10:00:00Z" },
];

const account = (port: 993 | 143, security: "TLS" | "STARTTLS", over: Partial<MailboxAccount> = {}): MailboxAccount => ({
  host: HOST, port, security, username: USER, password: PASS, folder: "INBOX", ...over,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof MailboxError ? e.code : `OTHER:${String(e)}`;
  }
}

const FORBIDDEN = /^(EXPUNGE|MOVE|COPY|DELETE|APPEND|UID EXPUNGE|UID MOVE|UID COPY|RENAME|CREATE)\b/;

tlsDescribe("IMAP-Adapter gegen lokalen Testserver", () => {
  let material: TlsMaterial;
  let other: TlsMaterial;
  const servers: ImapTestServer[] = [];
  beforeAll(() => {
    material = createTestTlsMaterial(HOST);
    other = createTestTlsMaterial("anderer.example.org");
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  async function start(opts: Parameters<typeof startImapTestServer>[0]): Promise<ImapTestServer> {
    const s = await startImapTestServer({ mails, ...opts });
    servers.push(s);
    return s;
  }
  const connectorFor = (s: ImapTestServer, ca: TlsMaterial = material): TestConnector => ({
    ca: ca.cert,
    target: (host) => ({ host, address: "127.0.0.1", family: 4, port: s.port }),
  });

  it("implizites TLS: Login, uidValidity, Suche, Metadaten, Abruf, markSeen", async () => {
    const s = await start({ mode: "implicit", tlsMaterial: material });
    const session = await createImapClient({ connector: connectorFor(s) }).open(account(993, "TLS"));
    expect(session.uidValidity).toBe("4242");
    expect(await session.searchUnseen(null)).toEqual(["1", "2"]);
    expect(await session.searchUnseen(new Date("2026-11-01T00:00:00Z"))).toEqual(["2"]);
    expect(await session.countUnseen()).toBe(2);
    const meta = await session.meta("1");
    expect(meta?.size).toBe(mails[0]?.raw.length);
    expect(meta?.internalDate?.toISOString().slice(0, 10)).toBe("2026-10-01");
    const raw = await session.fetchRaw("1", 1024 * 1024);
    expect(Buffer.from(raw).equals(Buffer.from(mails[0]?.raw ?? []))).toBe(true);
    await session.markSeen("1");
    expect(s.seen.has(1)).toBe(true);
    await session.close();
    expect(s.commands.some((c) => /^UID STORE 1 \+FLAGS \(\\Seen\)$/.test(c))).toBe(true);
    expect(s.commands.filter((c) => FORBIDDEN.test(c) || /-FLAGS/.test(c))).toEqual([]);
    // Abruf per PEEK: setzt \Seen nicht selbst
    expect(s.commands.some((c) => /BODY\[\]/.test(c) && !/PEEK/.test(c))).toBe(false);
  });

  it("STARTTLS: erst Verschluesselung, dann Anmeldung", async () => {
    const s = await start({ mode: "starttls", tlsMaterial: material });
    const session = await createImapClient({ connector: connectorFor(s) }).open(account(143, "STARTTLS"));
    expect(await session.searchUnseen(null)).toEqual(["1", "2"]);
    await session.close();
    const iStart = s.commands.indexOf("STARTTLS");
    const iAuth = s.commands.findIndex((c) => c === "AUTHENTICATE" || c === "LOGIN");
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iAuth).toBeGreaterThan(iStart);
  });

  it("Server ohne STARTTLS: STARTTLS_MISSING und keine Anmeldung gesendet", async () => {
    const s = await start({ mode: "plain" });
    const code = await codeOf(createImapClient({ connector: connectorFor(s) }).open(account(143, "STARTTLS")));
    expect(code).toBe("STARTTLS_MISSING");
    expect(s.commands.some((c) => c === "AUTHENTICATE" || c === "LOGIN")).toBe(false);
  });

  it("falsches Passwort: AUTH_FAILED ohne Zugangsdaten im Fehler", async () => {
    const s = await start({ mode: "implicit", tlsMaterial: material });
    let err: unknown;
    try {
      await createImapClient({ connector: connectorFor(s) }).open(account(993, "TLS", { password: "falsch-geheim-77" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MailboxError);
    expect((err as MailboxError).code).toBe("AUTH_FAILED");
    const text = JSON.stringify(err, Object.getOwnPropertyNames(err));
    expect(text).not.toContain("falsch-geheim-77");
    expect(text).not.toContain(USER);
    expect(text).not.toContain("Servertext");
  });

  it("nur OAuth angeboten: OAUTH_REQUIRED, kein Login versucht", async () => {
    const s = await start({ mode: "implicit", tlsMaterial: material, oauthOnly: true });
    expect(await codeOf(createImapClient({ connector: connectorFor(s) }).open(account(993, "TLS")))).toBe("OAUTH_REQUIRED");
    expect(s.commands.some((c) => c === "AUTHENTICATE" || c === "LOGIN")).toBe(false);
  });

  it("Zertifikat fuer anderen Namen: TLS_FAILED", async () => {
    const s = await start({ mode: "implicit", tlsMaterial: other });
    // CA vertraut dem fremden Zertifikat, der Name passt aber nicht zu servername = Host.
    expect(await codeOf(createImapClient({ connector: connectorFor(s, other) }).open(account(993, "TLS")))).toBe("TLS_FAILED");
  });

  it("unbekanntes Zertifikat (fremde CA): TLS_FAILED", async () => {
    const s = await start({ mode: "implicit", tlsMaterial: material });
    expect(await codeOf(createImapClient({ connector: connectorFor(s, other) }).open(account(993, "TLS")))).toBe("TLS_FAILED");
  });

  it("nicht vorhandener Ordner: FOLDER_NOT_FOUND", async () => {
    const s = await start({ mode: "implicit", tlsMaterial: material });
    expect(await codeOf(createImapClient({ connector: connectorFor(s) }).open(account(993, "TLS", { folder: "Gibts-nicht" })))).toBe("FOLDER_NOT_FOUND");
  });

  it("luegende Groessenangabe: TOO_LARGE beim Laden", async () => {
    const big = buildMail({ attachments: [{ name: "g.pdf", type: "application/pdf", data: Buffer.alloc(300_000, 0x41) }] });
    const s = await start({ mode: "implicit", tlsMaterial: material, lieAboutSize: true, mails: [{ raw: big }] });
    const session = await createImapClient({ connector: connectorFor(s) }).open(account(993, "TLS"));
    expect((await session.meta("1"))?.size).toBe(100);
    expect(await codeOf(session.fetchRaw("1", 50_000))).toBe("TOO_LARGE");
    await session.close();
  });

  it("Port ausserhalb der Liste wird vor jeder Verbindung abgelehnt", async () => {
    const s = await start({ mode: "implicit", tlsMaterial: material });
    expect(await codeOf(createImapClient({ connector: connectorFor(s) }).open({ ...account(993, "TLS"), port: 995 as unknown as 993 }))).toBe(
      "PORT_NOT_ALLOWED",
    );
  });
});
