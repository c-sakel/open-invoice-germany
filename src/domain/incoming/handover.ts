/**
 * Uebergabe an die Buchhaltung: ZIP mit den Originalen der im Zeitraum eingegangenen Rechnungen
 * und einer Tabelle (`eingangsrechnungen.csv`). Reine Weitergabe von Belegen, keine Buchungsdaten.
 *
 * - Zeitraum = Eingangsdatum (Berliner Kalendertage); abgelehnte nur auf Wunsch.
 * - Dateien nur ueber `getIncomingFile` (SHA-256-Pruefung; Manipulation bricht ab).
 * - Interne Notiz und Zahlungsvermerk werden nie gelesen (ausdrueckliche Auswahl).
 * - Grenzen vor dem ersten Byte; das ZIP entsteht in einer Temp-Datei.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { berlinDayEnd, berlinMidnight } from "@/lib/berlin-time";
import { rateLimit } from "@/lib/rate-limit";
import { ZipWriter } from "@/lib/zip/writer";
import { col, csvTable, type CsvColumn } from "@/domain/export/csv-writer";
import { incomingHandoverQuerySchema } from "@/schemas/incoming";
import type { Prisma } from "@/generated/prisma/client";
import { getIncomingFile } from "./files";
import { effectiveHeader, hasSeparateXml, incomingStem, INCOMING_EXPORT_SELECT, originalExtension, type EffectiveHeader, type IncomingExportRow } from "./export-rows";
import { INCOMING_EXPORT_PER_MINUTE, MAX_HANDOVER_BYTES, MAX_HANDOVER_FILES } from "./limits";

const PAGE = 200;
/** Reserve fuer die ausgelesene Hybrid-XML, die in der Planung nicht mitgezaehlt wird. */
const XML_RESERVE = 0.05;

export class IncomingHandoverTooLargeError extends Error {
  readonly status = 413;
  constructor(count: number, bytes: number) {
    super(
      `Der Zeitraum umfasst ${count} Eingangsrechnungen mit zusammen ${Math.ceil(bytes / (1024 * 1024))} MB ` +
        `(Grenzen ${MAX_HANDOVER_FILES} Dateien, ${MAX_HANDOVER_BYTES / (1024 * 1024)} MB). Bitte den Zeitraum verkleinern.`,
    );
    this.name = "IncomingHandoverTooLargeError";
  }
}

export interface HandoverOptions {
  maxFiles?: number;
  maxBytes?: number;
}

function whereOf(orgId: string, raw: unknown): Prisma.IncomingInvoiceWhereInput {
  const q = incomingHandoverQuerySchema.parse(raw);
  const [fy, fm, fd] = q.from.split("-").map(Number);
  const from = berlinMidnight(fy, fm, fd);
  const to = berlinDayEnd(new Date(`${q.to}T00:00:00.000Z`));
  return { orgId, receivedAt: { gte: from, lte: to }, ...(q.includeRejected ? {} : { status: { not: "REJECTED" } }) };
}

export async function planIncomingHandover(orgId: string, raw: unknown, opts: HandoverOptions = {}): Promise<{ count: number; bytes: number }> {
  const where = whereOf(orgId, raw);
  const agg = await dbInternal.incomingInvoice.aggregate({ where, _count: { _all: true }, _sum: { originalSize: true } });
  const count = agg._count._all;
  const bytes = agg._sum.originalSize ?? 0;
  if (count > (opts.maxFiles ?? MAX_HANDOVER_FILES) || bytes > (opts.maxBytes ?? MAX_HANDOVER_BYTES)) throw new IncomingHandoverTooLargeError(count, bytes);
  return { count, bytes };
}

interface CsvItem {
  row: IncomingExportRow;
  head: EffectiveHeader;
  stem: string;
  ext: string;
  contact: { customerNumber: string | null; name: string } | null;
}

const COLUMNS: readonly CsvColumn<CsvItem>[] = [
  col("eingang_am", "berlinDate", (i) => i.row.receivedAt),
  col("datei", "text", (i) => `belege/${i.stem}.${i.ext}`),
  col("sha256", "text", (i) => i.row.originalSha256),
  col("art", "text", (i) => i.row.kind),
  col("syntax", "text", (i) => i.row.syntax),
  col("profil", "text", (i) => i.row.profile),
  col("pruefstatus", "text", (i) => i.row.validationStatus),
  col("status", "text", (i) => i.row.status),
  col("lieferant", "text", (i) => i.head.supplierName),
  col("ust_id", "text", (i) => i.row.supplierVatId),
  col("steuernummer", "text", (i) => i.row.supplierTaxNumber),
  col("kontakt_nr", "text", (i) => i.contact?.customerNumber ?? null),
  col("kontakt_name", "text", (i) => i.contact?.name ?? null),
  col("nummer", "text", (i) => i.head.number),
  col("rechnungsdatum", "date", (i) => i.head.issueDate),
  col("faellig", "date", (i) => i.head.dueAt),
  col("waehrung", "text", (i) => i.head.currency),
  col("netto", "cents", (i) => i.row.netCents),
  col("steuer", "cents", (i) => i.row.taxCents),
  col("brutto", "cents", (i) => i.head.grossCents),
  col("zahlbetrag", "cents", (i) => i.head.payableCents),
  col("von_hand_erfasst", "bool", (i) => i.head.manual),
  col("geprueft_am", "berlinDate", (i) => i.row.checkedAt),
  col("freigegeben_am", "berlinDate", (i) => i.row.approvedAt),
  col("abgelehnt_am", "berlinDate", (i) => i.row.rejectedAt),
  col("ablehnungsgrund", "text", (i) => i.row.rejectReason),
  col("bezahlt_markiert_am", "berlinDate", (i) => i.row.paidMarkedAt),
  col("moegliche_dublette_von", "text", (i) => (i.row.duplicateOf ? (i.row.duplicateOf.number ?? i.row.duplicateOf.id) : null)),
];

