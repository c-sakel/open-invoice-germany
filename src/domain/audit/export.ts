/**
 * Pruefer-Export nach § 147 Abs. 6 AO (Z3-Zugriff, Phase 16a): ZIP mit CSV-Tabellen, `index.xml`
 * (GDPdU-Beschreibung), DTD, Kettenpruefung und den archivierten Belegen (PDF + UBL).
 *
 * - Umfang: alle festgeschriebenen Rechnungen der Organisation mit Belegdatum im Zeitraum.
 * - Belege kommen ausschliesslich ueber `getArchivedInvoiceFile` (archiviert bei Bedarf, Quelle
 *   SCHEDULER; Manipulation => Abbruch). Interne Notizen werden nie gelesen (explizite `select`s).
 * - Speicher: Belege je einzeln, das Aenderungsprotokoll als Datenstrom; die uebrigen Tabellen
 *   sind durch `maxInvoices` begrenzt (Standard 20.000).
 */
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { dbInternal } from "@/lib/db";
import { ZipWriter } from "@/lib/zip/writer";
import { getArchivedInvoiceFile } from "@/domain/invoice/archive-read";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { buyerSnapshotSchema } from "@/schemas";
import {
  csvHeader,
  csvRow,
  formatCentsDe,
  formatDateDe,
  formatDateTimeDe,
  formatMilliCentsDe,
  formatMilliDe,
  type CsvColumn,
  type CsvValue,
} from "./export-csv";
import { buildIndexXml, GDPDU_DTD, GDPDU_DTD_FILENAME } from "./gdpdu/index-xml";

export const AUDIT_EXPORT_MAX_INVOICES = 20000;
const INVOICE_PAGE = 500;
const CHANGELOG_PAGE = 1000;

export class AuditExportTooLargeError extends Error {
  readonly status = 413;
  constructor(count: number, max: number) {
    super(`Der Zeitraum umfasst ${count} Belege (Grenze ${max}). Bitte den Zeitraum verkleinern.`);
    this.name = "AuditExportTooLargeError";
  }
}

/**
 * Hoechstzahl noch nicht archivierter Belege im Zeitraum, die ein Export synchron archiviert.
 * Darueber (z. B. vor Abschluss des Backfills nach dem ersten Deploy) wird mit 409 abgelehnt,
 * statt minutenlang im HTTP-Request zu rendern (Proxy-Timeout).
 */
export const AUDIT_EXPORT_MAX_PENDING = 200;

export class AuditExportPendingError extends Error {
  readonly status = 409;
  readonly pending: number;
  constructor(pending: number, max: number) {
    super(
      `Für den Zeitraum sind noch ${pending} Belege nicht archiviert (Grenze ${max}). ` +
        "Der nächtliche Archiv-Nachlauf holt das nach — bitte nach Abschluss erneut exportieren oder den Zeitraum verkleinern.",
    );
    this.name = "AuditExportPendingError";
    this.pending = pending;
  }
}

const t = (name: string): CsvColumn => ({ name, type: "text" });
const amount = (name: string): CsvColumn => ({ name, type: "amount" });
const date = (name: string): CsvColumn => ({ name, type: "date" });

