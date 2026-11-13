import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { toNodemailerMessage } from "@/lib/mail/smtp";
import type { OutgoingMail } from "@/lib/mail/provider";

const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
const base: OutgoingMail = {
  from: { name: "Absender", address: "a@example.org" },
  to: ["b@example.org"], cc: [], bcc: [], subject: "Betreff",
  text: "Hallo Welt\nZeile 2 mit Umlaut äöü",
  attachments: [],
};
async function raw(mail: OutgoingMail): Promise<string> {
  const info = await transport.sendMail(toNodemailerMessage(mail));
  return (info.message as Buffer).toString();
}
const header = (s: string) => /^Content-Type: ([^;\r\n]+)/im.exec(s)?.[1];

describe("toNodemailerMessage / MIME", () => {
  it("html + Anhang: mixed > alternative, Text vor HTML, Anhang danach", async () => {
    const s = await raw({
      ...base, html: "<p>Hallo</p>",
      attachments: [{ filename: "r.pdf", content: Buffer.from("PDF"), contentType: "application/pdf" }],
    });
    expect(header(s)).toBe("multipart/mixed");
    const iAlt = s.indexOf("multipart/alternative");
    const iPlain = s.indexOf("text/plain");
    const iHtml = s.indexOf("text/html");
    const iPdf = s.indexOf("application/pdf");
    expect(iAlt).toBeGreaterThan(0);
    expect(iAlt).toBeLessThan(iPlain);
    expect(iPlain).toBeLessThan(iHtml);
    expect(iHtml).toBeLessThan(iPdf);
  });
  it("html ohne Anhang: multipart/alternative", async () => {
    const s = await raw({ ...base, html: "<p>Hallo</p>" });
    expect(header(s)).toBe("multipart/alternative");
  });
  it("ohne html: kein alternative, kein text/html", async () => {
    const s = await raw(base);
    expect(s).not.toContain("multipart/alternative");
    expect(s).not.toContain("text/html");
    expect("html" in toNodemailerMessage(base)).toBe(false);
  });
  it("Textteil dekodiert gleich mail.text", async () => {
    const s = await raw({ ...base, html: "<p>x</p>" });
    const plain = s.slice(s.indexOf("text/plain"));
    const enc = /Content-Transfer-Encoding: ([^\n]+)/i.exec(plain)?.[1]?.trim();
    const part = plain.split("\n\n")[1].split("\n--")[0];
    const decoded =
      enc === "quoted-printable"
        ? Buffer.from(part.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8")
        : enc === "base64"
          ? Buffer.from(part, "base64").toString("utf8")
          : part;
    expect(decoded.replace(/\n$/, "")).toBe(base.text);
  });
});
