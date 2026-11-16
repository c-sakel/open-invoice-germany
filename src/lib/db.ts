/**
 * Prisma-Client mit GoBD-Unveränderbarkeits-Guard.
 *
 * `prisma`      — allgemeiner Client (API-Routes, UI). Blockt update/delete an
 *                 festgeschriebenen Rechnungen/Positionen (status !== DRAFT).
 * `dbInternal`  — ungeschützter Client. NUR in geprüften Domain-Services
 *                 (finalize, cancel, recordPayment) verwenden, die kontrollierte
 *                 Statuswechsel vornehmen.
 */
import { QUOTE_TRANSITIONS, DELIVERY_TRANSITIONS } from "@/domain/document/status-transitions";
import path from "node:path";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";

/**
 * Löst einen relativen SQLite-`file:`-Pfad in einen ABSOLUTEN Pfad auf.
 * Notwendig, weil der von Bundlern (Next/Turbopack) gebündelte Client das
 * relative `./dev.db` sonst relativ zum Bundle statt zum Schema-Verzeichnis
 * auflöst. Die Prisma-CLI ankert relative Pfade am Schema-Verzeichnis (prisma/)
 * — das spiegeln wir hier. PostgreSQL-/absolute URLs bleiben unverändert.
 */
function resolveDatasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) return url;
  const filePath = url.slice("file:".length);
  if (path.isAbsolute(filePath)) return url;
  const abs = path.resolve(process.cwd(), "prisma", filePath.replace(/^\.\//, ""));
  return `file:${abs}`;
}

/**
 * Case-insensitiver "contains"-Filter, portabel ueber SQLite und Postgres (Phase
 * 8b, Ruling Task-1-Facts). SQLite `contains` ist fuer ASCII bereits case-
 * insensitiv (Datenbank-Collation), `mode: "insensitive"` ist dort ein
 * Laufzeitfehler (Prisma unterstuetzt den Modus nur bei Postgres) — deshalb wird
 * `mode` NUR gesetzt, wenn der Provider Postgres ist (erkannt am Praefix von
 * `DATABASE_URL`, analog `resolveDatasourceUrl` oben).
 */
export function isPostgresUrl(url?: string): boolean {
  return (url ?? "").startsWith("postgres");
}

export function ciContains(value: string): { contains: string; mode?: "insensitive" } {
  const isPostgres = isPostgresUrl(process.env.DATABASE_URL);
  return isPostgres ? { contains: value, mode: "insensitive" } : { contains: value };
}

export class GobdImmutabilityError extends Error {
  constructor(public readonly ref: string) {
    super(
      `GoBD: Festgeschriebene Rechnung "${ref}" ist unveränderbar. ` +
        `Korrektur nur per Storno oder Korrekturrechnung (§ 146 Abs. 4 AO).`,
    );
    this.name = "GobdImmutabilityError";
  }
}

const globalForPrisma = globalThis as unknown as { __oigBase?: PrismaClient };
const datasourceUrl = resolveDatasourceUrl();
const base = globalForPrisma.__oigBase ?? new PrismaClient(datasourceUrl ? { datasourceUrl } : undefined);
if (process.env.NODE_ENV !== "production") globalForPrisma.__oigBase = base;

/** Ungeschützter Basis-Client — nur intern. */
export const dbInternal = base;

async function guardInvoiceWhere(where: unknown): Promise<void> {
  const rows = await base.invoice.findMany({
    where: (where ?? {}) as never,
    select: { id: true, number: true, status: true },
  });
  const locked = rows.find((r) => r.status !== "DRAFT");
  if (locked) throw new GobdImmutabilityError(locked.number ?? locked.id);
}

/**
 * B9 (Fix-Welle): `FinalInvoiceDeduction` ist der Abzugs-Snapshot einer Schlussrechnung
 * (Abschn. 14.8 UStAE) — genauso unveraenderlich wie die Rechnung/Zeilen selbst, aber
 * bisher ohne Guard (anders als `invoice`/`invoiceLine`). Anders als dort gibt es keinen
 * DRAFT-Status, ueber den eine Aenderung je legitim waere: die Zeilen werden
 * ausschliesslich einmalig innerhalb von `finalizeWithinTx` per `createMany` auf dem
 * ungeschuetzten `dbInternal`/Transaktions-Client geschrieben — ueber den geschuetzten
 * `prisma`-Client sind update/delete/updateMany/deleteMany deshalb IMMER verboten.
 */
class FinalInvoiceDeductionImmutabilityError extends Error {
  constructor() {
    super(
      "GoBD: FinalInvoiceDeduction ist ein unveraenderlicher Abzugs-Snapshot der Schlussrechnung " +
        "und kann nicht nachtraeglich geaendert oder geloescht werden (Abschn. 14.8 UStAE).",
    );
    this.name = "FinalInvoiceDeductionImmutabilityError";
  }
}

/**
 * Phase 18f: `RecurringUsage` (Abo-Verbrauchssaetze) sind nach Erfassung unveraenderlich.
 * create ueber den geschuetzten Client ist erlaubt; Verknuepfung mit der Rechnung (invoiceId/billedAt)
 * und Storno (voidUsage) laufen ausschliesslich ueber `dbInternal` in den Domain-Services.
 */
export class RecurringUsageImmutabilityError extends Error {
  constructor() {
    super("Verbrauchssaetze sind nach Erfassung unveraenderlich; Storno nur ueber voidUsage");
    this.name = "RecurringUsageImmutabilityError";
  }
}

async function guardLineWhere(where: unknown): Promise<void> {
  const rows = await base.invoiceLine.findMany({
    where: (where ?? {}) as never,
    select: { id: true, invoice: { select: { id: true, number: true, status: true } } },
  });
  const locked = rows.find((r) => r.invoice.status !== "DRAFT");
  if (locked) throw new GobdImmutabilityError(locked.invoice.number ?? locked.invoice.id);
}

/** invoiceId aus einem Create-Payload (skalar oder `invoice.connect`); null, wenn nicht bestimmbar. */
function lineCreateInvoiceId(data: unknown): string | null {
  const d = (data ?? {}) as { invoiceId?: unknown; invoice?: { connect?: { id?: unknown } } };
  const scalar = unwrapSet(d.invoiceId);
  if (typeof scalar === "string") return scalar;
  const connected = d.invoice?.connect?.id;
  return typeof connected === "string" ? connected : null;
}

/**
 * Neue Positionen duerfen nur an Entwuerfe gehaengt werden (GoBD). Nicht bestimmbare
 * Rechnung (z. B. `invoice.create` im Payload) wird abgelehnt, damit kein Pfad vorbeikommt.
 */
async function guardLineCreate(data: unknown): Promise<void> {
  const items = Array.isArray(data) ? data : [data];
  const ids = new Set<string>();
  for (const item of items) {
    const id = lineCreateInvoiceId(item);
    if (!id) throw new GobdImmutabilityError("neue Position ohne bestimmbare Rechnung");
    ids.add(id);
  }
  if (ids.size === 0) return;
  const rows = await base.invoice.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, number: true, status: true },
  });
  const locked = rows.find((r) => r.status !== "DRAFT");
  if (locked) throw new GobdImmutabilityError(locked.number ?? locked.id);
}

/** IDs aus `lines: { connect | set | connectOrCreate }` eines Kopf-Payloads (nested writes). */
function connectedLineIds(data: unknown): string[] {
  const lines = (data as { lines?: unknown } | null | undefined)?.lines;
  if (lines === null || typeof lines !== "object") return [];
  const l = lines as { connect?: unknown; set?: unknown; connectOrCreate?: unknown };
  const ids: string[] = [];
  const pick = (v: unknown) => {
    for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      const id = (item as { id?: unknown; where?: { id?: unknown } } | null)?.id ?? (item as { where?: { id?: unknown } } | null)?.where?.id;
      ids.push(typeof id === "string" ? id : "");
    }
  };
  pick(l.connect);
  pick(l.set);
  pick(l.connectOrCreate);
  return ids;
}

