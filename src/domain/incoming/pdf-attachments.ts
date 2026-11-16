/**
 * Eingebettete Rechnungsdaten aus einem PDF (ZUGFeRD/Factur-X). Das PDF wird nie im Hauptprozess
 * gelesen: ein isolierter Worker sucht nur die eingebetteten Dateien (siehe
 * src/workers/incoming-worker.mjs); hier wird die Rechnungs-XML ausgewaehlt.
 */
import { runIsolated } from "@/lib/worker/isolated";
import { classifyXml } from "./detect";
import { IncomingFormatError } from "./errors";
import {
  MAX_INCOMING_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENTS,
  MAX_PDF_CANDIDATES,
  MAX_PDF_QUEUE,
  MAX_PDF_TOTAL_BYTES,
  PDF_EXTRACT_TIMEOUT_MS,
} from "./limits";

export type PdfExtract =
  | { status: "XML_FOUND"; xml: Uint8Array; fileName: string; others: number }
  | { status: "NO_INVOICE_XML"; attachments: number; skipped?: number }
  | { status: "UNREADABLE"; reason: "ENCRYPTED" | "BROKEN" | "TOO_MANY" | "TOO_LARGE" | "TIMEOUT" | "OUT_OF_MEMORY" | "BUSY" };

interface WorkerAttachment {
  name: string | null;
  size: number;
  xml: boolean;
  bytes: Uint8Array | null;
  issue?: string;
}

const INVOICE_FILE_NAMES = new Set(["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"]);
const PDF_WORKER_HEAP_MB = 192;
const WORKER_ISSUES = new Set(["BROKEN", "UNSUPPORTED", "NOT_XML", "TOO_LARGE"]);

function isWorkerAttachment(v: unknown): v is WorkerAttachment {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!(o.name === null || typeof o.name === "string")) return false;
  if (typeof o.size !== "number" || !Number.isFinite(o.size) || o.size < 0) return false;
  if (typeof o.xml !== "boolean") return false;
  if (!(o.issue === undefined || (typeof o.issue === "string" && WORKER_ISSUES.has(o.issue)))) return false;
  return o.bytes === null || (ArrayBuffer.isView(o.bytes) && o.bytes.byteLength === o.size);
}

/** Dateiname aus dem PDF: nur Basename, druckbare Zeichen, hoechstens 255; wird nie als Pfad verwendet. */
export function normalizeAttachmentName(raw: string | null): string | null {
  if (raw === null) return null;
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 255);
  return clean === "" ? null : clean;
}

function readAttachments(value: unknown): WorkerAttachment[] | null {
  if (typeof value !== "object" || value === null) return null;
  const list = (value as { attachments?: unknown }).attachments;
  if (!Array.isArray(list) || list.length > MAX_PDF_ATTACHMENTS || !list.every(isWorkerAttachment)) return null;
  return list;
}

function isClassifiable(bytes: Uint8Array): boolean {
  try {
    classifyXml(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    return true;
  } catch (e) {
    // Zu viele Elemente: trotzdem eine Rechnungs-XML, die Annahme legt sie ab.
    return e instanceof IncomingFormatError && e.code === "TOO_MANY_ELEMENTS";
  }
}

const UNREADABLE_CODES = new Set(["ENCRYPTED", "BROKEN", "TOO_MANY", "TOO_LARGE"]);

/**
 * Kette und Zaehler der wartenden Extraktionen am globalen Objekt (Symbol.for): Next.js bundelt
 * REST, Upload-Route und MCP getrennt, sonst haette jedes Bundle eine eigene Kette.
 */
const PDF_STATE_KEY = Symbol.for("oig.incomingPdf.state");
interface PdfState {
  tail: Promise<unknown>;
  waiting: number;
}
type WithPdfState = { [PDF_STATE_KEY]?: PdfState };

function pdfState(): PdfState {
  const g = globalThis as WithPdfState;
  g[PDF_STATE_KEY] ??= { tail: Promise.resolve(), waiting: 0 };
  return g[PDF_STATE_KEY];
}

function runPdfExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const st = pdfState();
  const next = st.tail.then(fn, fn);
  st.tail = next.catch(() => undefined);
  return next;
}

export async function extractPdfInvoiceXml(bytes: Uint8Array): Promise<PdfExtract> {
  if (bytes.byteLength > MAX_INCOMING_BYTES) return { status: "UNREADABLE", reason: "TOO_LARGE" };
  const st = pdfState();
  if (st.waiting >= MAX_PDF_QUEUE) return { status: "UNREADABLE", reason: "BUSY" };
  // Eigene Kopie: ein Pool-Buffer wuerde beim Klonen den ganzen Pool in den Worker kopieren.
  const own = Uint8Array.from(bytes);
  st.waiting++;
  try {
    return await runPdfExclusive(() => extractOwned(own));
  } finally {
    st.waiting--;
  }
}

async function extractOwned(own: Uint8Array): Promise<PdfExtract> {
  const res = await runIsolated<Uint8Array, unknown>({
    job: "pdf-attachments",
    input: own,
    params: {
      maxAttachments: MAX_PDF_ATTACHMENTS,
      maxAttachmentBytes: MAX_PDF_ATTACHMENT_BYTES,
      maxTotalBytes: MAX_PDF_TOTAL_BYTES,
      maxCandidates: MAX_PDF_CANDIDATES,
    },
    timeoutMs: PDF_EXTRACT_TIMEOUT_MS,
    maxHeapMb: PDF_WORKER_HEAP_MB,
  });
  if (!res.ok) {
    if (res.reason === "TIMEOUT") return { status: "UNREADABLE", reason: "TIMEOUT" };
    if (res.reason === "OUT_OF_MEMORY") return { status: "UNREADABLE", reason: "OUT_OF_MEMORY" };
    const code = res.code ?? "";
    if (UNREADABLE_CODES.has(code)) {
      return { status: "UNREADABLE", reason: code as "ENCRYPTED" | "BROKEN" | "TOO_MANY" | "TOO_LARGE" };
    }
    return { status: "UNREADABLE", reason: "BROKEN" };
  }
  const list = readAttachments(res.value);
  if (list === null) return { status: "UNREADABLE", reason: "BROKEN" };
  const withXml = list
    .filter((a): a is WorkerAttachment & { bytes: Uint8Array } => a.xml && a.bytes !== null && a.size <= MAX_PDF_ATTACHMENT_BYTES)
    .map((a) => ({ ...a, name: normalizeAttachmentName(a.name) }));
  const skipped = list.filter((a) => !a.xml && a.issue !== undefined && a.issue !== "NOT_XML").length;
  // Name gewinnt (bei mehreren die letzte = neueste Fassung), sonst erste Anlage mit erkennbarer Rechnungs-XML.
  const named = withXml.filter((a) => a.name !== null && INVOICE_FILE_NAMES.has(a.name.toLowerCase()));
  const pick = named.length > 0 ? named[named.length - 1] : withXml.find((a) => isClassifiable(a.bytes));
  if (!pick) return { status: "NO_INVOICE_XML", attachments: list.length, ...(skipped > 0 ? { skipped } : {}) };
  return { status: "XML_FOUND", xml: pick.bytes, fileName: pick.name ?? "rechnung.xml", others: list.length - 1 };
}
