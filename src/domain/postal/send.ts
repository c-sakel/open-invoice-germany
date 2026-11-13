/**
 * Phase 16d — Versand per Post (Angebot, Trockenlauf, Uebertragung).
 *
 * Schaltermatrix (die Domain erzwingt sie, nicht nur die Oberflaeche):
 *   enabled=false            -> immer Trockenlauf, keine Preisabfrage
 *   enabled, mode DRY_RUN    -> Trockenlauf, Preisabfrage (lesend) nur im Angebot
 *   enabled, mode TEST       -> Uebertragung in die Postbox (keine Sandbox!)
 *   enabled, mode LIVE       -> kostenpflichtige Uebertragung
 * Uebertragung nur mit Bestaetigung je Beleg (confirm, erwarteter Preis, Pruefsumme) oder — nur
 * Mahnautomatik — mit dem zweiten Schalter autoDunningPost. Der Trockenlauf ruft den Transport nie auf.
 *
 * Zustandsautomat: PENDING -> SUBMITTING -> QUEUED|DRAFT|HOLD|DONE|FAILED|UNKNOWN. UNKNOWN wird nie
 * automatisch neu gesendet (kein Idempotenzschluessel beim Anbieter; Abgleich in Task 5). Netzaufrufe
 * laufen nie innerhalb einer Transaktion; Statusuebergaenge nur ueber transitionPostalJob.
 */
import { randomBytes } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { emitEvent } from "@/domain/webhook/emit";
import { serializePostalJob } from "@/api/serializers/postal";
import { InvalidOperationError, NotFoundError } from "@/domain/errors";
import { berlinMonthStart } from "@/lib/berlin-time";
import {
  buildPrintJobBody,
  createLetterXpressClient,
  LxpAuthError,
  LxpRequestError,
  LxpUnavailableError,
  redact,
  type LxpCredentials,
  type LxpPrintJob,
  type PrintJobSummary,
} from "@/lib/postal/letterxpress";
import { defaultTransport, PostalNetworkForbiddenError, type LxpTransport } from "@/lib/postal/transport";
import { postalQuoteInputSchema, postalSendInputSchema, type PostalDocType, type PostalItemInput } from "@/schemas/postal";
import { loadPostalDocument, type PostalDocument } from "./document";
import { PostalConflictError, type PostalConflictCode } from "./errors";
import {
  ACTIVE_POSTAL_STATUSES,
  addPostalEvent,
  CANCEL_WINDOW_MS,
  formatBerlinTime,
  notifyPostal,
  POSTAL_JOB_SELECT,
  transitionPostalJob,
  type PostalStatus,
} from "./events";
import { loadPostalCredentials, loadPostalSettings, PostalKeyUnreadableError, type PostalSettingsView } from "./settings";

export type { PostalDocType, PostalItemInput };

const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
const PROVIDER_GAP_MS = 600;

export interface PostalQuote {
  docType: PostalDocType;
  docId: string;
  docNumber: string;
  invoiceId: string;
  address: string[];
  countryCode: string;
  shipping: "national" | "international";
  pages: number;
  registered: "r1" | "r2" | null;
  pdfSha256: string;
  priceCents: number | null;
  effective: PostalSettingsView["effective"];
  alreadySent: boolean;
  problems: string[];
}

type Registered = "r1" | "r2" | null;

function resolveShipping(setting: PostalSettingsView["shipping"], countryCode: string): "national" | "international" {
  if (setting === "national" || setting === "international") return setting;
  return countryCode === "DE" ? "national" : "international";
}

function resolveRegistered(item: PostalItemInput, settings: PostalSettingsView): Registered {
  return item.registered !== undefined ? item.registered : settings.registeredDefault;
}

function documentProblems(doc: PostalDocument, shipping: "national" | "international", registered: Registered): string[] {
  const problems = [...doc.addressProblems];
  if (doc.pages === null) problems.push("Seitenzahl des Belegs nicht lesbar");
  if (registered && (doc.countryCode !== "DE" || shipping !== "national")) problems.push("Einschreiben nur bei Anschrift in Deutschland (national)");
  if (Math.ceil((doc.pdf.length * 4) / 3) > MAX_REQUEST_BYTES - 64 * 1024) problems.push("Beleg zu gross (Anfrage ueber 50 MB)");
  return problems;
}

