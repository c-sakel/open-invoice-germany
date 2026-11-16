/**
 * Pruefung angenommener Eingangsrechnungen gegen EN 16931 und XRechnung. Die Annahme wartet nie auf
 * die Pruefung: sie reiht die Rechnung nur ein (`queueIncomingValidation`), der Archiv-Nachlauf holt
 * liegengebliebene Pruefungen nach (`runIncomingValidationBacklog`). Es laeuft hoechstens eine
 * Pruefung gleichzeitig. Jede Pruefung legt eine neue, unveraenderliche Ergebniszeile an.
 */
import { dbInternal } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { NotFoundError } from "@/domain/errors";
import { getIncomingFile } from "./files";
import { selectEngine, type EngineOutcome, type NotCheckedReason, type ValidationEngine } from "./engine";
import { INCOMING_VALIDATE_PER_MINUTE, VALIDATE_TIMEOUT_MS } from "./limits";

export type IncomingValidationResult = "VALID" | "WARNINGS" | "INVALID" | "NOT_CHECKED" | "NOT_APPLICABLE";

export interface ValidateOptions {
  now?: Date;
  engine?: ValidationEngine;
  timeoutMs?: number;
}

/** Eine Pruefung nach der anderen (der Kindprozess braucht 340-590 MB Arbeitsspeicher). */
let tail: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.catch(() => undefined);
  return next;
}

const NOT_FOUND = "Eingangsrechnung nicht gefunden.";

