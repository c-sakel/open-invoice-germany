/** MIME-Erzeuger fuer Tests (nur fiktive Daten, example.org). */

export interface FixtureAttachment {
  name: string | null;
  type: string;
  data: Uint8Array;
  /** Statt `filename="..."` ein eigener Parameterblock (z. B. RFC 2231). */
  dispositionParams?: string;
  disposition?: "attachment" | "inline" | null;
}

export interface FixtureMail {
  from?: string;
  subject?: string;
  messageId?: string | null;
  date?: string;
  text?: string;
  html?: string;
  attachments?: FixtureAttachment[];
  /** Zusaetzliche Kopfzeilen. */
  extraHeaders?: string[];
}

const BOUNDARY = "=_fixture_boundary_1";

function base64Lines(data: Uint8Array): string {
  const b64 = Buffer.from(data).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

function attachmentPart(a: FixtureAttachment): string {
  const dispo = a.disposition === undefined ? "attachment" : a.disposition;
  const name = a.name === null ? "" : `; name="${a.name}"`;
  const params = a.dispositionParams ?? (a.name === null ? "" : `; filename="${a.name}"`);
  return [
    `Content-Type: ${a.type}${name}`,
    "Content-Transfer-Encoding: base64",
    ...(dispo === null ? [] : [`Content-Disposition: ${dispo}${params}`]),
    "",
    base64Lines(a.data),
  ].join("\r\n");
}

export function buildMail(m: FixtureMail = {}): Buffer {
  const headers = [
    `From: ${m.from ?? "Lieferant <rechnung@lieferant.example.org>"}`,
    "To: rechnungen@example.org",
    `Subject: ${m.subject ?? "Rechnung 2026-001"}`,
    `Date: ${m.date ?? "Tue, 10 Nov 2026 10:00:00 +0000"}`,
    ...(m.messageId === null ? [] : [`Message-ID: ${m.messageId ?? "<MSG-1@lieferant.example.org>"}`]),
    "MIME-Version: 1.0",
    ...(m.extraHeaders ?? []),
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
  ];
  const body: string[] = [];
  if (m.text !== undefined) body.push(`Content-Type: text/plain; charset=utf-8\r\n\r\n${m.text}`);
  if (m.html !== undefined) body.push(`Content-Type: text/html; charset=utf-8\r\n\r\n${m.html}`);
  for (const a of m.attachments ?? []) body.push(attachmentPart(a));
  const parts = body.map((p) => `--${BOUNDARY}\r\n${p}\r\n`).join("");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts}--${BOUNDARY}--\r\n`, "latin1");
}

/** Kleine UBL-Rechnung als Anlage (Inhalt fuer die Zerlegung egal, nur Magic Bytes). */
export function xmlBytes(label = "x"): Uint8Array {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>${label}</ID></Invoice>`);
}

export function pdfBytes(size = 200): Uint8Array {
  const body = Buffer.alloc(Math.max(0, size - 9), 0x20);
  return Buffer.concat([Buffer.from("%PDF-1.7\n"), body]);
}

/** Mail, in der `depth` multipart-Ebenen ineinander liegen; die Anlage liegt in der innersten. */
export function buildNestedMail(depth: number, att: FixtureAttachment): Buffer {
  let inner = attachmentPart(att);
  for (let d = depth; d >= 1; d--) {
    const b = `=_nest_${d}`;
    inner = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${inner}\r\n--${b}--\r\n`;
  }
  const head = [
    "From: Lieferant <rechnung@lieferant.example.org>",
    "To: rechnungen@example.org",
    "Subject: verschachtelt",
    "Message-ID: <nest@lieferant.example.org>",
    "MIME-Version: 1.0",
  ].join("\r\n");
  return Buffer.from(`${head}\r\n${inner.startsWith("Content-Type") ? inner : `\r\n${inner}`}`, "latin1");
}

/** Mail mit sehr vielen (leeren) Teilen. */
export function buildManyPartsMail(count: number): Buffer {
  const parts = Array.from({ length: count }, (_, i) => `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\np${i}\r\n`).join("");
  return Buffer.from(
    `From: a@lieferant.example.org\r\nSubject: viele\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${BOUNDARY}"\r\n\r\n${parts}--${BOUNDARY}--\r\n`,
    "latin1",
  );
}

/** message/rfc822 mit eingebetteter Mail, die die Anlage traegt. */
export function buildForwardedMail(att: FixtureAttachment): Buffer {
  const inner = buildMail({ subject: "weitergeleitet", attachments: [att] }).toString("latin1");
  return Buffer.from(
    [
      "From: Chef <chef@example.org>",
      "To: rechnungen@example.org",
      "Subject: Fwd",
      "Message-ID: <fwd@example.org>",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="=_fwd"`,
      "",
      "--=_fwd",
      "Content-Type: text/plain",
      "",
      "siehe Anhang",
      "--=_fwd",
      "Content-Type: message/rfc822",
      "Content-Disposition: inline",
      "",
      inner,
      "--=_fwd--",
      "",
    ].join("\r\n"),
    "latin1",
  );
}