async function hasActiveJob(orgId: string, docType: PostalDocType, docId: string): Promise<boolean> {
  const row = await dbInternal.postalJob.findFirst({
    where: { orgId, docType, docId, mode: { not: "DRY_RUN" }, status: { in: [...ACTIVE_POSTAL_STATUSES] } },
    select: { id: true },
  });
  return row !== null;
}

function pageCount(doc: PostalDocument): number {
  return doc.pages ?? 0;
}

/** Angebot je Beleg (Preis, Problemliste); der Preis wird nur bei aktivem Postversand beim Anbieter angefragt. */
export async function quotePostal(
  orgId: string,
  rawItems: unknown,
  deps: { transport?: LxpTransport } = {},
): Promise<{ quotes: PostalQuote[]; totalCents: number | null }> {
  const { items } = postalQuoteInputSchema.parse({ items: rawItems });
  const settings = await loadPostalSettings(orgId);

  let creds: LxpCredentials | null = null;
  let credsProblem: string | null = null;
  if (settings.enabled) {
    try {
      creds = await loadPostalCredentials(orgId);
      if (!creds) credsProblem = "Postversand ist nicht eingerichtet (Zugangsdaten fehlen)";
    } catch (e) {
      if (!(e instanceof PostalKeyUnreadableError)) throw e;
      credsProblem = e.message;
    }
  }
  const client = creds ? createLetterXpressClient(creds, deps.transport ?? defaultTransport()) : null;

  const quotes: PostalQuote[] = [];
  let first = true;
  for (const item of items) {
    const doc = await loadPostalDocument(orgId, item.docType, item.docId);
    const shipping = resolveShipping(settings.shipping, doc.countryCode);
    const registered = resolveRegistered(item, settings);
    const problems = documentProblems(doc, shipping, registered);
    if (credsProblem) problems.push(credsProblem);

    let priceCents: number | null = null;
    if (client && problems.length === 0) {
      if (!first) await sleep(PROVIDER_GAP_MS);
      first = false;
      try {
        priceCents = (
          await client.price({ pages: pageCount(doc), color: settings.color, duplex: settings.duplex, shipping, registered })
        ).priceCents;
      } catch (e) {
        if (!(e instanceof LxpAuthError || e instanceof LxpRequestError || e instanceof LxpUnavailableError)) throw e;
        problems.push(`Preis nicht abfragbar: ${redact(e.message, creds as LxpCredentials)}`);
      }
    }
    quotes.push({
      docType: doc.docType,
      docId: doc.docId,
      docNumber: doc.docNumber,
      invoiceId: doc.invoiceId,
      address: doc.address,
      countryCode: doc.countryCode,
      shipping,
      pages: pageCount(doc),
      registered,
      pdfSha256: doc.pdfSha256,
      priceCents,
      effective: settings.effective,
      alreadySent: await hasActiveJob(orgId, doc.docType, doc.docId),
      problems,
    });
  }
  const priced = quotes.every((q) => q.priceCents !== null);
  return { quotes, totalCents: priced ? quotes.reduce((s, q) => s + (q.priceCents ?? 0), 0) : null };
}

