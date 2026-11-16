/**
 * Eingebettete Rechnungsdaten aus einem PDF (ZUGFeRD/Factur-X). Das PDF wird nie im Hauptprozess
 * gelesen: ein isolierter Worker sucht nur die eingebetteten Dateien (siehe
 * src/workers/incoming-worker.mjs); hier wird die Rechnungs-XML ausgewaehlt.
 */
import { runIsolated } from "@/lib/worker/isolated";
import { runExclusive } from "@/lib/serial-queue";
import { classifyXml } from "./detect";
import { MAX_PDF_ATTACHMENT_BYTES, MAX_PDF_ATTACHMENTS, PDF_EXTRACT_TIMEOUT_MS } from "./limits";

export type PdfExtract =
  | { status: "XML_FOUND"; xml: Uint8Array; fileName: string; others: number }
  | { status: "NO_INVOICE_XML"; attachments: number }
  | { status: "UNREADABLE"; reason: "ENCRYPTED" | "BROKEN" | "TOO_MANY" | "TOO_LARGE" | "TIMEOUT" | "OUT_OF_MEMORY" };

interface WorkerAttachment {
  name: string | null;
  size: number;
  xml: boolean;
  bytes: Uint8Array | null;
}

const INVOICE_FILE_NAMES = new Set(["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"]);
const PDF_WORKER_HEAP_MB = 192;

function isWorkerAttachment(v: unknown): v is WorkerAttachment {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (o.name === null || typeof o.name === "string") && typeof o.size === "number" && typeof o.xml === "boolean";
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
  } catch {
    return false;
  }
}

const UNREADABLE_CODES = new Set(["ENCRYPTED", "BROKEN", "TOO_MANY", "TOO_LARGE"]);

export function extractPdfInvoiceXml(bytes: Uint8Array): Promise<PdfExtract> {
  return runExclusive("incoming-pdf", async (): Promise<PdfExtract> => {
    const res = await runIsolated<Uint8Array, unknown>({
      job: "pdf-attachments",
      input: bytes,
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
    const withXml = list.filter((a): a is WorkerAttachment & { bytes: Uint8Array } => a.xml && a.bytes !== null && a.size <= MAX_PDF_ATTACHMENT_BYTES);
    // Name gewinnt (bei mehreren die letzte = neueste Fassung), sonst erste Anlage mit erkennbarer Rechnungs-XML.
    const named = withXml.filter((a) => a.name !== null && INVOICE_FILE_NAMES.has(a.name.toLowerCase()));
    const pick = named.length > 0 ? named[named.length - 1] : withXml.find((a) => isClassifiable(a.bytes));
    if (!pick) return { status: "NO_INVOICE_XML", attachments: list.length };
    return { status: "XML_FOUND", xml: pick.bytes, fileName: pick.name ?? "rechnung.xml", others: list.length - 1 };
  });
}
