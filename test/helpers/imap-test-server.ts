/**
 * Lokaler Skript-IMAP-Server fuer Adaptertests (nur 127.0.0.1, nie ein echter Server). Kann implizites TLS,
 * Klartext mit STARTTLS und Klartext ohne STARTTLS. Das Zertifikat entsteht zur Laufzeit per openssl in einem
 * Temp-Verzeichnis und liegt danach nur im Speicher. Protokolliert alle empfangenen Kommandos.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

export interface TestMail {
  raw: Uint8Array;
  flags?: string[];
  /** ISO-Datum, Standard 2026-11-10. */
  internalDate?: string;
}

export interface TlsMaterial {
  cert: string;
  key: string;
}

export interface ImapTestServerOptions {
  mode: "implicit" | "starttls" | "plain";
  tlsMaterial?: TlsMaterial;
  mails?: TestMail[];
  uidValidity?: number;
  failLogin?: boolean;
  oauthOnly?: boolean;
  /** Server meldet falsche (kleine) Groesse und ignoriert Teilbereiche. */
  lieAboutSize?: boolean;
  expectedUser?: string;
  expectedPassword?: string;
}

export interface ImapTestServer {
  port: number;
  /** Empfangene Kommandos (LOGIN/AUTHENTICATE ohne Zugangsdaten). */
  commands: string[];
  /** Gespeicherte Flags je UID. */
  seen: Set<number>;
  close(): Promise<void>;
}

