/** Abstraktion des Mailversands (Lastenheft 19/21) — SMTP- und In-Memory-Implementierung. */
import type { Attachment } from "@/domain/email/attachments";

export interface OutgoingMail {
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  text: string;
  /** Optionaler HTML-Teil (multipart/alternative, Text bleibt unveraendert). */
  html?: string;
  attachments: Attachment[];
}

export interface MailProvider {
  send(mail: OutgoingMail): Promise<{ providerId: string | null }>;
}

export type MailSendOutcome = "NOT_SENT" | "UNKNOWN";

export class MailSendError extends Error {
  /** NOT_SENT = Server hat die Nachricht sicher nicht angenommen; UNKNOWN = Ausgang unklar. */
  readonly outcome: MailSendOutcome;
  constructor(message: string, outcome: MailSendOutcome = "UNKNOWN") {
    super(message);
    this.name = "MailSendError";
    this.outcome = outcome;
  }
}