const README = [
  "Uebergabe von Eingangsrechnungen",
  "",
  "Die Originaldateien liegen unveraendert im Ordner belege/. Massgeblich ist die Originaldatei;",
  "die Tabelle eingangsrechnungen.csv nennt Eingangsdatum, Lieferant und die gelesenen Kopfdaten.",
  "Sie enthaelt keine Buchungsdaten. Bei Hybrid-Rechnungen liegt die ausgelesene XML daneben",
  "(gleicher Name wie die Originaldatei, Endung .xml).",
  "Die Tabelle nicht blind in einer Tabellenkalkulation mit Formelauswertung oeffnen.",
  "",
].join("\r\n");

export async function buildIncomingHandoverFile(
  orgId: string,
  raw: unknown,
  opts: HandoverOptions = {},
): Promise<{ path: string; count: number; fileName: string }> {
  const q = incomingHandoverQuerySchema.parse(raw);
  const where = whereOf(orgId, q);
  rateLimit(`incoming-export:${orgId}`, { limit: INCOMING_EXPORT_PER_MINUTE, windowMs: 60_000 });
  const { count } = await planIncomingHandover(orgId, q, opts);
  // Plan und Aufbau laufen ohne gemeinsame Transaktion und die Hybrid-XML kommt zur Originalgroesse dazu:
  // die Laufsumme wird im Aufbau gegen die Grenze plus Reserve geprueft.
  const byteCeiling = Math.ceil((opts.maxBytes ?? MAX_HANDOVER_BYTES) * (1 + XML_RESERVE));
  const fileCeiling = opts.maxFiles ?? MAX_HANDOVER_FILES;
  let seenFiles = 0;
  let seenBytes = 0;

  const dir = await mkdtemp(path.join(os.tmpdir(), "oig-incoming-handover-"));
  const file = path.join(dir, "uebergabe.zip");
  try {
    const out = createWriteStream(file);
    out.on("error", () => undefined); // Fehler erfasst der ZipWriter
    try {
      const zip = new ZipWriter(out);
      const used = new Set<string>();
      const items: CsvItem[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await dbInternal.incomingInvoice.findMany({
          where,
          orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
          take: PAGE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: INCOMING_EXPORT_SELECT,
        });
        if (page.length === 0) break;
        cursor = page[page.length - 1].id;
        const contactIds = [...new Set(page.map((r) => r.supplierContactId).filter((x): x is string => x !== null))];
        const contacts = new Map(
          (await dbInternal.customer.findMany({ where: { orgId, id: { in: contactIds } }, select: { id: true, customerNumber: true, name: true } })).map((c) => [c.id, c]),
        );
        for (const r of page) {
          const head = effectiveHeader(r);
          const stem = incomingStem(r, head, used);
          const ext = originalExtension(r);
          const original = await getIncomingFile(orgId, r.id, "original");
          seenFiles += 1;
          seenBytes += original.bytes.length;
          if (seenFiles > fileCeiling || seenBytes > byteCeiling) throw new IncomingHandoverTooLargeError(seenFiles, seenBytes);
          await zip.addFile(`belege/${stem}.${ext}`, original.bytes);
          if (hasSeparateXml(r)) {
            const xml = await getIncomingFile(orgId, r.id, "xml");
            seenBytes += xml.bytes.length;
            if (seenBytes > byteCeiling) throw new IncomingHandoverTooLargeError(seenFiles, seenBytes);
            await zip.addFile(`belege/${stem}.xml`, xml.bytes);
          }
          const c = r.supplierContactId ? contacts.get(r.supplierContactId) : undefined;
          items.push({ row: r, head, stem, ext, contact: c ? { customerNumber: c.customerNumber, name: c.name } : null });
        }
        if (page.length < PAGE) break;
      }
      await zip.addFile("eingangsrechnungen.csv", Buffer.from(`﻿${csvTable(COLUMNS, items)}`, "utf8"));
      await zip.addFile("liesmich.txt", Buffer.from(README, "utf8"));
      await zip.finish();
      return { path: file, count, fileName: `eingang-${q.from}-${q.to}.zip` };
    } catch (e) {
      out.destroy();
      throw e;
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

export async function removeIncomingHandoverFile(file: string): Promise<void> {
  await rm(path.dirname(file), { recursive: true, force: true });
}