/**
 * Nested `lines.connect/set/connectOrCreate` am Kopf haengt bestehende Positionen um: die Quell-
 * Positionen duerfen dann nicht zu einem ausgegebenen/festgeschriebenen Beleg gehoeren (kein Domain-Pfad
 * nutzt diese Schreibweise; nicht bestimmbare IDs werden abgelehnt).
 */
async function guardInvoiceLinesConnect(data: unknown): Promise<void> {
  const ids = connectedLineIds(data);
  if (ids.length === 0) return;
  if (ids.some((i) => i === "")) throw new GobdImmutabilityError("Positionen ohne bestimmbare ID");
  const rows = await base.invoiceLine.findMany({
    where: { id: { in: ids } },
    select: { invoice: { select: { id: true, number: true, status: true } } },
  });
  const locked = rows.find((r) => r.invoice.status !== "DRAFT");
  if (locked) throw new GobdImmutabilityError(locked.invoice.number ?? locked.invoice.id);
}

/** Umhaengen einer Position (`invoiceId`/`invoice` im Update-Payload): auch der Zielbeleg muss ein Entwurf sein. */
async function guardInvoiceLineMove(data: unknown): Promise<void> {
  const d = (data ?? {}) as Record<string, unknown>;
  if (!("invoiceId" in d) && !("invoice" in d)) return;
  await guardLineCreate(d);
}

/**
 * Phase 6: `Dunning` ist ein Geschaeftsbrief (GoBD) — nach Erstellung unveraenderlich,
 * analog `FinalInvoiceDeduction`. Eine Ausnahme bleibt ueber den geschuetzten Client
 * erlaubt: `sentAt` (tatsaechlicher Versandzeitpunkt, erst nach dem Mailversand bekannt).
 * `pdfPath`/`pdfSha256` (Mahnungsarchiv, Phase 16a) sind write-once und werden
 * ausschliesslich in `src/domain/dunning/archive.ts` per `dbInternal.dunning.updateMany`
 * mit `where: { pdfPath: null }` gesetzt — ueber den geschuetzten Client verboten. Jeder andere Schluessel
 * in `data` wird verweigert; delete/deleteMany sind — wie bei FinalInvoiceDeduction —
 * IMMER verboten.
 */
const DUNNING_MUTABLE_KEYS = new Set(["sentAt"]);

export class DunningImmutabilityError extends Error {
  constructor(badKeys: string[]) {
    super(
      `GoBD: Mahnung ist nach Erstellung unveraenderlich (Geschaeftsbrief). Nur sentAt ` +
        `duerfen nachtraeglich gesetzt werden, nicht: ${badKeys.join(", ")}.`,
    );
    this.name = "DunningImmutabilityError";
  }
}

function assertDunningUpdateAllowed(data: unknown): void {
  const keys = Object.keys((data ?? {}) as Record<string, unknown>);
  const badKeys = keys.filter((k) => !DUNNING_MUTABLE_KEYS.has(k));
  if (badKeys.length > 0) throw new DunningImmutabilityError(badKeys);
}

/**
 * `PaymentRuleRun` ist Outbox und Nachweis: nie loeschbar, Zuordnung und Schnappschuss
 * (Regel, Zahlung, Rechnung, Kunde, Ausloeser, Quelle, Aktionen, Kontext, Org, Anlage) unveraenderlich.
 * Fortschreibbar sind nur Ausfuehrungsstand und Fehler; `mailSentAt` ueber den geschuetzten Client genau einmal
 * (NULL -> Wert). Die einzige Ruecknahme ist `releaseMailClaim` (nur wenn sicher nichts an den Mailanbieter ging).
 */
export class PaymentRuleRunImmutabilityError extends Error {
  constructor(detail: string) {
    super(`Regel-Lauf ist unveraenderlich: ${detail}`);
    this.name = "PaymentRuleRunImmutabilityError";
  }
}

const PAYMENT_RULE_RUN_MUTABLE_KEYS: ReadonlySet<string> = new Set([
  "stepsJson",
  "status",
  "attempts",
  "nextAttemptAt",
  "lockedUntil",
  "lastError",
  "skipReason",
  "mailSentAt",
  "finishedAt",
]);

/** Status nur vorwaerts: PENDING -> RUNNING -> DONE|FAILED|SKIPPED; Rueckkehr nach PENDING (Wiederholung) und FAILED -> PENDING (Retry). DONE/SKIPPED sind endgueltig. */
const PAYMENT_RULE_RUN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  PENDING: ["PENDING", "RUNNING", "SKIPPED"],
  RUNNING: ["RUNNING", "PENDING", "DONE", "FAILED", "SKIPPED"],
  FAILED: ["PENDING"],
  DONE: [],
  SKIPPED: [],
};

function unwrapSet(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !(v instanceof Date) && "set" in v) return (v as { set: unknown }).set;
  return v;
}

/**
 * Gibt den Versand-Claim (`mailSentAt`) eines Regel-Laufs frei. Ausschliesslich fuer Faelle, in denen sicher
 * nichts an den Mailanbieter uebergeben wurde (uebersprungen, verschoben, Fehler vor dem Senden) und fuer die
 * bewusst manuelle Wiederholung eines fehlgeschlagenen Mail-Schritts. Der Guard erlaubt NULL -> Wert nur
 * einmal, deshalb laeuft diese benannte Ausnahme ueber den ungeschuetzten Client; `claimedAt` begrenzt sie
 * auf den eigenen Claim.
 */
export async function releaseMailClaim(
  client: Pick<Prisma.TransactionClient, "paymentRuleRun">,
  target: { id: string; orgId: string; claimedAt?: Date },
): Promise<number> {
  const res = await client.paymentRuleRun.updateMany({
    where: { id: target.id, orgId: target.orgId, mailSentAt: target.claimedAt ?? { not: null } },
    data: { mailSentAt: null },
  });
  return res.count;
}

async function guardPaymentRuleRunUpdate(where: unknown, data: unknown): Promise<void> {
  const record = (data ?? {}) as Record<string, unknown>;
  const badKeys = Object.keys(record).filter((k) => !PAYMENT_RULE_RUN_MUTABLE_KEYS.has(k));
  if (badKeys.length > 0) throw new PaymentRuleRunImmutabilityError(badKeys.join(", "));
  if ("status" in record) {
    const nextStatus = unwrapSet(record.status);
    if (typeof nextStatus !== "string") throw new PaymentRuleRunImmutabilityError("status");
    const current = await base.paymentRuleRun.findMany({
      where: where as Prisma.PaymentRuleRunWhereInput,
      select: { status: true },
    });
    for (const row of current) {
      if (!(PAYMENT_RULE_RUN_TRANSITIONS[row.status] ?? []).includes(nextStatus)) {
        throw new PaymentRuleRunImmutabilityError(`Status ${row.status} -> ${nextStatus}`);
      }
    }
  }
  if ("mailSentAt" in record) {
    const next = unwrapSet(record.mailSentAt);
    if (!(next instanceof Date)) throw new PaymentRuleRunImmutabilityError("mailSentAt nur von NULL auf einen Wert");
    const rows = await base.paymentRuleRun.findMany({
      where: where as Prisma.PaymentRuleRunWhereInput,
      select: { mailSentAt: true },
    });
    if (rows.some((r) => r.mailSentAt !== null)) {
      throw new PaymentRuleRunImmutabilityError("mailSentAt nur von NULL auf einen Wert");
    }
  }
}

