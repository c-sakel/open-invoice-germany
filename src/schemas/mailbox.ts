/**
 * Eingabe der Postfach-Einstellungen. Zugangsdaten werden nie ausgegeben; das Passwort ist nur hier und nur schreibend.
 */
import { domainToASCII } from "node:url";
import net from "node:net";
import { z } from "zod";
import { syncFilterShape } from "@/domain/sync/updated-since";
import { isBlockedAddress } from "@/lib/mailbox/net-guard";

export const MAX_SENDER_DOMAINS = 50;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Kleinschreibung, Punycode, ohne fuehrendes "@"; leere Zeichenkette bei ungueltigem Wert. */
export function normalizeSenderDomain(input: string): string {
  const raw = input.trim().replace(/^@/, "").toLowerCase();
  if (raw.length === 0 || raw.length > 253) return "";
  const ascii = domainToASCII(raw);
  return DOMAIN_RE.test(ascii) && ascii.length <= 253 ? ascii : "";
}

const senderDomainSchema = z
  .string()
  .max(300)
  .transform((v) => normalizeSenderDomain(v))
  .refine((v) => v.length > 0, "Ungueltige Domain");

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((h) => !/[\u0000- \u007f/\\:@?#%]/.test(h), "Nur der Servername, ohne Schema, Port oder Pfad")
  .refine((h) => !net.isIP(h) || !isBlockedAddress(h), "Dieser Adressbereich ist gesperrt");

const printable = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);

export const mailboxSettingsInputSchema = z
  .object({
    host: hostSchema,
    port: z.union([z.literal(993), z.literal(143)]),
    security: z.enum(["TLS", "STARTTLS"]),
    username: z.string().min(1).max(254).refine(printable, "Ungueltige Zeichen"),
    /** Weggelassen = unveraendert, null = entfernen. */
    password: z.string().min(1).max(512).nullable().optional(),
    folder: z.string().min(1).max(200).refine(printable, "Ungueltige Zeichen"),
    fetchSince: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((v) => {
        const d = new Date(`${v}T00:00:00.000Z`);
        return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
      }, "Ungueltiges Datum")
      .nullable()
      .optional(),
    allowedSenderDomains: z
      .array(senderDomainSchema)
      .max(MAX_SENDER_DOMAINS)
      .optional()
      .transform((v) => [...new Set(v ?? [])]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.port === 993) !== (v.security === "TLS")) {
      ctx.addIssue({ code: "custom", path: ["security"], message: "Port 993 gehoert zu TLS, Port 143 zu STARTTLS" });
    }
  });

export type MailboxSettingsInput = z.infer<typeof mailboxSettingsInputSchema>;

export const INBOUND_ATTACHMENT_STATUSES = ["INBOX", "ACCEPTED", "DISCARDED", "DUPLICATE", "SKIPPED"] as const;
export const MAX_ACCEPT_BATCH = 20;

export const inboundAttachmentListQuerySchema = z.object({
  status: z.enum(INBOUND_ATTACHMENT_STATUSES).optional(),
  ...syncFilterShape,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type InboundAttachmentListQuery = z.infer<typeof inboundAttachmentListQuerySchema>;

export const inboundDiscardInputSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

export const inboundAcceptBatchSchema = z.array(z.string().min(1).max(64)).min(1).max(MAX_ACCEPT_BATCH);
