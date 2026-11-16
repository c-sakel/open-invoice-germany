/**
 * Annahme einer Eingangsrechnung: Format erkennen, Datei unveraendert und unveraenderlich im
 * Archiv ablegen, Kopfdaten und Aenderungsprotokoll in einer Transaktion festhalten. Die Annahme
 * wartet nie auf die Pruefung. Das Original wird nie veraendert und nie geloescht.
 */
import { dbInternal } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { berlinYear } from "@/lib/berlin-time";
import { Prisma } from "@/generated/prisma/client";
import { sha256Hex, writeArchiveFile } from "@/lib/archive/storage";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { sanitizeFileName } from "@/domain/import/types";
import type { ParsedIncomingInvoice } from "@/schemas/incoming";
import { detectContainer } from "./detect";
import { IncomingBusyError, IncomingDuplicateError, IncomingFormatError } from "./errors";
import { INCOMING_RECEIVE_PER_MINUTE, MAX_INCOMING_BYTES } from "./limits";
import { parseIncomingXml } from "./parse";
import { extractPdfInvoiceXml } from "./pdf-attachments";
import type { IncomingChannel, IncomingKind } from "./types";
import { queueIncomingValidation } from "./validate";

export type { IncomingChannel, IncomingKind } from "./types";

export interface ReceiveResult {
  id: string;
  kind: IncomingKind;
  isEInvoice: boolean;
  syntax: string | null;
  profile: string | null;
  number: string | null;
  supplierName: string | null;
  duplicateOfId: string | null;
  validationStatus: string;
  hints: string[];
}

export interface ReceiveOptions {
  fileName: string;
  channel: IncomingChannel;
  actor: string;
  now?: Date;
}

/** Timeouts je Datei (Organisation + Hash) im Prozess; ab MAX_PDF_TIMEOUTS wird die Datei abgelegt statt erneut versucht. */
const MAX_PDF_TIMEOUTS = 3;
const MAX_TIMEOUT_KEYS = 500;
const timeoutCounts = new Map<string, number>();

function countTimeout(key: string): number {
  const n = (timeoutCounts.get(key) ?? 0) + 1;
  timeoutCounts.delete(key);
  timeoutCounts.set(key, n);
  if (timeoutCounts.size > MAX_TIMEOUT_KEYS) {
    const oldest = timeoutCounts.keys().next();
    if (!oldest.done) timeoutCounts.delete(oldest.value);
  }
  return n;
}

const LEGAL_FORM_TOKENS = new Set(["gmbh", "mbh", "ag", "kg", "ug", "ohg", "gbr", "se", "ltd", "llc", "inc", "co", "und", "haftungsbeschraenkt", "haftungsbeschrankt", "haftungsbeschränkt"]);

/** Name fuer den Dublettenvergleich: Kleinbuchstaben, ohne Rechtsform, Satzzeichen und Leerraum. */
export function normalizeName(name: string | null): string | null {
  if (name === null) return null;
  const t = name.toLowerCase().replace(/\be\.?\s?(k|v)\b\.?/g, " ");
  const out = t
    .split(/[^\p{L}\p{N}]+/u)
    .filter((tok) => tok !== "" && !LEGAL_FORM_TOKENS.has(tok))
    .join("");
  return out === "" ? null : out;
}

function normalizeId(v: string | null): string | null {
  if (v === null) return null;
  const t = v.toUpperCase().replace(/[\s.-]+/g, "");
  return t === "" ? null : t;
}