/**
 * Phase 16g: `LayoutDesignVersion` ist unveraenderlich (eingefrorene Belege verweisen darauf);
 * jede Aenderung der Konfiguration ist eine neue Zeile. `LayoutDesign` wird nie geloescht,
 * nur archiviert (`update` bleibt erlaubt: Name, archived, currentVersion).
 */
export class LayoutDesignVersionImmutabilityError extends Error {
  constructor() {
    super("GoBD: Layout-Design-Versionen sind unveraenderlich; Aenderungen erzeugen eine neue Version.");
    this.name = "LayoutDesignVersionImmutabilityError";
  }
}

/**
 * Das Kundenportal-Abrufprotokoll ist ein Nachweis. `CustomerPortalEvent` ist append-only
 * (nur `create`); die Loeschung nach Ablauf der Aufbewahrung laeuft ausschliesslich ueber `dbInternal`.
 */
export class CustomerPortalEventImmutableError extends Error {
  constructor() {
    super("Portal-Abrufprotokoll ist unveraenderlich (append-only).");
    this.name = "CustomerPortalEventImmutableError";
  }
}

/**
 * Phase 16d: Das Postversand-Protokoll ist ein Nachweis (GoBD). `PostalJobEvent` ist append-only
 * (nur `create`). `PostalJob` wird nie geloescht; nach dem Anlegen sind nur Status-, Preis-,
 * Verfolgungs- und Zeitfelder fortschreibbar — Belegbezug, Pruefsummen, Modus und Versandart
 * bleiben unveraenderlich, damit der Nachweis, was wann versandt wurde, nicht verfaelscht wird.
 */
export class PostalJobEventImmutableError extends Error {
  constructor() {
    super("Versandereignisse sind unveraenderlich (append-only).");
    this.name = "PostalJobEventImmutableError";
  }
}

export class PostalJobImmutableError extends Error {
  constructor(detail: string) {
    super(`Versandauftrag ist ein Nachweis und nicht aenderbar: ${detail}`);
    this.name = "PostalJobImmutableError";
  }
}

const POSTAL_JOB_MUTABLE_KEYS = new Set([
  "status",
  "providerJobId",
  "priceCents",
  "vatCents",
  "providerAddress",
  "trackingCode",
  "trackingStatus",
  "error",
  "submittedAt",
  "lastPolledAt",
  "finishedAt",
]);

function assertPostalJobUpdateAllowed(data: unknown): void {
  const keys = Object.keys((data ?? {}) as Record<string, unknown>);
  const badKeys = keys.filter((k) => !POSTAL_JOB_MUTABLE_KEYS.has(k));
  if (badKeys.length > 0) throw new PostalJobImmutableError(badKeys.join(", "));
}

/**
 * Online-Zahlung: Ereignisprotokoll ist append-only (nur `create`). Bezahllinks und Bezahlvorgaenge werden nie
 * geloescht; ihre Zuordnung (Rechnung, Anbieter, Betrag, Token) bleibt unveraenderlich, nur Status- und
 * Zeitfelder sind fortschreibbar. Dass `providerObjectId`/`checkoutUrl` nur von NULL auf einen Wert wechseln,
 * erzwingt der Service per bedingtem `updateMany`.
 */
export class PaymentProviderEventImmutableError extends Error {
  constructor() {
    super("Anbieter-Ereignisse sind unveraenderlich (append-only).");
    this.name = "PaymentProviderEventImmutableError";
  }
}

export class PaymentProviderAttemptImmutableError extends Error {
  constructor(detail: string) {
    super(`Bezahlvorgang ist ein Nachweis und nicht aenderbar: ${detail}`);
    this.name = "PaymentProviderAttemptImmutableError";
  }
}

export class InvoicePayLinkImmutableError extends Error {
  constructor(detail: string) {
    super(`Bezahllink ist ein Nachweis und nicht aenderbar: ${detail}`);
    this.name = "InvoicePayLinkImmutableError";
  }
}

const PAYMENT_ATTEMPT_MUTABLE_KEYS: ReadonlySet<string> = new Set([
  "providerObjectId",
  "providerPaymentRef",
  "checkoutUrl",
  "expiresAt",
  "status",
  "error",
  "lastCheckedAt",
  "updatedAt",
]);

const INVOICE_PAY_LINK_MUTABLE_KEYS: ReadonlySet<string> = new Set(["status", "disabledAt", "disabledReason", "liveIssued"]);

function assertOnlyKeys(data: unknown, allowed: ReadonlySet<string>, make: (detail: string) => Error): void {
  const keys = Object.keys((data ?? {}) as Record<string, unknown>);
  const bad = keys.filter((k) => !allowed.has(k));
  if (bad.length > 0) throw make(bad.join(", "));
}

const attemptErr = (d: string): Error => new PaymentProviderAttemptImmutableError(d);
const payLinkErr = (d: string): Error => new InvoicePayLinkImmutableError(d);

/** Status des Bezahlvorgangs nur vorwaerts; PAID, EXPIRED, CANCELED und FAILED sind endgueltig. */
const PAYMENT_ATTEMPT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  CREATING: ["CREATING", "OPEN", "PAID", "EXPIRED", "CANCELED", "FAILED"],
  OPEN: ["OPEN", "PAID", "EXPIRED", "CANCELED", "FAILED"],
  PAID: ["PAID"],
  EXPIRED: ["EXPIRED"],
  CANCELED: ["CANCELED"],
  FAILED: ["FAILED"],
};

const PAY_LINK_DISABLE_REASONS: ReadonlySet<string> = new Set(["MANUAL", "INVOICE_CANCELLED", "INVOICE_PAID"]);

/**
 * Bezahlvorgang: `providerObjectId` (Schluessel der Zuordnung Webhook -> Zahlung) und `checkoutUrl`
 * (Ziel der Weiterleitung) werden genau einmal von NULL auf einen Text gesetzt; Status nur vorwaerts.
 */
async function guardPaymentAttemptUpdate(where: unknown, data: unknown): Promise<void> {
  assertOnlyKeys(data, PAYMENT_ATTEMPT_MUTABLE_KEYS, attemptErr);
  const record = (data ?? {}) as Record<string, unknown>;
  const whereInput = where as Prisma.PaymentProviderAttemptWhereInput;
  for (const key of ["providerObjectId", "providerPaymentRef", "checkoutUrl"] as const) {
    if (!(key in record)) continue;
    const next = unwrapSet(record[key]);
    if (typeof next !== "string" || next.length === 0) throw attemptErr(`${key} nur von NULL auf einen Wert`);
    const rows = await base.paymentProviderAttempt.findMany({ where: whereInput, select: { [key]: true } });
    if (rows.some((r) => r[key] !== null)) throw attemptErr(`${key} nur von NULL auf einen Wert`);
  }
  if ("status" in record) {
    const next = unwrapSet(record.status);
    if (typeof next !== "string") throw attemptErr("status");
    const rows = await base.paymentProviderAttempt.findMany({ where: whereInput, select: { status: true } });
    for (const row of rows) {
      if (!(PAYMENT_ATTEMPT_TRANSITIONS[row.status] ?? []).includes(next)) {
        throw attemptErr(`Status ${row.status} -> ${next}`);
      }
    }
  }
}

/**
 * Bezahllink: ACTIVE -> DISABLED nur mit Zeit und Grund; DISABLED -> ACTIVE (Reaktivierung) nur nach
 * manueller Deaktivierung (oder Vollzahlung bei wieder offener Rechnung) und nur mit geleerten Feldern. Nach Storno (INVOICE_CANCELLED) ist der Link endgueltig aus.
 * Zeit und Grund werden nie ohne Statuswechsel geaendert.
 */
