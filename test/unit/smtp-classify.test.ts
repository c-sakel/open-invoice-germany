import { describe, it, expect, vi } from "vitest";

const sendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

import { classifySmtpError, createSmtpProvider } from "@/lib/mail/smtp";
import { MailSendError } from "@/lib/mail/provider";
import type { DecryptedMailSettings } from "@/domain/email/settings";

function err(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("x"), fields);
}

describe("classifySmtpError", () => {
  it("Anmeldung fehlgeschlagen -> NOT_SENT", () => {
    expect(classifySmtpError(err({ code: "EAUTH", command: "AUTH PLAIN" }))).toBe("NOT_SENT");
  });
  it("Verbindungsaufbau -> NOT_SENT", () => {
    expect(classifySmtpError(err({ code: "ECONNECTION", command: "CONN" }))).toBe("NOT_SENT");
  });
  it("Empfaenger abgelehnt -> NOT_SENT", () => {
    expect(classifySmtpError(err({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }))).toBe("NOT_SENT");
  });
  it("DATA mit Antwortcode -> NOT_SENT", () => {
    expect(classifySmtpError(err({ code: "EMESSAGE", command: "DATA", responseCode: 452 }))).toBe("NOT_SENT");
  });
  it("Timeout nach DATA ohne Antwortcode -> UNKNOWN", () => {
    expect(classifySmtpError(err({ code: "ETIMEDOUT", command: "DATA" }))).toBe("UNKNOWN");
  });
  it("unbekannter Fehler -> UNKNOWN", () => {
    expect(classifySmtpError(new Error("x"))).toBe("UNKNOWN");
  });
  it("null -> UNKNOWN", () => {
    expect(classifySmtpError(null)).toBe("UNKNOWN");
  });
  it("Codes ohne Command: EDNS/ETLS -> NOT_SENT", () => {
    expect(classifySmtpError(err({ code: "EDNS" }))).toBe("NOT_SENT");
    expect(classifySmtpError(err({ code: "ETLS" }))).toBe("NOT_SENT");
  });
});

describe("createSmtpProvider Fehlerbehandlung", () => {
  it("entfernt das Passwort aus der Meldung und setzt outcome", async () => {
    sendMail.mockRejectedValueOnce(err({ message: "login geheim123 failed", code: "EAUTH", command: "AUTH PLAIN" }));
    const provider = createSmtpProvider({
      host: "smtp.example.test",
      port: 587,
      security: "STARTTLS",
      username: "u",
      password: "geheim123",
    } as unknown as DecryptedMailSettings);
    const e = await provider
      .send({ from: { name: "A", address: "a@example.test" }, to: ["b@example.test"], cc: [], bcc: [], subject: "s", text: "t", attachments: [] })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailSendError);
    const mse = e as MailSendError;
    expect(mse.message).not.toContain("geheim123");
    expect(mse.outcome).toBe("NOT_SENT");
  });
});