export interface PostalSendContext {
  actor: string;
  trigger: "USER" | "API" | "MCP" | "AUTOMATION";
  transport?: LxpTransport;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface PostalSendResult {
  docType: PostalDocType;
  docId: string;
  jobId: string | null;
  /** Auftragsstatus oder REJECTED (nichts angelegt, nichts uebertragen). */
  status: PostalStatus | "REJECTED";
  error?: string;
  code?: PostalConflictCode;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function safeStem(n: string): string {
  return n.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
}

async function monthlySpendCents(orgId: string, now: Date): Promise<number> {
  const rows = await dbInternal.postalJob.findMany({
    where: { orgId, mode: "LIVE", status: { notIn: ["FAILED", "CANCELLED"] }, createdAt: { gte: berlinMonthStart(now) } },
    select: { priceCents: true, quotedPriceCents: true },
  });
  return rows.reduce((s, r) => s + (r.priceCents ?? r.quotedPriceCents ?? 0), 0);
}

/** Verbindliche Uebertragung bzw. Trockenlauf. Die Items werden nacheinander verarbeitet. */
export async function sendByPost(orgId: string, raw: unknown, ctx: PostalSendContext): Promise<PostalSendResult[]> {
  const input = postalSendInputSchema.parse(raw);
  const settings = await loadPostalSettings(orgId);
  const pause = ctx.sleep ?? sleep;
  const state = { requested: false };
  const results: PostalSendResult[] = [];
  for (const item of input.items) {
    try {
      results.push(await sendOne(orgId, item, settings, ctx, pause, state));
    } catch (e) {
      if (e instanceof PostalConflictError) {
        results.push({ docType: item.docType, docId: item.docId, jobId: null, status: "REJECTED", error: e.message, code: e.code });
      } else if (e instanceof NotFoundError || e instanceof InvalidOperationError) {
        results.push({ docType: item.docType, docId: item.docId, jobId: null, status: "REJECTED", error: e.message, code: "NOT_ALLOWED" });
      } else {
        throw e;
      }
    }
  }
  return results;
}

async function sendOne(
  orgId: string,
  item: ReturnType<typeof postalSendInputSchema.parse>["items"][number],
  settings: PostalSettingsView,
  ctx: PostalSendContext,
  pause: (ms: number) => Promise<void>,
  state: { requested: boolean },
): Promise<PostalSendResult> {
  const now = ctx.now ?? new Date();

  // Mahnautomatik: nur Mahnungen und nur mit dem zweiten Schalter.
  if (ctx.trigger === "AUTOMATION" && (item.docType !== "DUNNING" || !settings.autoDunningPost)) {
    throw new PostalConflictError("Automatischer Postversand ist nicht freigegeben.", "NOT_ALLOWED");
  }

  const doc = await loadPostalDocument(orgId, item.docType, item.docId);
  if (doc.pdfSha256 !== item.pdfSha256) {
    throw new PostalConflictError("Der Beleg hat sich geaendert (Pruefsumme weicht ab). Angebot neu anfordern.", "PDF_CHANGED");
  }
  const shipping = resolveShipping(settings.shipping, doc.countryCode);
  const registered = resolveRegistered(item, settings);
  const problems = documentProblems(doc, shipping, registered);
  if (problems.length > 0) {
    throw new PostalConflictError(problems.join("; "), problems.some((p) => p.startsWith("Anschrift")) ? "NO_ADDRESS" : "NOT_ALLOWED");
  }

  const mode: "DRY_RUN" | "TEST" | "LIVE" = settings.effective === "TEST" || settings.effective === "LIVE" ? settings.effective : "DRY_RUN";

  let creds: LxpCredentials | null = null;
  let client: ReturnType<typeof createLetterXpressClient> | null = null;
  if (mode !== "DRY_RUN") {
    try {
      creds = await loadPostalCredentials(orgId);
    } catch (e) {
      if (e instanceof PostalKeyUnreadableError) throw new PostalConflictError(e.message, "NOT_ALLOWED");
      throw e;
    }
    if (!creds) throw new PostalConflictError("Postversand ist nicht eingerichtet (Zugangsdaten fehlen).", "NOT_ALLOWED");
    creds = { ...creds, mode: mode === "LIVE" ? "live" : "test" };
    client = createLetterXpressClient(creds, ctx.transport ?? defaultTransport());

    // Preis erneut beim Anbieter pruefen und mit der Anzeige beim Bestaetigen vergleichen.
    if (state.requested) await pause(PROVIDER_GAP_MS);
    state.requested = true;
    let priceCents: number;
    try {
      priceCents = (
        await client.price({ pages: pageCount(doc), color: settings.color, duplex: settings.duplex, shipping, registered })
      ).priceCents;
    } catch (e) {
      if (e instanceof LxpAuthError || e instanceof LxpRequestError || e instanceof LxpUnavailableError) {
        throw new PostalConflictError(`Preis nicht abfragbar: ${redact(e.message, creds)}`, "PRICE_UNAVAILABLE");
      }
      throw e;
    }
    if (item.expectedPriceCents !== priceCents) {
      throw new PostalConflictError("Der Preis hat sich geaendert. Angebot neu anfordern.", "PRICE_CHANGED");
    }
    if (mode === "LIVE" && settings.monthlyBudgetCents !== null) {
      const spent = await monthlySpendCents(orgId, now);
      if (spent + priceCents > settings.monthlyBudgetCents) {
        throw new PostalConflictError("Das Monatsbudget fuer den Postversand waere ueberschritten.", "BUDGET");
      }
    }
  }

  const jobId = randomBytes(12).toString("hex");
  const filename = `${safeStem(doc.docNumber)}-${jobId}.pdf`;
  const noticeLabel = doc.docType === "DUNNING" ? "Mahnung" : "Rechnung";
  const { body, summary } = buildPrintJobBody(creds ?? { username: "", apiKey: "", mode: "test" }, {
    pdf: doc.pdf,
    spec: { color: settings.color, mode: settings.duplex ? "duplex" : "simplex", shipping },
    registered,
    filename,
    notice: `${noticeLabel} ${doc.docNumber}`,
  });

  // Auftrag anlegen: Sperre je Rechnung + Pruefung "kein aktiver Auftrag" in einer Transaktion.
  const created = await dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "Invoice", doc.invoiceId, orgId);
    if (!item.repeat) {
      const active = await tx.postalJob.findFirst({
        where: { orgId, docType: doc.docType, docId: doc.docId, mode: { not: "DRY_RUN" }, status: { in: [...ACTIVE_POSTAL_STATUSES] } },
        select: { id: true },
      });
      if (active) return false;
    }
    await tx.postalJob.create({
      data: {
        id: jobId,
        orgId,
        docType: doc.docType,
        docId: doc.docId,
        invoiceId: doc.invoiceId,
        docNumber: doc.docNumber,
        mode,
        trigger: ctx.trigger,
        status: "PENDING",
        filename,
        pages: pageCount(doc),
        color: settings.color,
        duplex: settings.duplex,
        shipping,
        registered,
        quotedPriceCents: item.expectedPriceCents,
        pdfSha256: doc.pdfSha256,
        base64Md5: summary.base64Md5,
        createdBy: ctx.actor,
        createdAt: now,
      },
      select: { id: true },
    });
    await addPostalEvent(tx, { jobId, orgId, kind: "CREATED", status: "PENDING", data: { mode, trigger: ctx.trigger }, at: now });
    return true;
  });
  if (!created) throw new PostalConflictError("Dieser Beleg wurde bereits per Post versendet (oder der Versand laeuft).", "ALREADY_SENT");

  if (mode === "DRY_RUN" || !client || !creds) return finishDryRun(orgId, doc, jobId, summary, now, ctx.actor);
  return transmit({ orgId, doc, jobId, body, summary, client, creds, mode, actor: ctx.actor });
}