const INVOICE_COLUMNS: readonly CsvColumn[] = [
  t("beleg"), t("art"), t("status"), t("steuerschema"), t("waehrung"), date("belegdatum"), date("lieferdatum"), date("faelligkeit"),
  amount("netto"), amount("steuer"), amount("brutto"), amount("bezahlt"), amount("zahlbetrag"), t("storniert_durch"), t("korrigiert_beleg"), t("xml_format"), t("festgeschrieben_am"),
];
const LINE_COLUMNS: readonly CsvColumn[] = [
  t("beleg"), { name: "position", type: "int" }, t("positionsart"), t("artikelnummer"), t("beschreibung"), { name: "menge", type: "quantity" }, t("einheit"),
  amount("einzelpreis_netto"), { name: "steuersatz", type: "int" }, t("steuerkategorie"), { name: "rabatt_promille", type: "int" }, amount("rabatt_betrag"), amount("zeilensumme_netto"),
  // Phase 18f: ungerundeter Einzelpreis (5 Nachkommastellen), leer bei Cent-Preisen; Endspalte, Bestandsspalten unveraendert.
  { name: "einzelpreis_exakt", type: "amount5" },
];
const PAYMENT_COLUMNS: readonly CsvColumn[] = [
  t("beleg"), t("zahlung_id"), t("art"), amount("betrag"), date("datum"), t("methode"), t("referenz"), t("skonto"), t("korrigiert_zahlung"), t("grund"), t("erfasst_von"), t("anbieter"), t("erfasst_am"),
];
const DUNNING_COLUMNS: readonly CsvColumn[] = [
  t("beleg"), t("mahnnummer"), { name: "stufe", type: "int" }, date("gesendet"), date("faellig"), amount("zinsen"), amount("mahngebuehr"), amount("zusatzkosten"), amount("pauschale"), t("pdf_sha256"), t("erstellt_von"),
];
const CUSTOMER_COLUMNS: readonly CsvColumn[] = [
  t("beleg"), t("kunde_id"), t("kundennummer"), t("name"), t("ansprechpartner"), t("anschrift1"), t("anschrift2"), t("plz"), t("ort"), t("land"), t("ust_id"), t("email"), t("leitweg_id"),
];
const CHANGELOG_COLUMNS: readonly CsvColumn[] = [
  { name: "id", type: "int" }, { name: "at", type: "text" }, t("entity"), t("entity_id"), t("action"), t("actor"), t("prev_hash"), t("hash"), t("diff"),
];
const ARCHIVE_COLUMNS: readonly CsvColumn[] = [t("beleg"), t("kind"), t("sha256"), t("source"), t("created_at")];

const TABLES: ReadonlyArray<{ file: string; name: string; description: string; columns: readonly CsvColumn[] }> = [
  { file: "rechnungen.csv", name: "Rechnungen", description: "Festgeschriebene Rechnungen, Gutschriften und Korrekturen des Zeitraums", columns: INVOICE_COLUMNS },
  { file: "positionen.csv", name: "Positionen", description: "Belegpositionen", columns: LINE_COLUMNS },
  { file: "zahlungen.csv", name: "Zahlungen", description: "Zahlungen und Gegenbuchungen (art PAYMENT/REVERSAL)", columns: PAYMENT_COLUMNS },
  { file: "mahnungen.csv", name: "Mahnungen", description: "Erstellte Mahnungen", columns: DUNNING_COLUMNS },
  { file: "kunden.csv", name: "Kunden", description: "Kundendaten wie am Beleg festgehalten (Snapshot)", columns: CUSTOMER_COLUMNS },
  { file: "aenderungsprotokoll.csv", name: "Aenderungsprotokoll", description: "Hash-verkettetes Aenderungsprotokoll des Zeitraums", columns: CHANGELOG_COLUMNS },
  { file: "archiv.csv", name: "Belegarchiv", description: "Archivierte Belegdateien mit SHA-256", columns: ARCHIVE_COLUMNS },
];

/** Schreibt CSV-Zeilen gepuffert in eine Temp-Datei (Speicher bleibt unabhaengig von der Belegzahl flach). */
class CsvSink {
  private readonly stream: WriteStream;
  private pending = "";
  private failure: Error | null = null;

  constructor(readonly filePath: string, header: string) {
    this.stream = createWriteStream(filePath);
    this.stream.on("error", (e: Error) => {
      this.failure = e;
    });
    this.pending = header;
  }

  async add(line: string): Promise<void> {
    this.pending += line;
    if (this.pending.length >= 65536) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.pending === "") return;
    const chunk = this.pending;
    this.pending = "";
    if (!this.stream.write(chunk, "utf8")) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.stream.off("drain", done);
          this.stream.off("close", done);
          this.stream.off("error", done);
          resolve();
        };
        this.stream.once("drain", done);
        this.stream.once("close", done);
        this.stream.once("error", done);
      });
    }
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    await this.flush();
    await new Promise<void>((resolve) => {
      this.stream.once("error", () => resolve());
      this.stream.end(() => resolve());
    });
    if (this.failure) throw this.failure;
  }

  destroy(): void {
    this.stream.destroy();
  }
}

