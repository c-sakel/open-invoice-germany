/**
 * Sammelrechnung fuer Abos (rein, ohne Datenbankzugriff): Gruppierung faelliger Abos eines
 * Kunden, Positionsbloecke mit Ueberschrift/Zwischensumme, Gesamtzeitraum und Kopftext.
 * Berechnung und Pruefung der Betraege uebernimmt weiterhin der gemeinsame Rechnungspfad.
 */
import { berlinDateKey } from "@/lib/berlin-time";
import { docStrings, formatDocDate, type DocLanguage } from "@/lib/i18n/doc";
import type { CreateInvoiceInput } from "@/schemas";

export const COLLECTIVE_MAX_MEMBERS = 50;

export type CollectiveKeyField =
  | "currency"
  | "taxScheme"
  | "language"
  | "paymentTermsDays"
  | "autoFinalize"
  | "autoSend"
  | "emailTemplateId"
  | "billingTiming";

export interface CollectiveCandidate {
  id: string;
  orgId: string;
  customerId: string;
  status: string;
  collectiveBilling: boolean;
  nextRunDate: Date;
  createdAt: Date;
  currency: string;
  taxScheme: string;
  language: string;
  paymentTermsDays: number;
  autoFinalize: boolean;
  autoSend: boolean;
  emailTemplateId: string | null;
  billingTiming: string;
}

const KEY_FIELDS: readonly CollectiveKeyField[] = [
  "currency",
  "taxScheme",
  "language",
  "paymentTermsDays",
  "autoFinalize",
  "autoSend",
  "emailTemplateId",
  "billingTiming",
];

/** Klartext je abweichendem Schluesselfeld (fuer die Anzeige, warum ein Abo nicht mit in die Sammelrechnung kommt). */
export const COLLECTIVE_REASON_LABEL: Record<CollectiveKeyField, string> = {
  currency: "Währung weicht ab",
  taxScheme: "Steuerschema weicht ab",
  language: "Sprache weicht ab",
  paymentTermsDays: "Zahlungsziel weicht ab",
  autoFinalize: "Festschreiben weicht ab",
  autoSend: "Versand weicht ab",
  emailTemplateId: "Mailvorlage weicht ab",
  billingTiming: "Abrechnungsart weicht ab",
};

/** Berliner Kalendertag des Stichtags. */
export function stichtagKey(nextRunDate: Date): string {
  return berlinDateKey(nextRunDate);
}

/** Abweichende Schluesselfelder (leer = gleiche Gruppe). Kunde und Stichtag sind Vorbedingung, kein Grund. */
export function splitReasons(a: CollectiveCandidate, b: CollectiveCandidate): CollectiveKeyField[] {
  // Die Mailvorlage wirkt nur beim automatischen Versand; sonst trennt sie nicht.
  return KEY_FIELDS.filter((f) => (f === "emailTemplateId" && !a.autoSend ? false : a[f] !== b[f]));
}

function byCreatedThenId(a: CollectiveCandidate, b: CollectiveCandidate): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Mitglieder der Gruppe (inkl. Ausloeser, sortiert nach createdAt, id, hoechstens `maxMembers`,
 * Ausloeser immer enthalten) sowie abweichende Abos desselben Kunden und Stichtags mit Gruenden.
 * `overflow`: gleichartige Abos jenseits der Obergrenze (bleiben faellig und bilden die Folgegruppe).
 * Beruecksichtigt werden nur ACTIVE-Abos mit Sammelschalter.
 */
export function selectCollectiveGroup(
  trigger: CollectiveCandidate,
  candidates: readonly CollectiveCandidate[],
  maxMembers: number = COLLECTIVE_MAX_MEMBERS,
): { members: string[]; split: { id: string; reasons: CollectiveKeyField[] }[]; overflow: string[] } {
  const day = stichtagKey(trigger.nextRunDate);
  const seen = new Set<string>([trigger.id]);
  const same: CollectiveCandidate[] = [];
  const split: { id: string; reasons: CollectiveKeyField[] }[] = [];
  for (const c of [...candidates].sort(byCreatedThenId)) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.orgId !== trigger.orgId) throw new Error("Sammelrechnung: Abo einer anderen Organisation.");
    if (c.status !== "ACTIVE" || !c.collectiveBilling) continue;
    if (c.customerId !== trigger.customerId || stichtagKey(c.nextRunDate) !== day) continue;
    const reasons = splitReasons(trigger, c);
    if (reasons.length === 0) same.push(c);
    else split.push({ id: c.id, reasons });
  }
  const limit = Math.max(1, maxMembers);
  const members = [trigger, ...same.slice(0, limit - 1)].sort(byCreatedThenId).map((c) => c.id);
  const overflow = same.slice(limit - 1).map((c) => c.id);
  return { members, split, overflow };
}

