/**
 * Worker fuer fremde Mails (Postfach-Abruf). Reines ESM-JavaScript ohne Projekt-Importe, damit es
 * unveraendert im Standalone-Output laeuft. Je Auftrag ein Worker mit Heap- und Zeitgrenze
 * (siehe src/lib/worker/isolated.ts).
 *
 * Auftrag "parse-mail": zerlegt eine rohe Mail und gibt NUR Anlagen zurueck, die Kandidaten fuer eine
 * Rechnung sind (Dateiname, Anhang oder passender Typ), dazu Absenderdomain, gekuerzten Betreff, Datum
 * und den Hash der Message-Id. Text- und HTML-Koerper werden nie zurueckgegeben. Meldungen tragen nur
 * feste Codes, nie Inhalt der Mail.
 */
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import PostalMime from "postal-mime";

const PARAMS = workerData?.params ?? {};
const MAX_ATTACHMENTS = PARAMS.maxAttachments;
const MAX_ATTACHMENT_BYTES = PARAMS.maxAttachmentBytes;
const MAX_TOTAL_BYTES = PARAMS.maxMailBytes;
const MAX_PARTS = PARAMS.maxParts;
const MAX_NESTING = PARAMS.maxNesting;
const MAX_HEADER_BYTES = PARAMS.maxHeaderBytes;
const MAX_SUBJECT = PARAMS.maxSubject;

class JobError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Ende des Kopfbereichs der Mail (erste Leerzeile); Laenge des Kopfes oder -1. */
function headerLength(raw) {
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] === 0x0a && (raw[i + 1] === 0x0a || (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a))) return i;
    // Beginnt der Rumpf sofort (Leerzeile als erste Zeile), ist der Kopf leer.
    if (i === 0 && raw[0] === 0x0d && raw[1] === 0x0a) return 0;
    if (i > MAX_HEADER_BYTES) return i;
  }
  return -1;
}

function cleanSubject(value) {
  if (typeof value !== "string") return null;
  const s = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return s === "" ? null : Array.from(s).slice(0, MAX_SUBJECT).join("");
}

function senderDomain(from) {
  const address = from?.address;
  if (typeof address !== "string") return null;
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const d = domainToASCII(address.slice(at + 1).trim().toLowerCase());
  return d !== "" && d.length <= 253 && /^[a-z0-9.-]+$/.test(d) ? d : null;
}

function messageIdHash(id) {
  if (typeof id !== "string") return null;
  const s = id.trim().replace(/^<|>$/g, "").toLowerCase();
  return s === "" ? null : createHash("sha256").update(s).digest("hex");
}

function isCandidate(att) {
  if (att.rfc822DepthExceeded) return false;
  const type = String(att.mimeType ?? "").toLowerCase();
  if (att.filename) return true;
  if (att.disposition === "attachment") return true;
  return type === "application/xml" || type === "application/pdf" || type === "application/octet-stream" || type === "text/xml";
}

async function parseMail(input) {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(0);
  if (raw.length === 0 || raw.length > MAX_TOTAL_BYTES) throw new JobError("LIMIT");
  const hl = headerLength(raw);
  if (hl > MAX_HEADER_BYTES) throw new JobError("LIMIT");
  let mail;
  try {
    mail = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: MAX_NESTING,
      maxPartCount: MAX_PARTS,
      maxHeadersSize: MAX_HEADER_BYTES,
      maxRfc822NestingDepth: 2,
    });
  } catch (err) {
    const c = err && err.code;
    if (c === "EMAXNESTINGDEPTH" || c === "EMAXHEADERSIZE" || c === "EMAXPARTCOUNT" || c === "EMAXFORWARDEDADDRESSES") {
      throw new JobError("LIMIT");
    }
    throw new JobError("PARSE_FAILED");
  }
  const attachments = [];
  const skipped = [];
  const transfer = [];
  let index = 0;
  let total = 0;
  for (const att of mail.attachments ?? []) {
    const i = index++;
    if (!isCandidate(att)) continue;
    const bytes = att.content instanceof ArrayBuffer ? new Uint8Array(att.content) : null;
    if (bytes === null) continue;
    if (attachments.length >= MAX_ATTACHMENTS) {
      skipped.push({ index: i, reason: "TOO_MANY" });
      continue;
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES || total + bytes.byteLength > MAX_TOTAL_BYTES) {
      skipped.push({ index: i, reason: "TOO_LARGE" });
      continue;
    }
    total += bytes.byteLength;
    attachments.push({
      index: i,
      fileName: typeof att.filename === "string" ? att.filename : "",
      declaredType: String(att.mimeType ?? ""),
      bytes,
    });
    transfer.push(bytes.buffer);
  }
  const date = mail.date ? Date.parse(mail.date) : NaN;
  const value = {
    messageIdHash: messageIdHash(mail.messageId),
    senderDomain: senderDomain(mail.from),
    subject: cleanSubject(mail.subject),
    date: Number.isFinite(date) ? new Date(date).toISOString() : null,
    parts: index,
    attachments,
    skipped,
  };
  return { value, transfer };
}

try {
  if (workerData?.job !== "parse-mail") throw new JobError("UNKNOWN_JOB");
  for (const v of [MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_BYTES, MAX_PARTS, MAX_NESTING, MAX_HEADER_BYTES, MAX_SUBJECT]) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new JobError("BAD_PARAMS");
  }
  const { value, transfer } = await parseMail(workerData.input);
  parentPort.postMessage({ ok: true, value }, transfer);
} catch (err) {
  // Nie Meldung oder Eingabeinhalt weitergeben, nur einen festen Code.
  parentPort.postMessage({ ok: false, code: err instanceof JobError ? err.code : "FAILED" });
}