const README = [
  "Pruefer-Export (Z3-Datentraegerueberlassung, Paragraph 147 Abs. 6 AO)",
  "",
  "Die CSV-Dateien nicht in einer Tabellenkalkulation mit Formelauswertung oeffnen;",
  "sie sind fuer Pruefsoftware (IDEA) ueber index.xml vorgesehen. Inhalte sind unveraendert",
  "aus den Belegen uebernommen (keine Neutralisierung von Formelzeichen).",
  "",
  "belege/<nr>.xml ist immer die archivierte XRechnung (UBL), auch bei ZUGFeRD-Belegen; deren",
  "CII steckt eingebettet im PDF, ihr SHA-256 steht in archiv.csv.",
  "",
  "Die amtliche GDPdU-DTD (Version 01.09.2004) ist mitgeliefert (gdpdu-01-09-2004.dtd).",
  "",
].join("\r\n");

function fileStem(number: string): string {
  return number.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Eindeutiger Dateiname je Beleg (RE/1 und RE_1 kollidieren sonst); bei Kollision Suffix mit gekuerzter Beleg-ID. */
export function uniqueFileStem(number: string, id: string, used: Set<string>): string {
  let stem = fileStem(number);
  if (used.has(stem.toLowerCase())) stem = `${stem}-${id.slice(0, 8)}`;
  while (used.has(stem.toLowerCase())) stem += "_";
  used.add(stem.toLowerCase());
  return stem;
}

function parseBuyer(json: string | null) {
  if (!json) return null;
  try {
    const parsed = buyerSnapshotSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const d = (v: Date | null): string | null => (v ? formatDateDe(v) : null);

export async function buildAuditExport(
  orgId: string,
  range: { from: Date; to: Date },
  out: Writable,
  opts: { maxInvoices?: number; maxPending?: number } = {},
): Promise<{ invoices: number }> {
  const max = opts.maxInvoices ?? AUDIT_EXPORT_MAX_INVOICES;
  const maxPending = opts.maxPending ?? AUDIT_EXPORT_MAX_PENDING;
  const where = { orgId, status: { not: "DRAFT" }, number: { not: null }, issueDate: { gte: range.from, lte: range.to } };
  const count = await dbInternal.invoice.count({ where });
  if (count > max) throw new AuditExportTooLargeError(count, max);
  const pending = await dbInternal.invoice.count({ where: { ...where, archivedDocuments: { none: {} } } });
  if (pending > maxPending) throw new AuditExportPendingError(pending, maxPending);

  const org = await dbInternal.organization.findUnique({ where: { id: orgId }, select: { legalName: true, city: true } });
  const zip = new ZipWriter(out);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "oig-audit-csv-"));
  const sinks: Record<string, CsvSink> = {};
  try {
  for (const tbl of TABLES) {
    if (tbl.file !== "aenderungsprotokoll.csv") sinks[tbl.file] = new CsvSink(path.join(workDir, tbl.file), csvHeader(tbl.columns));
  }
  const add = (file: string, values: CsvValue[]) => sinks[file].add(csvRow(values));
  const usedStems = new Set<string>();

  let cursor: string | undefined;
  for (;;) {
    const page = await dbInternal.invoice.findMany({
      where,
      orderBy: { id: "asc" },
      take: INVOICE_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, number: true, type: true, status: true, taxScheme: true, currency: true, issueDate: true, deliveryDate: true, dueDate: true,
        netTotalCents: true, taxTotalCents: true, grossTotalCents: true, paidAmountCents: true, payableCents: true, finalizedAt: true,
        reversedByInvoiceId: true, correctsInvoiceId: true, xmlFormat: true, customerId: true, buyerSnapshotJson: true,
        lines: {
          orderBy: { position: "asc" },
          select: {
            position: true, lineType: true, articleNumber: true, description: true, quantityMilli: true, unit: true, unitNetPriceCents: true, unitNetPriceMilliCents: true,
            taxRate: true, taxCategory: true, discountPermille: true, discountCents: true, lineNetCents: true,
          },
        },
        payments: {
          orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
          select: {
            id: true, kind: true, amountCents: true, paidAt: true, method: true, reference: true, isSkonto: true, reversesPaymentId: true, reason: true,
            createdBy: true, provider: true, createdAt: true,
          },
        },
        dunnings: {
          orderBy: { level: "asc" },
          select: {
            number: true, level: true, sentAt: true, dueDate: true, interestAmountCents: true, feeCents: true, lateFeeCents: true, flatFee40Cents: true,
            pdfSha256: true, createdBy: true,
          },
        },
      },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    // Belege zuerst: archiviert bei Bedarf (Quelle SCHEDULER) und liefert nur Archivbytes.
    for (const inv of page) {
      const stem = uniqueFileStem(inv.number ?? inv.id, inv.id, usedStems);
      await zip.addFile(`belege/${stem}.pdf`, await getArchivedInvoiceFile(orgId, inv.id, "PDF", { source: "SCHEDULER" }));
      await zip.addFile(`belege/${stem}.xml`, await getArchivedInvoiceFile(orgId, inv.id, "UBL", { source: "SCHEDULER" }));
    }

    const refIds = [...new Set(page.flatMap((i) => [i.reversedByInvoiceId, i.correctsInvoiceId]).filter((x): x is string => x !== null))];
    const refNumbers = new Map(
      (await dbInternal.invoice.findMany({ where: { orgId, id: { in: refIds } }, select: { id: true, number: true } })).map((r) => [r.id, r.number]),
    );
    const archived = await dbInternal.archivedDocument.findMany({
      where: { invoiceId: { in: page.map((i) => i.id) } },
      orderBy: [{ invoiceId: "asc" }, { kind: "asc" }],
      select: { invoiceId: true, kind: true, sha256: true, source: true, createdAt: true },
    });
    const numberOf = new Map(page.map((i) => [i.id, i.number ?? i.id]));

    for (const inv of page) {
      const nr = inv.number ?? inv.id;
      await add("rechnungen.csv", [
        nr, inv.type, inv.status, inv.taxScheme, inv.currency, formatDateDe(inv.issueDate), d(inv.deliveryDate), d(inv.dueDate),
        formatCentsDe(inv.netTotalCents), formatCentsDe(inv.taxTotalCents), formatCentsDe(inv.grossTotalCents), formatCentsDe(inv.paidAmountCents),
        formatCentsDe(inv.payableCents ?? inv.grossTotalCents),
        inv.reversedByInvoiceId ? (refNumbers.get(inv.reversedByInvoiceId) ?? null) : null,
        inv.correctsInvoiceId ? (refNumbers.get(inv.correctsInvoiceId) ?? null) : null,
        inv.xmlFormat, inv.finalizedAt ? formatDateTimeDe(inv.finalizedAt) : null,
      ]);
      for (const l of inv.lines) {
        await add("positionen.csv", [
          nr, l.position, l.lineType, l.articleNumber, l.description, formatMilliDe(l.quantityMilli), l.unit, formatCentsDe(l.unitNetPriceCents),
          l.taxRate, l.taxCategory, l.discountPermille, formatCentsDe(l.discountCents), formatCentsDe(l.lineNetCents),
          l.unitNetPriceMilliCents === null ? null : formatMilliCentsDe(l.unitNetPriceMilliCents),
        ]);
      }
      for (const p of inv.payments) {
        await add("zahlungen.csv", [
          nr, p.id, p.kind, formatCentsDe(p.amountCents), formatDateDe(p.paidAt), p.method, p.reference, p.isSkonto ? "ja" : "nein", p.reversesPaymentId, p.reason,
          p.createdBy, p.provider, formatDateTimeDe(p.createdAt),
        ]);
      }
      for (const m of inv.dunnings) {
        await add("mahnungen.csv", [
          nr, m.number, m.level, formatDateDe(m.sentAt), d(m.dueDate), formatCentsDe(m.interestAmountCents), formatCentsDe(m.feeCents), formatCentsDe(m.lateFeeCents),
          formatCentsDe(m.flatFee40Cents), m.pdfSha256, m.createdBy,
        ]);
      }
      const b = parseBuyer(inv.buyerSnapshotJson);
      if (b) {
        await add("kunden.csv", [
          nr, inv.customerId, b.customerNumber ?? null, b.name, b.contactName, b.addressLine1, b.addressLine2, b.postalCode, b.city, b.countryCode, b.vatId, b.email, b.leitwegId,
        ]);
      }
    }
    for (const a of archived) {
      await add("archiv.csv", [numberOf.get(a.invoiceId) ?? a.invoiceId, a.kind, a.sha256, a.source, formatDateTimeDe(a.createdAt)]);
    }
    if (page.length < INVOICE_PAGE) break;
  }

  // Kettenpruefung NACH dem Archivieren (die Archivierung schreibt ChangeLog-Eintraege).
  const chain = await verifyOrgChain(orgId, "EXPORT");
  const chainText = [
    "Pruefung der Hash-Kette des Aenderungsprotokolls",
    `Geprueft am: ${formatDateTimeDe(chain.checkedAt)} UTC`,
    `Ergebnis: ${chain.valid ? "GUELTIG" : "UNTERBROCHEN"}`,
    `Eintraege der Organisation: ${chain.entries}`,
    `Erster fehlerhafter Eintrag (id): ${chain.brokenEntryId ?? "-"}`,
    `Letzter Hash: ${chain.lastHash || "-"}`,
    `Dauer: ${chain.durationMs} ms`,
    "",
  ].join("\r\n");

  await zip.addFile("liesmich.txt", Buffer.from(README, "utf8"));
  for (const tbl of TABLES) {
    if (tbl.file === "aenderungsprotokoll.csv") continue;
    await sinks[tbl.file].close();
    await zip.addFile(tbl.file, createReadStream(sinks[tbl.file].filePath));
  }
  await zip.addFile("kettenpruefung.txt", Buffer.from(chainText, "utf8"));

  async function* changeLogRows(): AsyncGenerator<string> {
    yield csvHeader(CHANGELOG_COLUMNS);
    let lastId = 0;
    for (;;) {
      const rows = await dbInternal.changeLog.findMany({
        where: { orgId, at: { gte: range.from, lte: range.to }, id: { gt: lastId } },
        orderBy: { id: "asc" },
        take: CHANGELOG_PAGE,
        select: { id: true, at: true, entity: true, entityId: true, action: true, actor: true, prevHash: true, hash: true, diffJson: true },
      });
      if (rows.length === 0) return;
      let chunk = "";
      for (const r of rows) {
        const cells: CsvValue[] = [r.id, formatDateTimeDe(r.at), r.entity, r.entityId, r.action, r.actor, r.prevHash, r.hash, r.diffJson];
        chunk += csvRow(cells);
      }
      yield chunk;
      lastId = rows[rows.length - 1].id;
      if (rows.length < CHANGELOG_PAGE) return;
    }
  }
  await zip.addFile("aenderungsprotokoll.csv", Readable.from(changeLogRows()));

  await zip.addFile(GDPDU_DTD_FILENAME, Buffer.from(GDPDU_DTD, "utf8"));
  await zip.addFile(
    "index.xml",
    Buffer.from(
      buildIndexXml({
        supplierName: org?.legalName ?? "",
        supplierLocation: org?.city ?? "",
        comment: `Pruefer-Export ${formatDateDe(range.from)} bis ${formatDateDe(range.to)}`,
        tables: TABLES,
      }),
      "utf8",
    ),
  );
  await zip.finish();
  return { invoices: count };
  } finally {
    for (const sink of Object.values(sinks)) sink.destroy();
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Baut den Export in eine temporaere Datei (Fehler wie Archivmanipulation oder zu grosser
 * Zeitraum treten so VOR dem ersten Byte der HTTP-Antwort auf) und liefert den Pfad.
 * Der Aufrufer loescht die Datei nach dem Senden.
 */
export async function buildAuditExportFile(
  orgId: string,
  range: { from: Date; to: Date },
  opts: { maxInvoices?: number; maxPending?: number } = {},
): Promise<{ path: string; invoices: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oig-audit-export-"));
  const file = path.join(dir, "export.zip");
  try {
    const out = createWriteStream(file);
    out.on("error", () => undefined); // Fehler erfasst der ZipWriter; hier nur gegen uncaught 'error' absichern
    try {
      const { invoices } = await buildAuditExport(orgId, range, out, opts);
      return { path: file, invoices };
    } catch (e) {
      out.destroy();
      throw e;
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

export async function removeAuditExportFile(file: string): Promise<void> {
  await rm(path.dirname(file), { recursive: true, force: true });
}