function isoToDate(v: string | null): Date | null {
  return v === null ? null : new Date(`${v}T00:00:00.000Z`);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Legt die Datei inhaltsadressiert ab. Eine Datei ohne Zeile (Fehler nach dem Schreiben) bleibt
 * bewusst liegen: der Pfad ist durch den Hash bestimmt, die naechste gleiche Annahme nutzt sie
 * wieder. Eingangs-Originale werden nie geloescht.
 */
async function storeFile(relPath: string, bytes: Buffer): Promise<void> {
  await writeArchiveFile(relPath, bytes);
}

interface Classified {
  kind: IncomingKind;
  mime: string;
  ext: "xml" | "pdf" | "png" | "jpg";
  parsed: ParsedIncomingInvoice | null;
  xmlBytes: Uint8Array | null;
  hints: string[];
}

async function classify(bytes: Uint8Array, timeoutKey: string): Promise<Classified> {
  const container = detectContainer(bytes);
  if (container.type === "XML") {
    const parsed = parseIncomingXml(container.text);
    return { kind: parsed.syntax === "FERD1" ? "HYBRID" : "EINVOICE", mime: "application/xml", ext: "xml", parsed, xmlBytes: null, hints: [] };
  }
  if (container.type === "IMAGE") {
    return { kind: "OTHER", mime: container.mime, ext: container.mime === "image/png" ? "png" : "jpg", parsed: null, xmlBytes: null, hints: [] };
  }
  const res = await extractPdfInvoiceXml(bytes);
  const base = { mime: "application/pdf", ext: "pdf" as const };
  if (res.status === "UNREADABLE") {
    if (res.reason === "BUSY") throw new IncomingBusyError();
    if (res.reason === "TIMEOUT" || res.reason === "OUT_OF_MEMORY") {
      if (countTimeout(timeoutKey) < MAX_PDF_TIMEOUTS) throw new IncomingBusyError();
      return { ...base, kind: "OTHER", parsed: null, xmlBytes: null, hints: ["PDF_TIMEOUT"] };
    }
    return { ...base, kind: "OTHER", parsed: null, xmlBytes: null, hints: ["PDF_UNREADABLE"] };
  }
  if (res.status === "NO_INVOICE_XML") {
    return { ...base, kind: "OTHER", parsed: null, xmlBytes: null, hints: res.skipped ? ["PDF_ATTACHMENT_SKIPPED"] : [] };
  }
  const text = decodeUtf8(res.xml);
  if (text !== null) {
    try {
      // parseIncomingXml prueft zuerst die XML-Sicherheit (DTD, Entities, Tiefe), dann erst den Parser.
      const parsed = parseIncomingXml(text);
      return { ...base, kind: "HYBRID", parsed, xmlBytes: res.xml, hints: [] };
    } catch (e) {
      if (!(e instanceof IncomingFormatError)) throw e;
    }
  }
  return { ...base, kind: "OTHER", parsed: null, xmlBytes: null, hints: ["EMBEDDED_XML_INVALID"] };
}

export async function receiveIncomingInvoice(orgId: string, bytes: Uint8Array, opts: ReceiveOptions): Promise<ReceiveResult> {
  if (bytes.byteLength === 0) throw new IncomingFormatError("Die Datei ist leer.", "EMPTY");
  if (bytes.byteLength > MAX_INCOMING_BYTES) throw new IncomingFormatError("Die Datei ist zu gross (maximal 15 MB).", "TOO_LARGE");
  rateLimit(`incoming-receive:${orgId}`, { limit: INCOMING_RECEIVE_PER_MINUTE, windowMs: 60_000 });

  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sha256 = sha256Hex(buf);

  // Bekannte Dublette vor jeder Pruefung (kein PDF-Worker, kein Parser).
  const existing = await dbInternal.incomingInvoice.findUnique({
    where: { orgId_originalSha256: { orgId, originalSha256: sha256 } },
    select: { id: true },
  });
  if (existing) throw new IncomingDuplicateError(existing.id);

  const cls = await classify(bytes, `${orgId}:${sha256}`);

  const receivedAt = opts.now ?? new Date();
  const dir = `incoming/${orgId}/${berlinYear(receivedAt)}`;
  const originalPath = `${dir}/${sha256}.${cls.ext}`;
  const xmlBuf = cls.xmlBytes ? Buffer.from(cls.xmlBytes.buffer, cls.xmlBytes.byteOffset, cls.xmlBytes.byteLength) : null;
  const xmlSha256 = xmlBuf ? sha256Hex(xmlBuf) : null;
  const xmlPath = xmlSha256 ? `${dir}/${xmlSha256}.xml` : null;

  await storeFile(originalPath, buf);
  if (xmlBuf && xmlPath) await storeFile(xmlPath, xmlBuf);

  const p = cls.parsed;
  const hints = [...new Set([...(p?.hints.map((h) => h.code) ?? []), ...cls.hints])];
  const notApplicable = cls.kind === "OTHER" || p === null || !p.isEInvoice;
  const validationStatus = notApplicable ? "NOT_APPLICABLE" : p.linesTruncated ? "NOT_CHECKED" : "PENDING";
  const fileName = sanitizeFileName(opts.fileName) ?? `rechnung.${cls.ext}`;

  let created: { id: string; duplicateOfId: string | null };
  try {
    created = await withChangeLogRetry(() =>
      dbInternal.$transaction(async (tx) => {
        const rowHints = [...hints];
        let duplicateOfId: string | null = null;
        if (p !== null && p.number !== null) {
          const candidates = await tx.incomingInvoice.findMany({
            where: { orgId, number: p.number },
            orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
            select: { id: true, supplierName: true, supplierVatId: true, supplierTaxNumber: true },
          });
          const vat = normalizeId(p.seller.vatId);
          const tax = normalizeId(p.seller.taxNumber);
          const name = normalizeName(p.seller.name);
          const match = candidates.find((c) =>
            vat !== null
              ? normalizeId(c.supplierVatId) === vat
              : tax !== null
                ? normalizeId(c.supplierTaxNumber) === tax
                : name !== null && normalizeName(c.supplierName) === name,
          );
          if (match) {
            duplicateOfId = match.id;
            rowHints.push("POSSIBLE_DUPLICATE");
          }
        }
        const row = await tx.incomingInvoice.create({
          data: {
            orgId,
            receivedAt,
            channel: opts.channel,
            originalFileName: fileName,
            originalMime: cls.mime,
            originalSize: bytes.byteLength,
            originalSha256: sha256,
            originalPath,
            xmlPath,
            xmlSha256,
            kind: cls.kind,
            syntax: p?.syntax ?? null,
            profile: p?.profile ?? null,
            isEInvoice: p?.isEInvoice ?? false,
            typeCode: p?.typeCode ?? null,
            number: p?.number ?? null,
            issueDate: isoToDate(p?.issueDate ?? null),
            dueDate: isoToDate(p?.dueDate ?? null),
            deliveryDate: isoToDate(p?.deliveryDate ?? null),
            currency: p?.currency ?? null,
            netCents: p?.totals.netCents ?? null,
            taxCents: p?.totals.taxCents ?? null,
            grossCents: p?.totals.grossCents ?? null,
            payableCents: p?.totals.payableCents ?? null,
            supplierName: p?.seller.name ?? null,
            supplierVatId: p?.seller.vatId ?? null,
            supplierTaxNumber: p?.seller.taxNumber ?? null,
            supplierJson: p ? JSON.stringify(p.seller) : null,
            buyerName: p?.buyer.name ?? null,
            buyerVatId: p?.buyer.vatId ?? null,
            paymentJson: p ? JSON.stringify(p.payment) : null,
            hintsJson: JSON.stringify([...new Set(rowHints)]),
            validationStatus,
            duplicateOfId,
            status: "NEW",
            createdBy: opts.actor,
          },
          select: { id: true, duplicateOfId: true },
        });
        await appendChangeLog(tx, {
          orgId,
          entity: "INCOMING_INVOICE",
          entityId: row.id,
          action: "RECEIVE",
          actor: opts.actor,
          at: receivedAt,
          diff: { sha256, size: bytes.byteLength, channel: opts.channel, kind: cls.kind },
        });
        return row;
      }),
    );
  } catch (e) {
    const duplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
    const winner = duplicate
      ? await dbInternal.incomingInvoice.findUnique({
          where: { orgId_originalSha256: { orgId, originalSha256: sha256 } },
          select: { id: true },
        })
      : null;
    if (winner) throw new IncomingDuplicateError(winner.id);
    throw e;
  }
  timeoutCounts.delete(`${orgId}:${sha256}`);

  try {
    await logActivity(dbInternal, {
      orgId,
      entityType: "INCOMING_INVOICE",
      entityId: created.id,
      type: "CREATED",
      actor: opts.actor,
      at: receivedAt,
      data: { number: p?.number ?? null, supplierName: p?.seller.name ?? null },
    });
  } catch (e) {
    console.error("Eingangsrechnung: Aktivitaetsprotokoll nicht geschrieben", e instanceof Error ? e.message : "unbekannt");
  }
  try {
    queueIncomingValidation(created.id);
  } catch (e) {
    console.error("Eingangsrechnung: Pruefung konnte nicht eingereiht werden", e instanceof Error ? e.message : "unbekannt");
  }

  const allHints = created.duplicateOfId ? [...new Set([...hints, "POSSIBLE_DUPLICATE"])] : hints;
  return {
    id: created.id,
    kind: cls.kind,
    isEInvoice: p?.isEInvoice ?? false,
    syntax: p?.syntax ?? null,
    profile: p?.profile ?? null,
    number: p?.number ?? null,
    supplierName: p?.seller.name ?? null,
    duplicateOfId: created.duplicateOfId,
    validationStatus,
    hints: allHints,
  };
}
