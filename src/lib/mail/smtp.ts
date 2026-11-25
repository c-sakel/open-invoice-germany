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

/**
 * Codes, die nodemailer nur setzt, solange keine Nachricht uebertragen wurde (smtp-connection:
 * EDNS bei der Namensaufloesung, ETLS nur waehrend des STARTTLS-Upgrades, EAUTH bei Anmeldung/
 * fehlenden Zugangsdaten, EENVELOPE/EREQUIRETLS/ECONFIG bei Umschlagpruefung vor MAIL FROM).
 */
const NOT_SENT_CODES = new Set(["EAUTH", "EDNS", "ETLS", "EREQUIRETLS", "EENVELOPE", "ECONFIG"]);
/** Befehle, die nur vor dem Nachrichtentext vorkommen (nodemailer setzt command nur dort so). */
const NOT_SENT_COMMANDS = new Set(["EHLO", "HELO", "STARTTLS", "MAIL FROM", "RCPT TO"]);
/**
 * Systemfehler des Verbindungsaufbaus (err.originalCode, nodemailer ueberschreibt code mit ESOCKET):
 * die Verbindung kam nie zustande.
 */
const NOT_SENT_ORIGINAL_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
/** timeoutType der Verbindungsphasen vor der Nachricht; SOCKET_TIMEOUT kann auch nach DATA auftreten. */
const NOT_SENT_TIMEOUT_TYPES = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]);

/**
 * Ordnet einen nodemailer-Fehler ein: NOT_SENT nur, wenn sicher belegt ist, dass die Nachricht
 * nicht angenommen wurde. nodemailer setzt command "CONN" fuer ALLE Laufzeitfehler (auch Socket-
 * Timeout, ESOCKET, "Connection closed unexpectedly", 421 nach dem Nachrichtentext), deshalb
 * ist CONN allein nie ein Beleg. Alles Uebrige ist UNKNOWN, damit nie doppelt versendet wird.
 */
export function classifySmtpError(err: unknown): MailSendOutcome {
  if (typeof err !== "object" || err === null) return "UNKNOWN";
  const f = err as {
    code?: unknown;
    originalCode?: unknown;
    command?: unknown;
    responseCode?: unknown;
    timeoutType?: unknown;
    message?: unknown;
  };
  const code = typeof f.code === "string" ? f.code : undefined;
  const command = typeof f.command === "string" ? f.command : undefined;
  if (code && NOT_SENT_CODES.has(code)) return "NOT_SENT";
  if (typeof f.originalCode === "string" && NOT_SENT_ORIGINAL_CODES.has(f.originalCode)) return "NOT_SENT";
  if (code === "ETIMEDOUT" && typeof f.timeoutType === "string" && NOT_SENT_TIMEOUT_TYPES.has(f.timeoutType)) return "NOT_SENT";
  // Greeting-Fehler: nodemailer meldet EPROTOCOL/CONN mit dieser Meldung nur vor dem EHLO
  if (code === "EPROTOCOL" && command === "CONN" && typeof f.message === "string" && f.message.startsWith("Invalid greeting")) {
    return "NOT_SENT";
  }
  if (command && (NOT_SENT_COMMANDS.has(command) || command.startsWith("AUTH"))) return "NOT_SENT";
  // DATA mit Serverantwort: entweder die Ablehnung des DATA-Befehls (EENVELOPE) oder die Antwort auf das
  // End-"." der Nachricht (EMESSAGE). Beides ist eine ausdrueckliche 4xx/5xx-Ablehnung, die Nachricht ist
  // nach RFC 5321 nicht eingereiht. Abbrueche (Socket, Timeout) tragen nie einen responseCode mit DATA.
  // Teilannahme je Empfaenger gibt es nur bei LMTP, das hier nicht genutzt wird.
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
