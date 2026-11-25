/** In-Memory-Provider fuer Tests: sammelt gesendete Mails, kann den naechsten Versand scheitern lassen. */
import type { MailProvider, OutgoingMail } from "./provider";
import { MailSendError, type MailSendOutcome } from "./provider";

export function createMemoryProvider(): MailProvider & { sent: OutgoingMail[]; failNext(msg: string, outcome?: MailSendOutcome): void } {
  const sent: OutgoingMail[] = [];
  let nextFailure: { msg: string; outcome: MailSendOutcome } | null = null;
  return {
    sent,
    failNext(msg: string, outcome: MailSendOutcome = "UNKNOWN") {
      nextFailure = { msg, outcome };
    },
    async send(mail: OutgoingMail) {
      if (nextFailure !== null) {
        const f = nextFailure;
        nextFailure = null;
        throw new MailSendError(f.msg, f.outcome);
      }
      sent.push(mail);
      return { providerId: `mem-${sent.length}` };
    },
  };
}