async function finishDryRun(
  orgId: string,
  doc: PostalDocument,
  jobId: string,
  summary: PrintJobSummary,
  now: Date,
  actor: string,
): Promise<PostalSendResult> {
  await dbInternal.$transaction(async (tx) => {
    if (!(await transitionPostalJob(tx, jobId, "DRY_RUN", { finishedAt: now }))) {
      throw new Error("Postauftrag nicht im erwarteten Zustand (Trockenlauf).");
    }
    await addPostalEvent(tx, { jobId, orgId, kind: "DRY_RUN", status: "DRY_RUN", data: { summary }, at: now });
    await logActivity(tx, {
      orgId,
      entityType: "INVOICE",
      entityId: doc.invoiceId,
      type: "POSTAL_DRY_RUN",
      actor,
      at: now,
      data: { docType: doc.docType, docId: doc.docId, docNumber: doc.docNumber, jobId },
    });
  });
  return { docType: doc.docType, docId: doc.docId, jobId, status: "DRY_RUN" };
}

interface TransmitInput {
  orgId: string;
  doc: PostalDocument;
  jobId: string;
  body: object;
  summary: PrintJobSummary;
  client: ReturnType<typeof createLetterXpressClient>;
  creds: LxpCredentials;
  mode: "TEST" | "LIVE";
  actor: string;
}

