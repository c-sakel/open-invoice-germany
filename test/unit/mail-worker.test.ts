import { describe, expect, it } from "vitest";
import { MAX_MAIL_ATTACHMENT_BYTES } from "@/domain/mailbox/limits";
import { parseMailIsolated } from "@/lib/mailbox/parse-mail";
import { runIsolated } from "@/lib/worker/isolated";
import {
  buildForwardedMail,
  buildManyPartsMail,
  buildMail,
  buildNestedMail,
  pdfBytes,
  xmlBytes,
} from "../helpers/mail-fixtures";

const xmlAtt = (name = "rechnung.xml") => ({ name, type: "application/xml", data: xmlBytes(name) });

describe("Mail-Worker", () => {
  it("liefert XML und PDF, aber nie Text oder HTML", async () => {
    const raw = buildMail({
      text: "GEHEIMER-TEXT",
      html: "<p>GEHEIMES-HTML</p>",
      attachments: [xmlAtt(), { name: "rechnung.pdf", type: "application/pdf", data: pdfBytes() }],
    });
    const r = await parseMailIsolated(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mail.attachments.map((a) => a.fileName)).toEqual(["rechnung.xml", "rechnung.pdf"]);
    expect(Buffer.from(r.mail.attachments[0]?.bytes ?? []).toString().startsWith("<?xml")).toBe(true);
    expect(JSON.stringify(r.mail, (_k, v) => (v instanceof Uint8Array ? "" : v))).not.toMatch(/GEHEIM/);
    expect(r.mail.senderDomain).toBe("lieferant.example.org");
    expect(r.mail.subject).toBe("Rechnung 2026-001");
    expect(r.mail.date?.toISOString()).toBe("2026-11-10T10:00:00.000Z");
    expect(r.mail.messageIdHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Message-Id-Hash ignoriert Klammern und Gross-/Kleinschreibung", async () => {
    const a = await parseMailIsolated(buildMail({ messageId: "<ABC@Lieferant.example.org>" }));
    const b = await parseMailIsolated(buildMail({ messageId: "<abc@lieferant.example.org>" }));
    expect(a.ok && b.ok && a.mail.messageIdHash === b.mail.messageIdHash && a.mail.messageIdHash !== null).toBe(true);
    const none = await parseMailIsolated(buildMail({ messageId: null }));
    expect(none.ok && none.mail.messageIdHash).toBeNull();
  });

  it("liest Dateinamen nach RFC 2231 und Encoded-Words", async () => {
    const raw = buildMail({
      attachments: [
        { name: null, type: "application/xml", data: xmlBytes(), dispositionParams: "; filename*0*=utf-8''Rechnung%20; filename*1*=M%C3%BCller.xml" },
        { name: "=?utf-8?B?UmVjaG51bmctw5xiZXIucGRm?=", type: "application/pdf", data: pdfBytes() },
      ],
    });
    const r = await parseMailIsolated(raw);
    expect(r.ok && r.mail.attachments.map((a) => a.fileName)).toEqual(["Rechnung Müller.xml", "Rechnung-Über.pdf"]);
  });

  it("findet Anlagen in weitergeleiteten Mails (message/rfc822)", async () => {
    const r = await parseMailIsolated(buildForwardedMail(xmlAtt("fwd.xml")));
    expect(r.ok && r.mail.attachments.map((a) => a.fileName)).toEqual(["fwd.xml"]);
  });

  it("findet Anlagen bei Verschachtelung 5, lehnt Tiefe 6 ab", async () => {
    const ok = await parseMailIsolated(buildNestedMail(4, xmlAtt()));
    expect(ok.ok && ok.mail.attachments.length).toBe(1);
    const tooDeep = await parseMailIsolated(buildNestedMail(6, xmlAtt()));
    expect(tooDeep).toEqual({ ok: false, code: "LIMIT" });
  });

  it("lehnt 101 Teile ab", async () => {
    expect(await parseMailIsolated(buildManyPartsMail(101))).toEqual({ ok: false, code: "LIMIT" });
    const ok = await parseMailIsolated(buildManyPartsMail(50));
    expect(ok.ok).toBe(true);
  });

  it("lehnt einen Kopfbereich ueber 64 KB ab", async () => {
    const raw = buildMail({ extraHeaders: [`X-Fuell: ${"a".repeat(70 * 1024)}`] });
    expect(await parseMailIsolated(raw)).toEqual({ ok: false, code: "LIMIT" });
  });

  it("nimmt 10 Anlagen und meldet die elfte als TOO_MANY", async () => {
    const attachments = Array.from({ length: 11 }, (_, i) => xmlAtt(`r${i}.xml`));
    const r = await parseMailIsolated(buildMail({ attachments }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mail.attachments).toHaveLength(10);
    expect(r.mail.skipped).toEqual([{ index: 10, reason: "TOO_MANY" }]);
  });

  it("ueberspringt eine zu grosse Anlage", async () => {
    const big = Buffer.alloc(MAX_MAIL_ATTACHMENT_BYTES + 1024, 0x41);
    const r = await parseMailIsolated(buildMail({ attachments: [{ name: "gross.pdf", type: "application/pdf", data: big }, xmlAtt()] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mail.skipped).toEqual([{ index: 0, reason: "TOO_LARGE" }]);
    expect(r.mail.attachments.map((a) => a.fileName)).toEqual(["rechnung.xml"]);
  });

  it("stuerzt bei kaputten Boundaries nicht ab", async () => {
    const raw = Buffer.from(
      'From: a@lieferant.example.org\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="X"\r\n\r\n--Y\r\nContent-Type: application/xml\r\n\r\n<a/>\r\n--X\r\n\r\n',
    );
    const r = await parseMailIsolated(raw);
    if (r.ok) expect(Array.isArray(r.mail.attachments)).toBe(true);
    else expect(["PARSE_FAILED", "LIMIT"]).toContain(r.code);
    const garbage = await parseMailIsolated(Buffer.from("\u0000\u0001\u0002"));
    expect(garbage.ok === true || garbage.code === "PARSE_FAILED" || garbage.code === "LIMIT").toBe(true);
  });

  it("bereinigt Steuerzeichen im Betreff und kuerzt auf 200 Zeichen", async () => {
    const r = await parseMailIsolated(buildMail({ subject: `Re:\tRechnung\u0007 ${"x".repeat(300)}` }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mail.subject?.length).toBe(200);
    expect(r.mail.subject).not.toMatch(/[\u0000-\u001f]/);
  });

  it("endet bei einer Quoted-Printable-Bombe in festen Grenzen", async () => {
    const big = Buffer.from(
      `From: a@lieferant.example.org\r\nMIME-Version: 1.0\r\nContent-Type: application/pdf; name="b.pdf"\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Disposition: attachment; filename="b.pdf"\r\n\r\n${"=\r\n".repeat(6 * 1024 * 1024)}`,
    );
    const t0 = Date.now();
    const r = await parseMailIsolated(big);
    expect(Date.now() - t0).toBeLessThan(15_000);
    if (r.ok) expect(r.mail.attachments.every((a) => a.bytes.byteLength <= MAX_MAIL_ATTACHMENT_BYTES)).toBe(true);
    else expect(["PARSE_FAILED", "TIMEOUT", "LIMIT", "OUT_OF_MEMORY"]).toContain(r.code);
  });

  it("lehnt falsche Parameter und unbekannte Auftraege ab", async () => {
    const r = await runIsolated({ job: "unbekannt", script: "mail", input: new Uint8Array(1), timeoutMs: 5000, maxHeapMb: 128 });
    expect(r).toEqual({ ok: false, reason: "ERROR", code: "UNKNOWN_JOB" });
    const s = await runIsolated({ job: "parse-mail", script: "mail", input: new Uint8Array(1), timeoutMs: 5000, maxHeapMb: 128 });
    expect(s).toEqual({ ok: false, reason: "ERROR", code: "BAD_PARAMS" });
  });
});