async function guardPayLinkUpdate(where: unknown, data: unknown): Promise<void> {
  assertOnlyKeys(data, INVOICE_PAY_LINK_MUTABLE_KEYS, payLinkErr);
  const record = (data ?? {}) as Record<string, unknown>;
  // Live-Kennzeichen wird nur gesetzt (false -> true), nie zurueckgenommen.
  if ("liveIssued" in record && unwrapSet(record.liveIssued) !== true) throw payLinkErr("liveIssued nur auf true");
  if (!("status" in record)) {
    if ("disabledAt" in record || "disabledReason" in record) throw payLinkErr("disabledAt/disabledReason nur mit status");
    return;
  }
  const next = unwrapSet(record.status);
  const at = unwrapSet(record.disabledAt);
  const reason = unwrapSet(record.disabledReason);
  const rows = await base.invoicePayLink.findMany({
    where: where as Prisma.InvoicePayLinkWhereInput,
    select: { status: true, disabledReason: true, invoiceId: true },
  });
  if (next === "DISABLED") {
    if (!(at instanceof Date) || typeof reason !== "string" || !PAY_LINK_DISABLE_REASONS.has(reason)) {
      throw payLinkErr("DISABLED nur mit disabledAt und disabledReason");
    }
    if (rows.some((r) => r.status !== "ACTIVE")) throw payLinkErr("DISABLED nur aus ACTIVE");
    return;
  }
  if (next === "ACTIVE") {
    if (at !== null || reason !== null) throw payLinkErr("ACTIVE nur mit disabledAt und disabledReason NULL");
    if (rows.some((r) => r.status === "DISABLED" && r.disabledReason !== "MANUAL" && r.disabledReason !== "INVOICE_PAID")) {
      throw payLinkErr("Reaktivierung nur nach manueller Deaktivierung oder Vollzahlung");
    }
    // Nach Vollzahlung nur, wenn die Rechnung durch Gegenbuchung wieder offen ist.
    const paidIds = rows.filter((r) => r.status === "DISABLED" && r.disabledReason === "INVOICE_PAID").map((r) => r.invoiceId);
    if (paidIds.length > 0) {
      const invs = await base.invoice.findMany({
        where: { id: { in: paidIds } },
        select: { status: true, grossTotalCents: true, payableCents: true, paidAmountCents: true },
      });
      const reopened = (i: (typeof invs)[number]): boolean =>
        i.status !== "PAID" && i.status !== "CANCELLED" && i.status !== "DRAFT" && (i.payableCents ?? i.grossTotalCents) - i.paidAmountCents > 0;
      if (invs.length !== paidIds.length || !invs.every(reopened)) throw payLinkErr("Reaktivierung nach Vollzahlung nur bei wieder offener Rechnung");
    }
    return;
  }
  throw payLinkErr("status");
}

/**
 * DATEV-Export: `DatevExport` und `DatevExportItem` sind Nachweise und append-only (nur `create`).
 * Die Einstellungen sind je Organisation genau eine Zeile und werden nie geloescht.
 */
export class DatevExportImmutableError extends Error {
  constructor() {
    super("DATEV-Exportprotokolle sind unveraenderlich (append-only).");
    this.name = "DatevExportImmutableError";
  }
}

/**
 * Debitorennummer (`Customer.datevAccount`): nach dem ersten Export unveraenderlich. Die einzige Schreibstelle ist
 * `setCustomerDatevAccount` (src/domain/export/datev/debtors.ts) ueber `dbInternal`; ueber den geschuetzten
 * Client darf das Feld nie geschrieben werden.
 */
export class DatevAccountWriteError extends Error {
  constructor() {
    super("Die DATEV-Debitorennummer wird nur ueber den Domain-Service gesetzt.");
    this.name = "DatevAccountWriteError";
  }
}

function writesDatevAccount(data: unknown): boolean {
  const rows = Array.isArray(data) ? data : [data];
  return rows.some((d) => typeof d === "object" && d !== null && "datevAccount" in d && (d as { datevAccount?: unknown }).datevAccount !== undefined);
}

export class DatevSettingsDeleteError extends Error {
  constructor() {
    super("DATEV-Einstellungen duerfen nicht geloescht werden.");
    this.name = "DatevSettingsDeleteError";
  }
}

/**
 * Bankabgleich: `BankStatementImport` und `BankMatch` sind Nachweise und append-only (nur `create`).
 * `BankTransaction` wird nie geloescht; nach dem Anlegen sind nur Status- und Zuordnungsfelder
 * fortschreibbar — Betrag, Fingerabdruck und Gegenkonto bleiben unveraenderlich.
 */
export class BankStatementImportImmutableError extends Error {
  constructor() {
    super("Kontoauszug-Importe sind unveraenderlich (append-only).");
    this.name = "BankStatementImportImmutableError";
  }
}

export class BankMatchImmutableError extends Error {
  constructor() {
    super("Bank-Zuordnungen sind unveraenderlich (append-only).");
    this.name = "BankMatchImmutableError";
  }
}

export class BankTransactionImmutableError extends Error {
  constructor(detail: string) {
    super(`Bankumsatz ist ein Nachweis und nicht aenderbar: ${detail}`);
    this.name = "BankTransactionImmutableError";
  }
}

const BANK_TRANSACTION_MUTABLE_KEYS = new Set([
  "status",
  "allocatedCents",
  "ignoredReason",
  "ignoredBy",
  "ignoredAt",
  "updatedAt",
]);

function assertBankTransactionUpdateAllowed(data: unknown): void {
  const keys = Object.keys((data ?? {}) as Record<string, unknown>);
  const badKeys = keys.filter((k) => !BANK_TRANSACTION_MUTABLE_KEYS.has(k));
  if (badKeys.length > 0) throw new BankTransactionImmutableError(badKeys.join(", "));
}

/**
 * Eingangsrechnung: Kopffelder, Hashes, Pfade und Annahmezeitpunkt sind nach dem Anlegen gesperrt;
 * aenderbar sind nur der Bearbeitungsstand (Status, Pruef-/Freigabe-/Ablehnungs-/Bezahlt-Merker),
 * die Lieferantenzuordnung, die interne Notiz, von Hand erfasste Kopfdaten und die wirksame
 * Faelligkeit. Loeschen ist nie erlaubt (Aufbewahrung).
 */
export class IncomingInvoiceImmutableError extends Error {
  constructor(detail: string) {
    super(`Eingangsrechnung ist ein Nachweis und nicht aenderbar: ${detail}`);
    this.name = "IncomingInvoiceImmutableError";
  }
}

export class IncomingInvoiceValidationImmutableError extends Error {
  constructor() {
    super("Pruefergebnis ist unveraenderlich.");
    this.name = "IncomingInvoiceValidationImmutableError";
  }
}

const INCOMING_INVOICE_MUTABLE_KEYS: ReadonlySet<string> = new Set([
  "status",
  "validationStatus",
  "updatedAt",
  "supplierContactId",
  "internalNote",
  "manualJson",
  "dueAt",
  "checkedAt",
  "checkedBy",
  "approvedAt",
  "approvedBy",
  "rejectedAt",
  "rejectedBy",
  "rejectReason",
  "paidMarkedAt",
  "paidNote",
]);

function assertIncomingInvoiceUpdateAllowed(data: unknown): void {
  assertOnlyKeys(data, INCOMING_INVOICE_MUTABLE_KEYS, (d) => new IncomingInvoiceImmutableError(d));
}

/**
 * Postfach-Abruf: Das Abrufprotokoll je Mail ist append-only (Doppelabruf-Schutz, Nachweis); einzig der Betreff
 * darf nach Ablauf der Aufbewahrungsfrist auf NULL gesetzt werden. Loeschen ist nie erlaubt.
 */
export class InboundMailMessageImmutableError extends Error {
  constructor(detail: string) {
    super(`Postfach-Protokoll ist unveraenderlich: ${detail}`);
    this.name = "InboundMailMessageImmutableError";
  }
}