/** Ist openssl vorhanden? */
export function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Selbstsigniertes Zertifikat fuer einen DNS-Namen; Dateien nur kurz im Temp-Verzeichnis, ohne .pem-Namen. */
export function createTestTlsMaterial(dnsName: string): TlsMaterial {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-test-"));
  try {
    const certFile = path.join(dir, "server-cert.txt");
    const keyFile = path.join(dir, "server-k8.txt");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-keyout", keyFile, "-out", certFile, "-days", "2", "-subj", `/CN=${dnsName}`,
        "-addext", `subjectAltName=DNS:${dnsName}`,
      ],
      { stdio: "ignore" },
    );
    return { cert: fs.readFileSync(certFile, "utf8"), key: fs.readFileSync(keyFile, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function expand(set: string, n: number): number[] {
  const out: number[] = [];
  for (const part of set.split(",")) {
    const [a = "", b] = part.split(":");
    const lo = a === "*" ? n : Number(a);
    const hi = b === undefined ? lo : b === "*" ? n : Number(b);
    for (let k = Math.min(lo, hi); k <= Math.max(lo, hi); k++) out.push(k);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseImapDate(s: string): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2]?.toLowerCase());
  return mon < 0 ? null : Date.UTC(Number(m[3]), mon, Number(m[1]));
}

export async function startImapTestServer(opts: ImapTestServerOptions): Promise<ImapTestServer> {
  const mails = opts.mails ?? [];
  const commands: string[] = [];
  const seen = new Set<number>();
  mails.forEach((m, i) => {
    if (m.flags?.includes("\\Seen")) seen.add(i + 1);
  });
  const user = opts.expectedUser ?? "rechnungen@example.org";
  const pass = opts.expectedPassword ?? "pw-test-123";
  const uidValidity = opts.uidValidity ?? 4242;
  const material = opts.tlsMaterial ?? null;

  const caps = (secure: boolean): string => {
    const c = ["IMAP4rev1", "ID", "ENABLE", "UIDPLUS", "NAMESPACE"];
    if (opts.mode === "starttls" && !secure) c.push("STARTTLS");
    if (opts.oauthOnly) c.push("AUTH=XOAUTH2", "LOGINDISABLED");
    else c.push("AUTH=PLAIN");
    return c.join(" ");
  };

  function handle(sock: net.Socket, secure: boolean, greet: boolean): void {
    let buf = "";
    let authTag: string | null = null;
    const w = (s: string) => sock.write(s, "latin1");
    sock.setEncoding("latin1");
    sock.on("error", () => undefined);
    const onLine = (line: string): void => {
      if (authTag) {
        const tag = authTag;
        authTag = null;
        commands.push("<auth-continuation>");
        const [, u = "", p = ""] = Buffer.from(line, "base64").toString("latin1").split("\0");
        if (opts.failLogin || u !== user || p !== pass) w(`${tag} NO [AUTHENTICATIONFAILED] Servertext mit ${u}\r\n`);
        else w(`${tag} OK [CAPABILITY ${caps(secure)}] ok\r\n`);
        return;
      }
      const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
      if (!m?.[1] || !m[2]) return;
      const tag = m[1];
      const cmd = m[2].toUpperCase();
      const args = m[3] ?? "";
      commands.push(cmd === "LOGIN" || cmd === "AUTHENTICATE" ? cmd : `${cmd} ${args}`.trim());
      switch (cmd) {
        case "CAPABILITY": w(`* CAPABILITY ${caps(secure)}\r\n${tag} OK done\r\n`); break;
        case "STARTTLS": {
          if (!material || opts.mode !== "starttls") { w(`${tag} BAD no\r\n`); break; }
          w(`${tag} OK begin TLS\r\n`);
          sock.removeAllListeners("data");
          handle(new tls.TLSSocket(sock, { isServer: true, cert: material.cert, key: material.key }), true, false);
          break;
        }
        case "LOGIN":
          w(`${tag} NO [AUTHENTICATIONFAILED] Servertext\r\n`);
          break;
        case "AUTHENTICATE":
          if (opts.oauthOnly) w(`${tag} NO unsupported\r\n`);
          else {
            const inline = /^PLAIN\s+(\S+)/i.exec(args)?.[1];
            if (inline) {
              const [, u = "", p = ""] = Buffer.from(inline, "base64").toString("latin1").split("\0");
              if (opts.failLogin || u !== user || p !== pass) w(`${tag} NO [AUTHENTICATIONFAILED] Servertext mit ${u}\r\n`);
              else w(`${tag} OK [CAPABILITY ${caps(secure)}] ok\r\n`);
            } else { authTag = tag; w("+ \r\n"); }
          }
          break;
        case "ID": w(`* ID NIL\r\n${tag} OK done\r\n`); break;
        case "ENABLE": w(`${tag} OK done\r\n`); break;
        case "NAMESPACE": w(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`); break;
        case "LIST": w(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`); break;
        case "LSUB": w(`${tag} OK done\r\n`); break;
        case "STATUS": w(`* STATUS INBOX (MESSAGES ${mails.length})\r\n${tag} OK done\r\n`); break;
        case "SELECT": case "EXAMINE":
          if (!/^"?INBOX"?$/i.test(args.trim())) { w(`${tag} NO [NONEXISTENT] unknown\r\n`); break; }
          w(`* ${mails.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${uidValidity}] ok\r\n* OK [UIDNEXT ${mails.length + 1}] ok\r\n* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* OK [PERMANENTFLAGS (\\Seen \\*)] ok\r\n${tag} OK [READ-WRITE] done\r\n`);
          break;
        case "NOOP": case "CLOSE": w(`${tag} OK done\r\n`); break;
        case "LOGOUT": w(`* BYE bye\r\n${tag} OK done\r\n`); sock.end(); break;
        case "UID": {
          const m2 = /^(\S+) (\S+)(?: (.*))?$/.exec(args);
          const sub = m2?.[1]?.toUpperCase();
          if (!m2?.[2]) { w(`${tag} BAD\r\n`); break; }
          if (sub === "SEARCH") {
            const unseen = /UNSEEN/i.test(args);
            const since = /SINCE (\S+)/i.exec(args)?.[1];
            const sinceMs = since ? parseImapDate(since) : null;
            const uids = mails
              .map((_, k) => k + 1)
              .filter((u) => !unseen || !seen.has(u))
              .filter((u) => sinceMs === null || Date.parse(mails[u - 1]?.internalDate ?? "2026-11-10T10:00:00Z") >= sinceMs);
            w(`* SEARCH ${uids.join(" ")}\r\n${tag} OK done\r\n`);
          } else if (sub === "FETCH") {
            const items = (m2[3] ?? "").toUpperCase();
            for (const u of expand(m2[2], mails.length)) {
              const mail = mails[u - 1];
              if (!mail) continue;
              const raw = Buffer.from(mail.raw);
              const parts = [`UID ${u}`];
              if (/RFC822\.SIZE/.test(items)) parts.push(`RFC822.SIZE ${opts.lieAboutSize ? 100 : raw.length}`);
              if (/FLAGS/.test(items)) parts.push(`FLAGS (${seen.has(u) ? "\\Seen" : ""})`);
              if (/INTERNALDATE/.test(items)) {
                const d = new Date(mail.internalDate ?? "2026-11-10T10:00:00Z");
                parts.push(`INTERNALDATE "${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} 10:00:00 +0000"`);
              }
              const range = /BODY(?:\.PEEK)?\[\]<(\d+)\.(\d+)>/.exec(items);
              if (range?.[1] && range[2] && !opts.lieAboutSize) {
                const s = Number(range[1]);
                const chunk = raw.subarray(s, s + Number(range[2]));
                parts.push(`BODY[]<${s}> {${chunk.length}}\r\n`);
                w(`* ${u} FETCH (${parts.join(" ")}`); sock.write(chunk); w(")\r\n");
              } else if (/BODY(?:\.PEEK)?\[\]/.test(items)) {
                parts.push(`BODY[] {${raw.length}}\r\n`);
                w(`* ${u} FETCH (${parts.join(" ")}`); sock.write(raw); w(")\r\n");
              } else w(`* ${u} FETCH (${parts.join(" ")})\r\n`);
            }
            w(`${tag} OK done\r\n`);
          } else if (sub === "STORE") {
            if (/-FLAGS/i.test(args) || !/\+FLAGS/i.test(args)) { w(`${tag} BAD refused\r\n`); break; }
            for (const u of expand(m2[2], mails.length)) seen.add(u);
            w(`${tag} OK done\r\n`);
          } else w(`${tag} BAD unsupported\r\n`);
          break;
        }
        default: w(`${tag} BAD unknown command\r\n`);
      }
    };
    sock.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
    if (greet) {
      sock.write(`* OK [CAPABILITY ${caps(secure)}] ready\r\n`, "latin1");
    }
  }

  const server: net.Server =
    opts.mode === "implicit" && material
      ? tls.createServer({ cert: material.cert, key: material.key }, (s) => handle(s, true, true))
      : net.createServer((s) => handle(s, false, true));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    commands,
    seen,
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
        (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}
