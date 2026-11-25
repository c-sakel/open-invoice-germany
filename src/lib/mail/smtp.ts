/** SMTP-Provider (nodemailer). Fehlertexte werden von Zugangsdaten bereinigt. */
import nodemailer, { type SendMailOptions } from "nodemailer";
import type { DecryptedMailSettings } from "@/domain/email/settings";
import { MailSendError, type MailProvider, type MailSendOutcome, type OutgoingMail } from "./provider";

/**
 * Nachricht fuer nodemailer. Reihenfolge der Alternativen: nodemailer legt text vor html
 * (RFC 2046 § 5.1.4: bevorzugte Darstellung zuletzt). html nur, wenn gesetzt.
 */
export function toNodemailerMessage(mail: OutgoingMail): SendMailOptions {
  const msg: SendMailOptions = {
    from: { name: mail.from.name, address: mail.from.address },
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text: mail.text,
    attachments: mail.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  };
  if (mail.html !== undefined) msg.html = mail.html;
  return msg;
}

const NOT_SENT_CODES = new Set(["EAUTH", "ENOAUTH", "EDNS", "ETLS", "EREQUIRETLS", "EENVELOPE", "ECONFIG", "EPROXY", "EOAUTH2"]);
const NOT_SENT_COMMANDS = new Set(["CONN", "API", "EHLO", "HELO", "STARTTLS", "MAIL FROM", "RCPT TO"]);

/**
 * Ordnet einen nodemailer-Fehler ein: NOT_SENT nur, wenn der Server die Nachricht sicher nicht
 * angenommen hat (Fehler vor DATA oder ausdrueckliche Ablehnung nach DATA). Alles andere ist unklar,
 * damit nie doppelt versendet wird.
 */
export function classifySmtpError(err: unknown): MailSendOutcome {
  if (typeof err !== "object" || err === null) return "UNKNOWN";
  const f = err as { code?: unknown; command?: unknown; responseCode?: unknown };
  const code = typeof f.code === "string" ? f.code : undefined;
  const command = typeof f.command === "string" ? f.command : undefined;
  if (code && NOT_SENT_CODES.has(code)) return "NOT_SENT";
  if (command && (NOT_SENT_COMMANDS.has(command) || command.startsWith("AUTH"))) return "NOT_SENT";
  if (command === "DATA" && typeof f.responseCode === "number") return "NOT_SENT";
  return "UNKNOWN";
}

export function createSmtpProvider(s: DecryptedMailSettings): MailProvider {
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "TLS",
    requireTLS: s.security === "STARTTLS",
    ignoreTLS: s.security === "NONE",
    auth: s.username ? { user: s.username, pass: s.password ?? "" } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      try {
        const info = await transport.sendMail(toNodemailerMessage(mail));
        return { providerId: info.messageId ?? null };
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        // Bug im Brief-Code korrigiert (Nachtrag): replaceAll("", ...) wuerde zwischen jedem
        // Zeichen einfuegen. Passwort nur ersetzen, wenn eines gesetzt ist.
        const cleaned = s.password ? raw.split(s.password).join("***") : raw;
        throw new MailSendError(cleaned, classifySmtpError(e));
      }
    },
  };
}