/**
 * Anlage einer abgerufenen Mail: Dateiangaben (Name, Groesse, Hash, Zuordnung zur Mail) sind gesperrt;
 * aenderbar sind nur Entscheidung und Verknuepfungen. Der Pfad der Zwischenablage darf nur geleert werden.
 */
export class InboundMailAttachmentImmutableError extends Error {
  constructor(detail: string) {
    super(`Postfach-Anlage ist ein Nachweis und nicht aenderbar: ${detail}`);
    this.name = "InboundMailAttachmentImmutableError";
  }
}

const INBOUND_MAIL_MESSAGE_MUTABLE_KEYS: ReadonlySet<string> = new Set(["subject"]);

const INBOUND_MAIL_ATTACHMENT_MUTABLE_KEYS: ReadonlySet<string> = new Set([
  "status",
  "decidedAt",
  "decidedBy",
  "discardReason",
  "incomingInvoiceId",
  "duplicateOfIncomingId",
  "stagingPath",
  "purgedAt",
  "updatedAt",
]);

/** Wert eines Update-Feldes; Prisma erlaubt `{ set: x }` neben dem Direktwert. */
function updateFieldValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !(value instanceof Date) && "set" in value) {
    return (value as { set: unknown }).set;
  }
  return value;
}

function assertInboundMessageUpdateAllowed(data: unknown): void {
  assertOnlyKeys(data, INBOUND_MAIL_MESSAGE_MUTABLE_KEYS, (d) => new InboundMailMessageImmutableError(d));
  const record = (data ?? {}) as Record<string, unknown>;
  if ("subject" in record && updateFieldValue(record.subject) !== null) {
    throw new InboundMailMessageImmutableError("subject darf nur geleert werden");
  }
}

function assertInboundAttachmentUpdateAllowed(data: unknown): void {
  assertOnlyKeys(data, INBOUND_MAIL_ATTACHMENT_MUTABLE_KEYS, (d) => new InboundMailAttachmentImmutableError(d));
  const record = (data ?? {}) as Record<string, unknown>;
  if ("stagingPath" in record && updateFieldValue(record.stagingPath) !== null) {
    throw new InboundMailAttachmentImmutableError("stagingPath darf nur geleert werden");
  }
}

/**
 * Phase 17a: Das VIES-Pruefprotokoll (`VatIdCheck`) ist append-only; nur `create` ist erlaubt.
 */
export class VatIdCheckImmutableError extends Error {
  constructor() {
    super("Pruefprotokoll ist unveraenderlich.");
    this.name = "VatIdCheckImmutableError";
  }
}

/**
 * Phase 16g (R7): `printOptionsJson` von Angebot/AB/Proforma (`quote`) und Lieferschein ist ab
 * dem Verlassen des Entwurfs eingefroren (Druckoptionen + Layout-Version). Der Guard prueft nur
 * den Schluessel `printOptionsJson`; alle anderen Felder (z. B. archivedAt) bleiben unberuehrt.
 * Die Statuspruefung ist ein separates findFirst (nicht atomar); die Domain-Pfade (setPrintOptions)
 * schreiben deshalb per bedingtem updateMany (status DRAFT) und sind selbst atomar.
 * Das Einfrieren selbst laeuft ueber den Transaktions-Client von `dbInternal` (freeze-layout.ts).
 */
export class FrozenPrintOptionsError extends Error {
  constructor(ref: string) {
    super(`GoBD: Die Druckoptionen von "${ref}" sind nach dem Verlassen des Entwurfs eingefroren.`);
    this.name = "FrozenPrintOptionsError";
  }
}

function touchesPrintOptions(data: unknown): boolean {
  return typeof data === "object" && data !== null && "printOptionsJson" in data;
}

async function guardPrintOptions(model: "quote" | "deliveryNote", where: unknown, data: unknown): Promise<void> {
  if (!touchesPrintOptions(data)) return;
  const filter = { AND: [(where ?? {}) as never, { status: { not: "DRAFT" } }] } as never;
  const row =
    model === "quote"
      ? await base.quote.findFirst({ where: filter, select: { id: true, number: true } })
      : await base.deliveryNote.findFirst({ where: filter, select: { id: true, number: true } });
  if (row) throw new FrozenPrintOptionsError(row.number ?? row.id);
}

/**
 * Angebote/Auftragsbestaetigungen/Proforma und Lieferscheine sind nach Ausgabe (Status ungleich
 * DRAFT) abgesandte Handelsbriefe (§ 257 Abs. 1 Nr. 3 HGB) und inhaltlich unveraenderlich. Ueber den
 * geschuetzten Client sind dann Positionen komplett gesperrt; am Kopf bleiben nur Status,
 * Statuszeitpunkte, Entscheidungsnotiz, Verknuepfung zur Folgerechnung und Archivmarker aenderbar.
 * Die Domain-Services schreiben ueber `dbInternal` bzw. dessen Transaktions-Client.
 */
export class HandelsbriefImmutabilityError extends GobdImmutabilityError {
  constructor(ref: string) {
    super(ref);
    this.message =
      `GoBD: Der ausgegebene Beleg "${ref}" ist ein abgesandter Handelsbrief und inhaltlich unveränderbar (§ 257 HGB).`;
    this.name = "HandelsbriefImmutabilityError";
  }
}

const QUOTE_MUTABLE_AFTER_ISSUE: ReadonlySet<string> = new Set([
  "status",
  "sentAt",
  "decidedAt",
  "decisionNote",
  "convertedToInvoiceId",
  "archivedAt",
  "updatedAt",
]);
const DELIVERY_NOTE_MUTABLE_AFTER_ISSUE: ReadonlySet<string> = new Set([
  "status",
  "sentAt",
  "deliveredAt",
  "archivedAt",
  "updatedAt",
]);

type HandelsbriefModel = "quote" | "deliveryNote";

function touchesOnlyKeys(data: unknown, allowed: ReadonlySet<string>): boolean {
  if (typeof data !== "object" || data === null) return false;
  return Object.keys(data).every((k) => allowed.has(k));
}

async function findIssuedHead(model: HandelsbriefModel, where: unknown): Promise<string | null> {
  const filter = { AND: [(where ?? {}) as never, { status: { not: "DRAFT" } }] } as never;
  const select = { id: true, number: true } as const;
  const row =
    model === "quote"
      ? await base.quote.findFirst({ where: filter, select })
      : await base.deliveryNote.findFirst({ where: filter, select });
  return row ? (row.number ?? row.id) : null;
}

/**
 * Statuswert eines Kopf-Updates: muss ein bekannter Status sein und fuer jeden getroffenen
 * ausgegebenen Beleg ein erlaubter VORWAERTS-Uebergang (Tabellen der Domain-Statusmaschinen) bzw.
 * unveraendert. Insbesondere kein Zurueck auf DRAFT, das die Sperre aufheben wuerde.
 */
async function guardStatusWrite(model: HandelsbriefModel, where: unknown, rawStatus: unknown): Promise<void> {
  const target = unwrapSet(rawStatus);
  const table: Readonly<Record<string, readonly string[]>> = model === "quote" ? QUOTE_TRANSITIONS : DELIVERY_TRANSITIONS;
  const filter = (where ?? {}) as never;
  const select = { id: true, number: true, status: true } as const;
  const rows =
    model === "quote"
      ? await base.quote.findMany({ where: filter, select })
      : await base.deliveryNote.findMany({ where: filter, select });
  if (typeof target !== "string" || !(target in table)) {
    throw new HandelsbriefImmutabilityError(rows[0] ? (rows[0].number ?? rows[0].id) : "unbekannter Status");
  }
  for (const row of rows) {
    if (row.status === "DRAFT" && target === "DRAFT") continue;
    if (row.status === target) continue;
    if (!(table[row.status] ?? []).includes(target)) {
      throw new HandelsbriefImmutabilityError(row.number ?? row.id);
    }
  }
}