function decode(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function reasonOf(o: EngineOutcome): NotCheckedReason | null {
  return "notChecked" in o ? o.notChecked : null;
}

function hasHint(hintsJson: string, code: string): boolean {
  try {
    const v: unknown = JSON.parse(hintsJson);
    return Array.isArray(v) && v.includes(code);
  } catch {
    return false;
  }
}

/**
 * Prueft eine Eingangsrechnung und speichert das Ergebnis. Nicht anwendbare Belege (sonstige Rechnungen,
 * MINIMUM/BASIC WL, ZUGFeRD 1.0, ohne Profil) werden nie geprueft und bekommen keine Zeile.
 */
export async function validateIncomingInvoice(
  orgId: string,
  id: string,
  opts: ValidateOptions = {},
): Promise<{ result: IncomingValidationResult; validationId: string | null }> {
  const row = await dbInternal.incomingInvoice.findFirst({
    where: { id, orgId },
    select: { id: true, kind: true, isEInvoice: true, hintsJson: true, validationStatus: true },
  });
  if (!row) throw new NotFoundError(NOT_FOUND);
  if (row.validationStatus === "NOT_APPLICABLE" || row.kind === "OTHER" || !row.isEInvoice) {
    return { result: "NOT_APPLICABLE", validationId: null };
  }
  return runExclusive(async () => {
    const engine = opts.engine ?? selectEngine();
    const started = Date.now();
    let outcome: EngineOutcome;
    if (hasHint(row.hintsJson, "LINES_TRUNCATED")) {
      outcome = { notChecked: "TOO_MANY_LINES" };
    } else {
      // Hash-Pruefung der archivierten Datei vor der Pruefung (Abweichung -> Pflicht-Alarm, Fehler wird gereicht).
      const file = await getIncomingFile(orgId, id, "xml");
      outcome = await engine.run(decode(file.bytes), { timeoutMs: opts.timeoutMs ?? VALIDATE_TIMEOUT_MS });
    }
    const reason = reasonOf(outcome);
    let result: IncomingValidationResult;
    let findings: { ruleId: string; level: string; location: string; text: string }[] = [];
    let formatErrors = 0;
    let ruleErrors = 0;
    let warnings = 0;
    if ("notChecked" in outcome) {
      result = "NOT_CHECKED";
    } else {
      findings = outcome.findings;
      ({ formatErrors, ruleErrors, warnings } = outcome);
      result = formatErrors > 0 || ruleErrors > 0 ? "INVALID" : warnings > 0 ? "WARNINGS" : "VALID";
    }
    const at = opts.now ?? new Date();
    const created = await dbInternal.$transaction(async (tx) => {
      const v = await tx.incomingInvoiceValidation.create({
        data: {
          incomingInvoiceId: row.id,
          at,
          engine: engine.id,
          artefactVersion: engine.artefactVersion,
          result,
          reason,
          formatErrors,
          ruleErrors,
          warnings,
          findingsJson: JSON.stringify(findings),
          durationMs: Math.min(Date.now() - started, 2_000_000_000),
        },
        select: { id: true },
      });
      await tx.incomingInvoice.update({ where: { id: row.id }, data: { validationStatus: result }, select: { id: true } });
      return v;
    });
    return { result, validationId: created.id };
  });
}

/** Manuelle Pruefung (REST, MCP, Oberflaeche): wie `validateIncomingInvoice`, aber je Firma auf wenige Laeufe je Minute begrenzt. */
export function requestIncomingValidation(orgId: string, id: string, opts: ValidateOptions = {}): ReturnType<typeof validateIncomingInvoice> {
  rateLimit(`incoming-validate:${orgId}`, { limit: INCOMING_VALIDATE_PER_MINUTE, windowMs: 60_000 });
  return validateIncomingInvoice(orgId, id, opts);
}

/** Reiht eine Pruefung ein; Fehler werden nur mit Id und Code protokolliert (nie mit Dateiinhalt). */
export function queueIncomingValidation(incomingInvoiceId: string): void {
  // Tests (und Betreiber, die nur den Nachlauf wollen) schalten die Sofortpruefung nach der Annahme ab.
  if (process.env.INCOMING_VALIDATION_AFTER_RECEIVE === "0") return;
  void (async () => {
    const row = await dbInternal.incomingInvoice.findUnique({ where: { id: incomingInvoiceId }, select: { orgId: true } });
    if (row) await validateIncomingInvoice(row.orgId, incomingInvoiceId);
  })().catch((e: unknown) => {
    console.error("Eingangsrechnung: Pruefung fehlgeschlagen", incomingInvoiceId, e instanceof Error ? e.name : "unbekannt");
  });
}

async function markEngineError(id: string, at: Date): Promise<void> {
  await dbInternal.$transaction(async (tx) => {
    await tx.incomingInvoiceValidation.create({
      data: { incomingInvoiceId: id, at, engine: "none", artefactVersion: "-", result: "NOT_CHECKED", reason: "ENGINE_ERROR" },
      select: { id: true },
    });
    await tx.incomingInvoice.update({ where: { id }, data: { validationStatus: "NOT_CHECKED" }, select: { id: true } });
  });
}

const BACKLOG_MIN_AGE_MS = 2 * 60_000;

/** Nachlauf: `PENDING`-Rechnungen, die seit mindestens 2 Minuten liegen, aelteste zuerst, seriell. */
export async function runIncomingValidationBacklog(now: Date, opts: { max?: number; engine?: ValidationEngine } = {}): Promise<{ validated: number; failed: number }> {
  const max = opts.max ?? 5;
  const rows = await dbInternal.incomingInvoice.findMany({
    where: { validationStatus: "PENDING", receivedAt: { lte: new Date(now.getTime() - BACKLOG_MIN_AGE_MS) } },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: max,
    select: { id: true, orgId: true },
  });
  let validated = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await validateIncomingInvoice(r.orgId, r.id, { now, engine: opts.engine });
      validated++;
    } catch (e) {
      failed++;
      console.error("Eingangsrechnung: Nachpruefung fehlgeschlagen", r.id, e instanceof Error ? e.name : "unbekannt");
      // Nicht jeden Lauf von vorn: ein dauerhaft fehlschlagender Beleg wuerde die uebrigen blockieren.
      await markEngineError(r.id, now).catch(() => undefined);
    }
  }
  return { validated, failed };
}