function mapRemoteStatus(s: LxpPrintJob["status"]): "QUEUED" | "DRAFT" | "HOLD" | "DONE" | null {
  switch (s) {
    case "queue":
      return "QUEUED";
    case "draft":
      return "DRAFT";
    case "hold":
      return "HOLD";
    case "done":
      return "DONE";
    default:
      return null;
  }
}

async function transmit(t: TransmitInput): Promise<PostalSendResult> {
  const { orgId, doc, jobId } = t;
  const base = { docType: doc.docType, docId: doc.docId, jobId };

  const claimed = await dbInternal.$transaction((tx) => transitionPostalJob(tx, jobId, "SUBMITTING", {}));
  if (!claimed) throw new PostalConflictError("Der Postauftrag wird bereits verarbeitet.", "ALREADY_SENT");

  let remote: LxpPrintJob;
  try {
    remote = await t.client.submit(t.body);
  } catch (e) {
    return recordFailure(t, e);
  }

  const status = mapRemoteStatus(remote.status);
  if (!status) return recordFailure(t, new LxpRequestError("Vom Briefdienst als storniert gemeldet.", 400));

  const priceCents = remote.items.length > 0 ? remote.items.reduce((s, i) => s + i.amountCents, 0) : undefined;
  const vatCents = remote.items.length > 0 ? remote.items.reduce((s, i) => s + i.vatCents, 0) : undefined;
  const providerAddress = remote.items[0]?.address ?? null;
  const submittedAt = new Date();
  const mismatch = !addressMatches(providerAddress, doc);

  await dbInternal.$transaction(async (tx) => {
    const ok = await transitionPostalJob(tx, jobId, status, {
      providerJobId: remote.id,
      ...(priceCents !== undefined ? { priceCents } : {}),
      ...(vatCents !== undefined ? { vatCents } : {}),
      ...(providerAddress ? { providerAddress } : {}),
      submittedAt,
      ...(status === "DONE" ? { finishedAt: submittedAt } : {}),
    });
    if (!ok) throw new Error("Postauftrag nach der Uebertragung nicht im erwarteten Zustand.");
    await addPostalEvent(tx, {
      jobId,
      orgId,
      kind: "SUBMITTED",
      status,
      data: { providerJobId: remote.id, mode: t.mode, pages: pageCountOf(t), priceCents: priceCents ?? null, vatCents: vatCents ?? null, base64Md5: t.summary.base64Md5 },
      at: submittedAt,
    });
    if (mismatch) {
      await addPostalEvent(tx, { jobId, orgId, kind: "ADDRESS_MISMATCH", status, data: { providerAddressPresent: providerAddress !== null }, at: submittedAt });
    }
    const job = await tx.postalJob.findUniqueOrThrow({ where: { id: jobId }, select: POSTAL_JOB_SELECT });
    await appendChangeLog(tx, {
      orgId,
      entity: "POSTAL",
      entityId: jobId,
      action: "SUBMITTED",
      actor: t.actor,
      at: submittedAt,
      diff: {
        docType: doc.docType,
        docId: doc.docId,
        docNumber: doc.docNumber,
        providerJobId: remote.id,
        mode: t.mode,
        pages: job.pages,
        priceCents: priceCents ?? null,
        vatCents: vatCents ?? null,
        pdfSha256: doc.pdfSha256,
        registered: job.registered,
      },
    });
    if (t.mode === "LIVE") {
      if (doc.docType === "DUNNING") {
        await tx.dunning.update({ where: { id: doc.docId }, data: { sentAt: submittedAt }, select: { id: true } });
        await appendChangeLog(tx, {
          orgId,
          entity: "INVOICE",
          entityId: doc.invoiceId,
          action: "DUNNING_SEND",
          actor: t.actor,
          at: submittedAt,
          diff: { dunningId: doc.docId, number: doc.docNumber, channel: "POST" },
        });
      }
      await logActivity(tx, {
        orgId,
        entityType: "INVOICE",
        entityId: doc.invoiceId,
        type: "POSTAL_SENT",
        actor: t.actor,
        at: submittedAt,
        data: { docType: doc.docType, docId: doc.docId, docNumber: doc.docNumber, jobId, providerJobId: remote.id },
      });
    }
    await emitEvent(tx, {
      orgId,
      type: "postal.submitted",
      objectName: "PostalJob",
      objectId: jobId,
      data: serializePostalJob(job),
      now: submittedAt,
    });
  });

  if (mismatch) {
    const until = formatBerlinTime(new Date(submittedAt.getTime() + CANCEL_WINDOW_MS));
    await notifyPostal(orgId, {
      type: "POSTAL_FAILED",
      title: "Postversand: Anschrift pruefen",
      body: `Anschrift pruefen, Storno bis ${until} (${doc.docNumber}).`,
      invoiceId: doc.invoiceId,
      dedupeKey: `POSTAL_FAILED:${jobId}:address`,
      at: submittedAt,
    });
  }
  return { ...base, status };
}