/** Nested `lines.connect/set/connectOrCreate` am Kopf: Quellpositionen duerfen keinem ausgegebenen Beleg gehoeren. */
async function guardHeadLinesConnect(model: HandelsbriefModel, data: unknown): Promise<void> {
  const ids = connectedLineIds(data);
  if (ids.length === 0) return;
  if (ids.some((i) => i === "")) throw new HandelsbriefImmutabilityError("Positionen ohne bestimmbare ID");
  const where = { AND: [{ id: { in: ids } }, { [model]: { status: { not: "DRAFT" } } }] } as never;
  const row =
    model === "quote"
      ? await base.quoteLine.findFirst({ where, select: { quote: { select: { id: true, number: true } } } })
      : await base.deliveryNoteLine.findFirst({ where, select: { deliveryNote: { select: { id: true, number: true } } } });
  if (!row) return;
  const head = "quote" in row ? row.quote : row.deliveryNote;
  throw new HandelsbriefImmutabilityError(head.number ?? head.id);
}

/**
 * Kopf: bei ausgegebenen Belegen nur Positivliste an Feldern; `data` null = Loeschen. Ein `status` im
 * Payload wird immer auf einen zulaessigen Vorwaertswechsel geprueft. Die Pruefungen lesen ueber `base`
 * und sind nicht atomar mit dem Schreiben — der Guard ist Zweitverteidigung, die Domain-Services
 * sperren die Zeile (lockRow) und pruefen den Status selbst.
 */
async function guardHeadWrite(model: HandelsbriefModel, where: unknown, data: unknown | null): Promise<void> {
  const allowed = model === "quote" ? QUOTE_MUTABLE_AFTER_ISSUE : DELIVERY_NOTE_MUTABLE_AFTER_ISSUE;
  if (data !== null) {
    await guardHeadLinesConnect(model, data);
    if (typeof data === "object" && "status" in data) await guardStatusWrite(model, where, (data as { status: unknown }).status);
    if (touchesOnlyKeys(data, allowed)) return;
  }
  const ref = await findIssuedHead(model, where);
  if (ref) throw new HandelsbriefImmutabilityError(ref);
}

async function guardLineWrite(model: HandelsbriefModel, where: unknown): Promise<void> {
  const filter = { AND: [(where ?? {}) as never, { [model]: { status: { not: "DRAFT" } } }] } as never;
  const row =
    model === "quote"
      ? await base.quoteLine.findFirst({ where: filter, select: { quote: { select: { id: true, number: true } } } })
      : await base.deliveryNoteLine.findFirst({ where: filter, select: { deliveryNote: { select: { id: true, number: true } } } });
  if (!row) return;
  const head = "quote" in row ? row.quote : row.deliveryNote;
  throw new HandelsbriefImmutabilityError(head.number ?? head.id);
}

async function guardLineCreateFor(model: HandelsbriefModel, data: unknown): Promise<void> {
  const idKey = model === "quote" ? "quoteId" : "deliveryNoteId";
  const items = Array.isArray(data) ? data : [data];
  const ids = new Set<string>();
  for (const item of items) {
    const d = (item ?? {}) as Record<string, unknown>;
    const connected = (d[model] as { connect?: { id?: unknown } } | undefined)?.connect?.id;
    const scalar = unwrapSet(d[idKey]);
    const id = typeof scalar === "string" ? scalar : connected;
    if (typeof id !== "string") throw new HandelsbriefImmutabilityError("Position ohne bestimmbaren Zielbeleg");
    ids.add(id);
  }
  if (ids.size === 0) return;
  const where = { id: { in: [...ids] } };
  const ref = await findIssuedHead(model, where);
  if (ref) throw new HandelsbriefImmutabilityError(ref);
}

/** Umhaengen einer Position (Zielbeleg im Update-Payload): auch der Zielbeleg muss ein Entwurf sein. */
async function guardLineMoveFor(model: HandelsbriefModel, data: unknown): Promise<void> {
  const d = (data ?? {}) as Record<string, unknown>;
  if (!((model === "quote" ? "quoteId" : "deliveryNoteId") in d) && !(model in d)) return;
  await guardLineCreateFor(model, d);
}

export class LayoutDesignDeleteError extends Error {
  constructor() {
    super("Layout-Designs werden nie geloescht (eingefrorene Belege verweisen auf Versionen), nur archiviert.");
    this.name = "LayoutDesignDeleteError";
  }
}

/**
 * Phase 16a: `ArchivedDocument` ist write-once (GoBD-Belegarchiv). Zeilen entstehen
 * ausschliesslich in `src/domain/invoice/archive.ts` per `create` auf dem Transaktions-
 * Client; ueber den geschuetzten `prisma`-Client sind update/upsert/delete IMMER verboten.
 */
class ArchivedDocumentImmutabilityError extends Error {
  constructor() {
    super("GoBD: Archivierte Belege (ArchivedDocument) sind write-once und koennen nicht geaendert oder geloescht werden.");
    this.name = "ArchivedDocumentImmutabilityError";
  }
}

class PaymentImmutabilityError extends Error {
  constructor() {
    super("GoBD: Zahlungen werden nie geaendert oder geloescht — Korrektur nur per Gegenbuchung (reversePayment).");
    this.name = "PaymentImmutabilityError";
  }
}