export interface CollectiveBlock {
  recurringId: string;
  heading: string;
  showPeriodText: boolean;
  periodStart: Date;
  periodEnd: Date;
  lines: CreateInvoiceInput["lines"];
}

type CollectiveLine = CreateInvoiceInput["lines"][number];

function outlineLine(lineType: "HEADING" | "SUBTOTAL", description: string): CollectiveLine {
  return {
    lineType,
    description,
    quantityMilli: 0,
    unit: "C62",
    unitNetPriceCents: 0,
    taxRate: 0,
    taxCategory: "S",
    discountPermille: 0,
    discountCents: 0,
  };
}

/**
 * Je Block eine HEADING-Zeile, die Zeilen des Abos und (nur ohne eigene HEADING/SUBTOTAL-Zeile)
 * eine SUBTOTAL-Zeile. `origins` ist parallel zu `lines` und nennt das Abo je Zeile.
 */
export function assembleCollectiveLines(
  blocks: readonly CollectiveBlock[],
  lang: DocLanguage,
): { lines: CreateInvoiceInput["lines"]; origins: string[] } {
  const subtotalLabel = lang === "en" ? "Subtotal" : "Zwischensumme";
  const lines: CreateInvoiceInput["lines"] = [];
  const origins: string[] = [];
  const push = (line: CollectiveLine, origin: string): void => {
    lines.push(line);
    origins.push(origin);
  };
  for (const block of blocks) {
    push(outlineLine("HEADING", block.heading), block.recurringId);
    for (const l of block.lines) push(l, block.recurringId);
    const ownOutline = block.lines.some((l) => l.lineType === "HEADING" || l.lineType === "SUBTOTAL");
    if (!ownOutline) push(outlineLine("SUBTOTAL", subtotalLabel), block.recurringId);
  }
  return { lines, origins };
}

/** Kleinster Start und groesstes Ende ueber die Leistungszeitraeume der ITEM-Zeilen; null ohne Zeitraeume. */
export function collectivePeriod(lines: CreateInvoiceInput["lines"]): { start: Date; end: Date } | null {
  let start: Date | null = null;
  let end: Date | null = null;
  for (const l of lines) {
    if (l.lineType !== "ITEM" || !l.servicePeriodStart || !l.servicePeriodEnd) continue;
    if (!start || l.servicePeriodStart < start) start = l.servicePeriodStart;
    if (!end || l.servicePeriodEnd > end) end = l.servicePeriodEnd;
  }
  return start && end ? { start, end } : null;
}

/** Kopftext "Leistungszeitraum dd.mm.yyyy – dd.mm.yyyy" (Belegsprache) nur, wenn alle Bloecke den Zeitraumtext wollen. */
export function collectiveHeaderText(blocks: readonly CollectiveBlock[], lang: DocLanguage): string | undefined {
  if (blocks.length === 0 || !blocks.every((b) => b.showPeriodText)) return undefined;
  const start = blocks.reduce((m, b) => (b.periodStart < m ? b.periodStart : m), blocks[0].periodStart);
  const end = blocks.reduce((m, b) => (b.periodEnd > m ? b.periodEnd : m), blocks[0].periodEnd);
  return docStrings(lang).recurring.periodHeader(formatDocDate(start, lang), formatDocDate(end, lang));
}

/** Zusammenhaengende Positionsbereiche je Abo-Herkunft (fuer die Belegansicht). */
export function collectiveBlockRanges(
  lines: readonly { position: number; recurringInvoiceId: string | null }[],
): { recurringId: string; from: number; to: number }[] {
  const out: { recurringId: string; from: number; to: number }[] = [];
  for (const l of lines) {
    if (!l.recurringInvoiceId) continue;
    const last = out[out.length - 1];
    if (last && last.recurringId === l.recurringInvoiceId) last.to = l.position;
    else out.push({ recurringId: l.recurringInvoiceId, from: l.position, to: l.position });
  }
  return out;
}