function pageCountOf(t: TransmitInput): number {
  return t.doc.pages ?? 0;
}

function addressMatches(providerAddress: string | null, doc: PostalDocument): boolean {
  if (!providerAddress) return false;
  const hay = providerAddress.toLowerCase();
  return hay.includes(doc.postalCode.toLowerCase()) && hay.includes(doc.city.toLowerCase());
}

async function recordFailure(t: TransmitInput, e: unknown): Promise<PostalSendResult> {
  const { orgId, doc, jobId } = t;
  const base = { docType: doc.docType, docId: doc.docId, jobId };
  const at = new Date();
  const definitive = e instanceof LxpAuthError || e instanceof LxpRequestError || e instanceof PostalNetworkForbiddenError;
  const known = definitive || e instanceof LxpUnavailableError;
  const message = redact(known && e instanceof Error ? e.message : "Unerwarteter Fehler bei der Uebertragung.", t.creds);

  if (definitive) {
    await dbInternal.$transaction(async (tx) => {
      if (!(await transitionPostalJob(tx, jobId, "FAILED", { error: message, finishedAt: at }))) return;
      await addPostalEvent(tx, { jobId, orgId, kind: "FAILED", status: "FAILED", data: { error: message }, at });
      const job = await tx.postalJob.findUniqueOrThrow({ where: { id: jobId }, select: POSTAL_JOB_SELECT });
      await appendChangeLog(tx, {
        orgId,
        entity: "POSTAL",
        entityId: jobId,
        action: "FAILED",
        actor: t.actor,
        at,
        diff: { docType: doc.docType, docId: doc.docId, docNumber: doc.docNumber, mode: t.mode, error: message },
      });
      await logActivity(tx, {
        orgId,
        entityType: "INVOICE",
        entityId: doc.invoiceId,
        type: "POSTAL_FAILED",
        actor: t.actor,
        at,
        data: { docType: doc.docType, docId: doc.docId, jobId },
      });
      await emitEvent(tx, { orgId, type: "postal.failed", objectName: "PostalJob", objectId: jobId, data: serializePostalJob(job), now: at });
    });
    await notifyPostal(orgId, {
      type: "POSTAL_FAILED",
      title: "Postversand fehlgeschlagen",
      body: `${doc.docNumber}: ${message}`,
      invoiceId: doc.invoiceId,
      dedupeKey: `POSTAL_FAILED:${jobId}`,
      at,
    });
    return { ...base, status: "FAILED", error: message };
  }

  // Ausgang unklar (Timeout, 5xx, unlesbare Antwort): NIE automatisch neu senden.
  await dbInternal.$transaction(async (tx) => {
    if (!(await transitionPostalJob(tx, jobId, "UNKNOWN", { error: message }))) return;
    await addPostalEvent(tx, { jobId, orgId, kind: "UNKNOWN", status: "UNKNOWN", data: { error: message }, at });
  });
  await notifyPostal(orgId, {
    type: "POSTAL_FAILED",
    title: "Postversand unklar",
    body: `${doc.docNumber}: Uebertragung unklar — wird abgeglichen, nicht erneut senden.`,
    invoiceId: doc.invoiceId,
    dedupeKey: `POSTAL_FAILED:${jobId}`,
    at,
  });
  return { ...base, status: "UNKNOWN", error: message };
}