export const prisma = base.$extends({
  query: {
    invoice: {
      async create({ args, query }) {
        await guardInvoiceLinesConnect(args.data);
        return query(args);
      },
      async update({ args, query }) {
        await guardInvoiceWhere(args.where);
        await guardInvoiceLinesConnect(args.data);
        return query(args);
      },
      async delete({ args, query }) {
        await guardInvoiceWhere(args.where);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardInvoiceWhere(args.where);
        return query(args);
      },
      async deleteMany({ args, query }) {
        await guardInvoiceWhere(args.where);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardInvoiceWhere(args.where);
        await guardInvoiceLinesConnect(args.update);
        await guardInvoiceLinesConnect(args.create);
        return query(args);
      },
    },
    invoiceLine: {
      async create({ args, query }) {
        await guardLineCreate(args.data);
        return query(args);
      },
      async createMany({ args, query }) {
        await guardLineCreate(args.data);
        return query(args);
      },
      async createManyAndReturn({ args, query }) {
        await guardLineCreate(args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardLineWhere(args.where);
        await guardInvoiceLineMove(args.update);
        await guardLineCreate(args.create);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardLineWhere(args.where);
        await guardInvoiceLineMove(args.data);
        return query(args);
      },
      async update({ args, query }) {
        await guardLineWhere(args.where);
        await guardInvoiceLineMove(args.data);
        return query(args);
      },
      async delete({ args, query }) {
        await guardLineWhere(args.where);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardLineWhere(args.where);
        await guardInvoiceLineMove(args.data);
        return query(args);
      },
      async deleteMany({ args, query }) {
        await guardLineWhere(args.where);
        return query(args);
      },
    },
    finalInvoiceDeduction: {
      async update() {
        throw new FinalInvoiceDeductionImmutabilityError();
      },
      async delete() {
        throw new FinalInvoiceDeductionImmutabilityError();
      },
      async updateMany() {
        throw new FinalInvoiceDeductionImmutabilityError();
      },
      async deleteMany() {
        throw new FinalInvoiceDeductionImmutabilityError();
      },
    },
    archivedDocument: {
      async update() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async updateMany() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async updateManyAndReturn() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async upsert() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async delete() {
        throw new ArchivedDocumentImmutabilityError();
      },
      async deleteMany() {
        throw new ArchivedDocumentImmutabilityError();
      },
    },
    recurringUsage: {
      async update() {
        throw new RecurringUsageImmutabilityError();
      },
      async updateMany() {
        throw new RecurringUsageImmutabilityError();
      },
      async updateManyAndReturn() {
        throw new RecurringUsageImmutabilityError();
      },
      async upsert() {
        throw new RecurringUsageImmutabilityError();
      },
      async delete() {
        throw new RecurringUsageImmutabilityError();
      },
      async deleteMany() {
        throw new RecurringUsageImmutabilityError();
      },
    },
    vatIdCheck: {
      async update() {
        throw new VatIdCheckImmutableError();
      },
      async updateMany() {
        throw new VatIdCheckImmutableError();
      },
      async updateManyAndReturn() {
        throw new VatIdCheckImmutableError();
      },
      async upsert() {
        throw new VatIdCheckImmutableError();
      },
      async delete() {
        throw new VatIdCheckImmutableError();
      },
      async deleteMany() {
        throw new VatIdCheckImmutableError();
      },
    },
    customerPortalEvent: {
      async update() {
        throw new CustomerPortalEventImmutableError();
      },
      async updateMany() {
        throw new CustomerPortalEventImmutableError();
      },
      async updateManyAndReturn() {
        throw new CustomerPortalEventImmutableError();
      },
      async upsert() {
        throw new CustomerPortalEventImmutableError();
      },
      async delete() {
        throw new CustomerPortalEventImmutableError();
      },
      async deleteMany() {
        throw new CustomerPortalEventImmutableError();
      },
    },
    datevExport: {
      async update() {
        throw new DatevExportImmutableError();
      },
      async updateMany() {
        throw new DatevExportImmutableError();
      },
      async updateManyAndReturn() {
        throw new DatevExportImmutableError();
      },
      async upsert() {
        throw new DatevExportImmutableError();
      },
      async delete() {
        throw new DatevExportImmutableError();
      },
      async deleteMany() {
        throw new DatevExportImmutableError();
      },
    },
    datevExportItem: {
      async update() {
        throw new DatevExportImmutableError();
      },
      async updateMany() {
        throw new DatevExportImmutableError();
      },
      async updateManyAndReturn() {
        throw new DatevExportImmutableError();
      },
      async upsert() {
        throw new DatevExportImmutableError();
      },
      async delete() {
        throw new DatevExportImmutableError();
      },
      async deleteMany() {
        throw new DatevExportImmutableError();
      },
    },
    customer: {
      async create({ args, query }) {
        if (writesDatevAccount(args.data)) throw new DatevAccountWriteError();
        return query(args);
      },
      async createMany({ args, query }) {
        if (writesDatevAccount(args.data)) throw new DatevAccountWriteError();
        return query(args);
      },
      async update({ args, query }) {
        if (writesDatevAccount(args.data)) throw new DatevAccountWriteError();
        return query(args);
      },
      async updateMany({ args, query }) {
        if (writesDatevAccount(args.data)) throw new DatevAccountWriteError();
        return query(args);
      },
      async upsert({ args, query }) {
        if (writesDatevAccount(args.create) || writesDatevAccount(args.update)) throw new DatevAccountWriteError();
        return query(args);
      },
    },
    datevSettings: {
      async delete() {
        throw new DatevSettingsDeleteError();
      },
      async deleteMany() {
        throw new DatevSettingsDeleteError();
      },
    },
    bankStatementImport: {
      async update() {
        throw new BankStatementImportImmutableError();
      },
      async updateMany() {
        throw new BankStatementImportImmutableError();
      },
      async updateManyAndReturn() {
        throw new BankStatementImportImmutableError();
      },
      async upsert() {
        throw new BankStatementImportImmutableError();
      },
      async delete() {
        throw new BankStatementImportImmutableError();
      },
      async deleteMany() {
        throw new BankStatementImportImmutableError();
      },
    },
    bankMatch: {
      async update() {
        throw new BankMatchImmutableError();
      },
      async updateMany() {
        throw new BankMatchImmutableError();
      },
      async updateManyAndReturn() {
        throw new BankMatchImmutableError();
      },
      async upsert() {
        throw new BankMatchImmutableError();
      },
      async delete() {
        throw new BankMatchImmutableError();
      },
      async deleteMany() {
        throw new BankMatchImmutableError();
      },
    },
    bankTransaction: {
      async update({ args, query }) {
        assertBankTransactionUpdateAllowed(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        assertBankTransactionUpdateAllowed(args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        assertBankTransactionUpdateAllowed(args.data);
        return query(args);
      },
      async upsert() {
        throw new BankTransactionImmutableError("upsert");
      },
      async delete() {
        throw new BankTransactionImmutableError("delete");
      },
      async deleteMany() {
        throw new BankTransactionImmutableError("deleteMany");
      },
    },
    incomingInvoice: {
      async update({ args, query }) {
        assertIncomingInvoiceUpdateAllowed(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        assertIncomingInvoiceUpdateAllowed(args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        assertIncomingInvoiceUpdateAllowed(args.data);
        return query(args);
      },
      async upsert() {
        throw new IncomingInvoiceImmutableError("upsert");
      },
      async delete() {
        throw new IncomingInvoiceImmutableError("delete");
      },
      async deleteMany() {
        throw new IncomingInvoiceImmutableError("deleteMany");
      },
    },
    incomingInvoiceValidation: {
      async update() {
        throw new IncomingInvoiceValidationImmutableError();
      },
      async updateMany() {
        throw new IncomingInvoiceValidationImmutableError();
      },
      async updateManyAndReturn() {
        throw new IncomingInvoiceValidationImmutableError();
      },
      async upsert() {
        throw new IncomingInvoiceValidationImmutableError();
      },
      async delete() {
        throw new IncomingInvoiceValidationImmutableError();
      },
      async deleteMany() {
        throw new IncomingInvoiceValidationImmutableError();
      },
    },
    inboundMailMessage: {
      async update({ args, query }) {
        assertInboundMessageUpdateAllowed(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        assertInboundMessageUpdateAllowed(args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        assertInboundMessageUpdateAllowed(args.data);
        return query(args);
      },
      async upsert() {
        throw new InboundMailMessageImmutableError("upsert");
      },
      async delete() {
        throw new InboundMailMessageImmutableError("delete");
      },
      async deleteMany() {
        throw new InboundMailMessageImmutableError("deleteMany");
      },
    },
    inboundMailAttachment: {
      async update({ args, query }) {
        assertInboundAttachmentUpdateAllowed(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        assertInboundAttachmentUpdateAllowed(args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        assertInboundAttachmentUpdateAllowed(args.data);
        return query(args);
      },
      async upsert() {
        throw new InboundMailAttachmentImmutableError("upsert");
      },
      async delete() {
        throw new InboundMailAttachmentImmutableError("delete");
      },
      async deleteMany() {
        throw new InboundMailAttachmentImmutableError("deleteMany");
      },
    },
    postalJobEvent: {
      async update() {
        throw new PostalJobEventImmutableError();
      },
      async updateMany() {
        throw new PostalJobEventImmutableError();
      },
      async updateManyAndReturn() {
        throw new PostalJobEventImmutableError();
      },
      async upsert() {
        throw new PostalJobEventImmutableError();
      },
      async delete() {
        throw new PostalJobEventImmutableError();
      },
      async deleteMany() {
        throw new PostalJobEventImmutableError();
      },
    },
    postalJob: {
      async update({ args, query }) {
        assertPostalJobUpdateAllowed(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        assertPostalJobUpdateAllowed(args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        assertPostalJobUpdateAllowed(args.data);
        return query(args);
      },
      async upsert() {
        throw new PostalJobImmutableError("upsert");
      },
      async delete() {
        throw new PostalJobImmutableError("delete");
      },
      async deleteMany() {
        throw new PostalJobImmutableError("deleteMany");
      },
    },
    layoutDesignVersion: {
      async update() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async updateMany() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async updateManyAndReturn() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async upsert() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async delete() {
        throw new LayoutDesignVersionImmutabilityError();
      },
      async deleteMany() {
        throw new LayoutDesignVersionImmutabilityError();
      },
    },
    quote: {
      async create({ args, query }) {
        await guardHeadLinesConnect("quote", args.data);
        return query(args);
      },
      async update({ args, query }) {
        await guardPrintOptions("quote", args.where, args.data);
        await guardHeadWrite("quote", args.where, args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardPrintOptions("quote", args.where, args.data);
        await guardHeadWrite("quote", args.where, args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardPrintOptions("quote", args.where, args.data);
        await guardHeadWrite("quote", args.where, args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardPrintOptions("quote", args.where, args.update);
        await guardHeadWrite("quote", args.where, args.update);
        await guardHeadLinesConnect("quote", args.create);
        return query(args);
      },
      async delete({ args, query }) {
        await guardHeadWrite("quote", args.where, null);
        return query(args);
      },
      async deleteMany({ args, query }) {
        await guardHeadWrite("quote", args.where, null);
        return query(args);
      },
    },
    quoteLine: {
      async create({ args, query }) {
        await guardLineCreateFor("quote", args.data);
        return query(args);
      },
      async createMany({ args, query }) {
        await guardLineCreateFor("quote", args.data);
        return query(args);
      },
      async createManyAndReturn({ args, query }) {
        await guardLineCreateFor("quote", args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardLineWrite("quote", args.where);
        await guardLineMoveFor("quote", args.update);
        await guardLineCreateFor("quote", args.create);
        return query(args);
      },
      async update({ args, query }) {
        await guardLineWrite("quote", args.where);
        await guardLineMoveFor("quote", args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardLineWrite("quote", args.where);
        await guardLineMoveFor("quote", args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardLineWrite("quote", args.where);
        await guardLineMoveFor("quote", args.data);
        return query(args);
      },
      async delete({ args, query }) {
        await guardLineWrite("quote", args.where);
        return query(args);
      },
      async deleteMany({ args, query }) {
        await guardLineWrite("quote", args.where);
        return query(args);
      },
    },
    deliveryNote: {
      async create({ args, query }) {
        await guardHeadLinesConnect("deliveryNote", args.data);
        return query(args);
      },
      async update({ args, query }) {
        await guardPrintOptions("deliveryNote", args.where, args.data);
        await guardHeadWrite("deliveryNote", args.where, args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardPrintOptions("deliveryNote", args.where, args.data);
        await guardHeadWrite("deliveryNote", args.where, args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardPrintOptions("deliveryNote", args.where, args.data);
        await guardHeadWrite("deliveryNote", args.where, args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardPrintOptions("deliveryNote", args.where, args.update);
        await guardHeadWrite("deliveryNote", args.where, args.update);
        await guardHeadLinesConnect("deliveryNote", args.create);
        return query(args);
      },
      async delete({ args, query }) {
        await guardHeadWrite("deliveryNote", args.where, null);
        return query(args);
      },
      async deleteMany({ args, query }) {
        await guardHeadWrite("deliveryNote", args.where, null);
        return query(args);
      },
    },
    deliveryNoteLine: {
      async create({ args, query }) {
        await guardLineCreateFor("deliveryNote", args.data);
        return query(args);
      },
      async createMany({ args, query }) {
        await guardLineCreateFor("deliveryNote", args.data);
        return query(args);
      },
      async createManyAndReturn({ args, query }) {
        await guardLineCreateFor("deliveryNote", args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardLineWrite("deliveryNote", args.where);
        await guardLineMoveFor("deliveryNote", args.update);
        await guardLineCreateFor("deliveryNote", args.create);
        return query(args);
      },
      async update({ args, query }) {
        await guardLineWrite("deliveryNote", args.where);
        await guardLineMoveFor("deliveryNote", args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardLineWrite("deliveryNote", args.where);
        await guardLineMoveFor("deliveryNote", args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardLineWrite("deliveryNote", args.where);
        await guardLineMoveFor("deliveryNote", args.data);
        return query(args);
      },
      async delete({ args, query }) {
        await guardLineWrite("deliveryNote", args.where);
        return query(args);
      },
      async deleteMany({ args, query }) {
        await guardLineWrite("deliveryNote", args.where);
        return query(args);
      },
    },
    layoutDesign: {
      async delete() {
        throw new LayoutDesignDeleteError();
      },
      async deleteMany() {
        throw new LayoutDesignDeleteError();
      },
    },
    payment: {
      async update() {
        throw new PaymentImmutabilityError();
      },
      async updateMany() {
        throw new PaymentImmutabilityError();
      },
      async updateManyAndReturn() {
        throw new PaymentImmutabilityError();
      },
      async upsert() {
        throw new PaymentImmutabilityError();
      },
      async delete() {
        throw new PaymentImmutabilityError();
      },
      async deleteMany() {
        throw new PaymentImmutabilityError();
      },
    },
    paymentProviderEvent: {
      async update() {
        throw new PaymentProviderEventImmutableError();
      },
      async updateMany() {
        throw new PaymentProviderEventImmutableError();
      },
      async updateManyAndReturn() {
        throw new PaymentProviderEventImmutableError();
      },
      async upsert() {
        throw new PaymentProviderEventImmutableError();
      },
      async delete() {
        throw new PaymentProviderEventImmutableError();
      },
      async deleteMany() {
        throw new PaymentProviderEventImmutableError();
      },
    },
    paymentProviderAttempt: {
      async update({ args, query }) {
        await guardPaymentAttemptUpdate(args.where, args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardPaymentAttemptUpdate(args.where, args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardPaymentAttemptUpdate(args.where, args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardPaymentAttemptUpdate(args.where, args.update);
        return query(args);
      },
      async delete() {
        throw new PaymentProviderAttemptImmutableError("delete");
      },
      async deleteMany() {
        throw new PaymentProviderAttemptImmutableError("deleteMany");
      },
    },
    invoicePayLink: {
      async update({ args, query }) {
        await guardPayLinkUpdate(args.where, args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardPayLinkUpdate(args.where, args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardPayLinkUpdate(args.where, args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardPayLinkUpdate(args.where, args.update);
        return query(args);
      },
      async delete() {
        throw new InvoicePayLinkImmutableError("delete");
      },
      async deleteMany() {
        throw new InvoicePayLinkImmutableError("deleteMany");
      },
    },
    paymentRuleRun: {
      async update({ args, query }) {
        await guardPaymentRuleRunUpdate(args.where, args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        await guardPaymentRuleRunUpdate(args.where, args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        await guardPaymentRuleRunUpdate(args.where, args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        await guardPaymentRuleRunUpdate(args.where, args.update);
        return query(args);
      },
      async delete() {
        throw new PaymentRuleRunImmutabilityError("delete");
      },
      async deleteMany() {
        throw new PaymentRuleRunImmutabilityError("deleteMany");
      },
    },
    dunning: {
      async update({ args, query }) {
        assertDunningUpdateAllowed(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        assertDunningUpdateAllowed(args.data);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        assertDunningUpdateAllowed(args.data);
        return query(args);
      },
      // upsert: Anlage frei, der Update-Zweig unterliegt denselben Regeln wie update.
      async upsert({ args, query }) {
        assertDunningUpdateAllowed(args.update);
        return query(args);
      },
      async delete() {
        throw new DunningImmutabilityError(["delete"]);
      },
      async deleteMany() {
        throw new DunningImmutabilityError(["deleteMany"]);
      },
    },
  },
});
