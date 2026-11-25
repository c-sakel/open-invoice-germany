/**
 * Zerlegt eine rohe Mail ausschliesslich im isolierten Worker (src/workers/mail-worker.mjs). Die Antwort
 * des Workers wird per Zod geprueft; Anlagen werden nur mit Magic-Byte-Pruefung weiterverarbeitet (Aufrufer).
 */
import { z } from "zod";
import {
  MAX_MAIL_ATTACHMENT_BYTES,
  MAX_MAIL_ATTACHMENTS,
  MAX_MAIL_BYTES,
  MAX_MAIL_HEADER_BYTES,
  MAX_MAIL_NESTING,
  MAX_MAIL_PARTS,
  MAX_SUBJECT_CHARS,
  MAIL_WORKER_HEAP_MB,
  MAIL_WORKER_TIMEOUT_MS,
} from "@/domain/mailbox/limits";
import { runIsolated } from "@/lib/worker/isolated";

export interface ParsedDsn {
  action: "failed" | "delayed" | "other";
  status: string | null;
  originalMessageIdHash: string | null;
  /** Domains der Final-Recipient-Felder (kleingeschrieben, hoechstens 20); nie ganze Adressen. */
  finalRecipientDomains: string[];
}

export interface ParsedMail {
  messageIdHash: string | null;
  senderDomain: string | null;
  subject: string | null;
  date: Date | null;
  parts: number;
  /** Zustellbericht nach RFC 3464 (nur Ergebnis, nie Adressen/Texte); sonst null. */
  dsn: ParsedDsn | null;
  attachments: { index: number; fileName: string; declaredType: string; bytes: Uint8Array }[];
  skipped: { index: number; reason: "TOO_LARGE" | "TOO_MANY" | "NESTED" }[];
}

export type ParseMailResult =
  | { ok: true; mail: ParsedMail }
  | { ok: false; code: "PARSE_FAILED" | "TIMEOUT" | "OUT_OF_MEMORY" | "LIMIT" };

const workerSchema = z.object({
  messageIdHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  senderDomain: z.string().max(253).nullable(),
  subject: z.string().max(MAX_SUBJECT_CHARS * 2).nullable(),
  date: z.string().max(40).nullable(),
  parts: z.number().int().min(0).max(MAX_MAIL_PARTS * 2),
  dsn: z
    .object({
      action: z.enum(["failed", "delayed", "other"]),
      status: z.string().regex(/^[245]\.\d{1,3}\.\d{1,3}$/).nullable(),
      originalMessageIdHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      finalRecipientDomains: z.array(z.string().regex(/^[a-z0-9.-]{1,253}$/)).max(20),
    })
    .nullable(),
  attachments: z
    .array(
      z.object({
        index: z.number().int().min(0),
        fileName: z.string().max(1000),
        declaredType: z.string().max(255),
        bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength <= MAX_MAIL_ATTACHMENT_BYTES),
      }),
    )
    .max(MAX_MAIL_ATTACHMENTS),
  skipped: z.array(z.object({ index: z.number().int().min(0), reason: z.enum(["TOO_LARGE", "TOO_MANY", "NESTED"]) })).max(10_000),
});

export async function parseMailIsolated(raw: Uint8Array): Promise<ParseMailResult> {
  const r = await runIsolated<Uint8Array, unknown>({
    job: "parse-mail",
    script: "mail",
    input: raw,
    params: {
      maxAttachments: MAX_MAIL_ATTACHMENTS,
      maxAttachmentBytes: MAX_MAIL_ATTACHMENT_BYTES,
      maxMailBytes: MAX_MAIL_BYTES,
      maxParts: MAX_MAIL_PARTS,
      maxNesting: MAX_MAIL_NESTING,
      maxHeaderBytes: MAX_MAIL_HEADER_BYTES,
      maxSubject: MAX_SUBJECT_CHARS,
    },
    timeoutMs: MAIL_WORKER_TIMEOUT_MS,
    maxHeapMb: MAIL_WORKER_HEAP_MB,
  });
  if (!r.ok) {
    if (r.reason === "TIMEOUT") return { ok: false, code: "TIMEOUT" };
    if (r.reason === "OUT_OF_MEMORY") return { ok: false, code: "OUT_OF_MEMORY" };
    return { ok: false, code: r.code === "LIMIT" ? "LIMIT" : "PARSE_FAILED" };
  }
  const parsed = workerSchema.safeParse(r.value);
  if (!parsed.success) return { ok: false, code: "PARSE_FAILED" };
  const v = parsed.data;
  const date = v.date === null ? null : new Date(v.date);
  return {
    ok: true,
    mail: {
      messageIdHash: v.messageIdHash,
      senderDomain: v.senderDomain,
      subject: v.subject,
      date: date !== null && Number.isFinite(date.getTime()) ? date : null,
      parts: v.parts,
      dsn: v.dsn,
      attachments: v.attachments,
      skipped: v.skipped,
    },
  };
}
