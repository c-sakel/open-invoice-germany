/**
 * Phase 16d — Status-Abgleich der Postauftraege (Scheduler-Job "postal").
 *
 * - Nur Organisationen mit aktivem Postversand im Modus TEST/LIVE und gueltigem Zugang; Auftraege nur im
 *   aktuellen Modus (sonst kein Netzaufruf). Seriell, mit Pause zwischen den Anfragen, begrenzt je Lauf.
 * - Statusuebergaenge ausschliesslich ueber `transitionPostalJob`, je Auftrag eine eigene Transaktion;
 *   Netzaufrufe liegen nie in einer Transaktion.
 * - UNKNOWN/SUBMITTING (Ausgang unklar) werden ueber den eindeutigen Dateinamen (`filename_original`) in den
 *   Listen des Anbieters gesucht. Es gibt NIE einen automatischen Neuversand; ohne Treffer nach 60 min -> FAILED
 *   mit Hinweis zur manuellen Pruefung — aber nur, wenn die Listen vollstaendig geladen wurden (sonst UNKNOWN + Hinweis).
 *   Ein Treffer mit Status `canceled` schliesst den Auftrag als CANCELLED ab.
 * - Unlesbare Antworten (auch unbekannte Statuswerte) und Ausfaelle werden nicht ausgewertet; der Auftrag
 *   bleibt unveraendert und wird im naechsten Lauf erneut abgefragt.
 */
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { emitEvent } from "@/domain/webhook/emit";
import { serializePostalJob } from "@/api/serializers/postal";
import {
  createLetterXpressClient,
  LxpAuthError,
  LxpRequestError,
  LxpUnavailableError,
  redact,
  type LxpCredentials,
  type LxpPrintJob,
} from "@/lib/postal/letterxpress";
import { defaultTransport, PostalNetworkForbiddenError, type LxpTransport } from "@/lib/postal/transport";
import {
  addPostalEvent,
  notifyPostal,
  POSTAL_JOB_SELECT,
  transitionPostalJob,
  type PostalStatus,
} from "./events";
import { markDunningSentByPost, revertDunningSentByPost } from "./dunning-mark";
import { loadPostalCredentials, PostalKeyUnreadableError } from "./settings";

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const UNCLEAR_AFTER_MS = 10 * 60 * 1000;
const GIVE_UP_AFTER_MS = 60 * 60 * 1000;
const TRACKING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PROVIDER_GAP_MS = 600;
const DEFAULT_LIMIT = 100;
const RECONCILE_PAGES = 2;

export interface PostalPollResult {
  polled: number;
  changed: number;
  reconciled: number;
  failed: number;
  skipped: Record<string, number>;
}

interface Candidate {
  id: string;
  orgId: string;
  invoiceId: string;
  docType: string;
  docId: string;
  docNumber: string;
  mode: string;
  status: string;
  providerJobId: number | null;
  filename: string;
  priceCents: number | null;
  vatCents: number | null;
  providerAddress: string | null;
  trackingCode: string | null;
  trackingStatus: string | null;
  error: string | null;
  createdAt: Date;
}

const CANDIDATE_SELECT = {
  id: true,
  orgId: true,
  invoiceId: true,
  docType: true,
  docId: true,
  docNumber: true,
  mode: true,
  status: true,
  providerJobId: true,
  filename: true,
  priceCents: true,
  vatCents: true,
  providerAddress: true,
  trackingCode: true,
  trackingStatus: true,
  error: true,
  createdAt: true,
} as const;

function mapStatus(s: LxpPrintJob["status"]): PostalStatus {
  switch (s) {
    case "queue":
      return "QUEUED";
    case "hold":
      return "HOLD";
    case "done":
      return "DONE";
    case "draft":
      return "DRAFT";
    case "canceled":
      return "CANCELLED";
    default:
      throw new Error("Unbekannter Status des Briefdienstes.");
  }
}

function totals(remote: LxpPrintJob): {
  priceCents?: number;
  vatCents?: number;
  trackingCode: string | null;
  trackingStatus: string | null;
  address: string | null;
} {
  const items = remote.items;
  return {
    ...(items.length > 0 ? { priceCents: items.reduce((s, i) => s + i.amountCents, 0), vatCents: items.reduce((s, i) => s + i.vatCents, 0) } : {}),
    trackingCode: items.find((i) => i.trackingCode)?.trackingCode ?? null,
    trackingStatus: items.find((i) => i.trackingStatus)?.trackingStatus ?? null,
    address: items[0]?.address ?? null,
  };
}

interface RemoteLists {
  jobs: LxpPrintJob[];
  /** Die Auftragsliste des Anbieters hat mehr Seiten, als geladen wurden: "kein Treffer" ist dann kein Beweis. */
  truncated: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function pollPostalJobs(
  now: Date,
  deps: { transport?: LxpTransport; sleep?: (ms: number) => Promise<void>; orgId?: string; limit?: number } = {},
): Promise<PostalPollResult> {
  const result: PostalPollResult = { polled: 0, changed: 0, reconciled: 0, failed: 0, skipped: {} };
  const skip = (k: string): void => {
    result.skipped[k] = (result.skipped[k] ?? 0) + 1;
  };
  const sleeper = deps.sleep ?? defaultSleep;
  let requests = 0;
  const gap = async (): Promise<void> => {
    if (requests > 0) await sleeper(PROVIDER_GAP_MS);
    requests += 1;
  };
  let remaining = deps.limit ?? DEFAULT_LIMIT;

  await failStalePending(now, deps.orgId, result);

  const orgs = await dbInternal.postalSettings.findMany({
    where: { enabled: true, mode: { in: ["TEST", "LIVE"] }, ...(deps.orgId ? { orgId: deps.orgId } : {}) },
    select: { orgId: true, mode: true },
    orderBy: { orgId: "asc" },
  });

  for (const org of orgs) {
    if (remaining <= 0) break;
    let creds: LxpCredentials | null;
    try {
      creds = await loadPostalCredentials(org.orgId);
    } catch (e) {
      if (!(e instanceof PostalKeyUnreadableError)) {
        console.error("postal: Zugangsdaten nicht ladbar", e instanceof Error ? e.name : "Fehler");
        skip("error");
        continue;
      }
      skip("keyUnreadable");
      continue;
    }
    if (!creds) {
      skip("unconfigured");
      continue;
    }
    const mode: "TEST" | "LIVE" = org.mode === "LIVE" ? "LIVE" : "TEST";
    creds = { ...creds, mode: mode === "LIVE" ? "live" : "test" };
    const client = createLetterXpressClient(creds, deps.transport ?? defaultTransport());

    const pollBefore = new Date(now.getTime() - POLL_INTERVAL_MS);
    const candidates: Candidate[] = await dbInternal.postalJob.findMany({
      where: {
        orgId: org.orgId,
        mode,
        OR: [
          { status: { in: ["QUEUED", "HOLD", "DRAFT"] }, OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: pollBefore } }] },
          {
            status: "DONE",
            registered: { not: null },
            providerJobId: { not: null },
            submittedAt: { gte: new Date(now.getTime() - TRACKING_WINDOW_MS) },
            OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: pollBefore } }],
            AND: [{ OR: [{ trackingStatus: null }, { NOT: { trackingStatus: { contains: "Zugestellt" } } }] }],
          },
          { status: { in: ["UNKNOWN", "SUBMITTING"] }, createdAt: { lt: new Date(now.getTime() - UNCLEAR_AFTER_MS) } },
        ],
      },
      select: CANDIDATE_SELECT,
      orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: remaining,
    });
    remaining -= candidates.length;

    let remoteLists: RemoteLists | null | undefined; // undefined: noch nicht geladen, null: nicht ladbar
    const loadLists = async (): Promise<RemoteLists | null> => {
      if (remoteLists !== undefined) return remoteLists;
      const found: LxpPrintJob[] = [];
      let truncated = false;
      const filters =
        mode === "TEST" ? (["queue", "hold", "done", "draft", "canceled"] as const) : (["queue", "hold", "done", "canceled"] as const);
      try {
        for (const filter of filters) {
          for (let page = 1; page <= RECONCILE_PAGES; page++) {
            await gap();
            const res = await client.list(filter, page);
            found.push(...res.jobs);
            if (page >= res.lastPage) break;
            if (page === RECONCILE_PAGES) truncated = true; // weitere Seiten beim Anbieter, nicht geladen
          }
        }
        remoteLists = { jobs: found, truncated };
      } catch (e) {
        if (e instanceof LxpAuthError) throw e;
        if (!(e instanceof LxpUnavailableError || e instanceof LxpRequestError)) throw e;
        remoteLists = null;
      }
      return remoteLists;
    };

    try {
      for (const job of candidates) {
        if (job.providerJobId === null) {
          const out = await reconcileJob(job, mode, creds, loadLists, now);
          if (out === "reconciled") {
            result.reconciled += 1;
            result.changed += 1;
          } else if (out === "failed") {
            result.failed += 1;
            result.changed += 1;
          } else {
            skip(out);
          }
          continue;
        }
        await gap();
        let remote: LxpPrintJob;
        try {
          remote = await client.get(job.providerJobId);
        } catch (e) {
          if (e instanceof LxpAuthError) throw e;
          if (e instanceof LxpUnavailableError) {
            skip("unavailable");
            continue;
          }
          if (e instanceof LxpRequestError) {
            if (e.status === 404) {
              await handleNotFound(job, mode, now);
              result.polled += 1;
              continue;
            }
            skip("rejected");
            continue;
          }
          throw e;
        }
        result.polled += 1;
        const changed = await applyRemote(job, remote, now);
        if (changed === "conflict") skip("conflict");
        else if (changed) result.changed += 1;
      }
    } catch (e) {
      if (e instanceof PostalNetworkForbiddenError) {
        // Test-/Sperrumgebung ohne Netz: Org auslassen, nichts veraendern.
        skip("networkForbidden");
        continue;
      }
      if (!(e instanceof LxpAuthError)) {
        // Fehler einer Organisation (z. B. Datenbank) stoppen nicht den Lauf der anderen.
        console.error("postal: Abgleich einer Organisation fehlgeschlagen", e instanceof Error ? e.name : "Fehler");
        skip("error");
        continue;
      }
      skip("authRejected");
      const first = candidates[0];
      if (first) {
        await notifyPostal(org.orgId, {
          type: "POSTAL_FAILED",
          title: "Postversand: Zugangsdaten abgelehnt",
          body: "Der Briefdienst hat die Zugangsdaten abgelehnt; der Status-Abgleich ist pausiert. Einstellungen pruefen.",
          invoiceId: first.invoiceId,
          dedupeKey: `POSTAL_FAILED:auth:${org.orgId}:${now.toISOString().slice(0, 10)}`,
          at: now,
        });
      }
    }
  }
  return result;
}

/**
 * Haengende PENDING-Auftraege (Prozess nach dem Anlegen abgebrochen, vor dem Netzaufruf): nach 10 min -> FAILED.
 * Es wurde nichts uebertragen (SUBMITTING setzt der Versand erst unmittelbar vor dem Netzaufruf); kein Netz noetig.
 */
async function failStalePending(now: Date, orgId: string | undefined, result: PostalPollResult): Promise<void> {
  const stale = await dbInternal.postalJob.findMany({
    where: { status: "PENDING", mode: { not: "DRY_RUN" }, createdAt: { lt: new Date(now.getTime() - UNCLEAR_AFTER_MS) }, ...(orgId ? { orgId } : {}) },
    select: { id: true, orgId: true },
    orderBy: { createdAt: "asc" },
    take: DEFAULT_LIMIT,
  });
  for (const job of stale) {
    const message = "Auftrag wurde nicht uebertragen (Vorgang abgebrochen)";
    try {
      const moved = await dbInternal.$transaction(async (tx) => {
        if (!(await transitionPostalJob(tx, job.id, "FAILED", { error: message, finishedAt: now }))) return false;
        await addPostalEvent(tx, { jobId: job.id, orgId: job.orgId, kind: "FAILED", status: "FAILED", data: { error: message, notTransmitted: true, reason: "PENDING_STALE" }, at: now });
        return true;
      });
      if (moved) {
        result.failed += 1;
        result.changed += 1;
      }
    } catch (e) {
      console.error("postal: haengender Auftrag konnte nicht abgeschlossen werden", e instanceof Error ? e.name : "Fehler");
      result.skipped.error = (result.skipped.error ?? 0) + 1;
    }
  }
}

/** Bekannter Auftrag: Antwort des Anbieters uebernehmen. Rueckgabe: veraendert / unveraendert / conflict. */
async function applyRemote(job: Candidate, remote: LxpPrintJob, now: Date): Promise<boolean | "conflict"> {
  const status = mapStatus(remote.status);
  const t = totals(remote);
  const current = job.status as PostalStatus;
  // Ein DONE-Auftrag bleibt DONE (nur Sendungsverfolgung fortschreiben).
  const target: PostalStatus = current === "DONE" ? "DONE" : status;
  const statusChanged = target !== current;
  const priceChanged = t.priceCents !== undefined && (t.priceCents !== job.priceCents || t.vatCents !== job.vatCents);
  const trackingChanged = t.trackingCode !== job.trackingCode || t.trackingStatus !== job.trackingStatus;

  return dbInternal.$transaction(async (tx) => {
    const data = {
      lastPolledAt: now,
      ...(priceChanged && t.priceCents !== undefined ? { priceCents: t.priceCents, vatCents: t.vatCents } : {}),
      ...(trackingChanged ? { trackingCode: t.trackingCode, trackingStatus: t.trackingStatus } : {}),
      ...(job.providerAddress === null && t.address ? { providerAddress: t.address } : {}),
      ...(statusChanged && (target === "DONE" || target === "CANCELLED") ? { finishedAt: now } : {}),
    };
    if (!(await transitionPostalJob(tx, job.id, target, data))) return "conflict" as const;
    if (!statusChanged && !priceChanged && !trackingChanged) return false;

    if (statusChanged) {
      await addPostalEvent(tx, { jobId: job.id, orgId: job.orgId, kind: "STATUS", status: target, data: { from: current, to: target }, at: now });
    }
    if (priceChanged) {
      await addPostalEvent(tx, { jobId: job.id, orgId: job.orgId, kind: "PRICE", status: target, data: { priceCents: t.priceCents ?? null, vatCents: t.vatCents ?? null }, at: now });
    }
    if (trackingChanged) {
      await addPostalEvent(tx, { jobId: job.id, orgId: job.orgId, kind: "TRACKING", status: target, data: { trackingCode: t.trackingCode, trackingStatus: t.trackingStatus }, at: now });
    }
    if (statusChanged && (target === "DONE" || target === "CANCELLED")) {
      await finishEffects(tx, job, target, now);
    }
    return true;
  });
}

async function finishEffects(
  tx: Parameters<Parameters<typeof dbInternal.$transaction>[0]>[0],
  job: Candidate,
  target: "DONE" | "CANCELLED",
  now: Date,
): Promise<void> {
  if (target === "CANCELLED") await revertDunningSentByPost(tx, job, now, "system:postal-poll");
  const row = await tx.postalJob.findUniqueOrThrow({ where: { id: job.id }, select: POSTAL_JOB_SELECT });
  await appendChangeLog(tx, {
    orgId: job.orgId,
    entity: "POSTAL",
    entityId: job.id,
    action: target,
    actor: "system:postal-poll",
    at: now,
    diff: { docType: job.docType, docId: job.docId, docNumber: job.docNumber, providerJobId: row.providerJobId, mode: job.mode },
  });
  await emitEvent(tx, {
    orgId: job.orgId,
    type: target === "DONE" ? "postal.done" : "postal.cancelled",
    objectName: "PostalJob",
    objectId: job.id,
    data: serializePostalJob(row),
    now,
  });
}

/** 404 beim Abruf: TEST -> Postbox geleert (CANCELLED); LIVE -> nur Hinweis, keine Statusaenderung. */
async function handleNotFound(job: Candidate, mode: "TEST" | "LIVE", now: Date): Promise<void> {
  const current = job.status as PostalStatus;
  if (mode === "TEST" && ["QUEUED", "HOLD", "DRAFT"].includes(current)) {
    await dbInternal.$transaction(async (tx) => {
      const message = "Postbox nach 7 Tagen geleert";
      if (!(await transitionPostalJob(tx, job.id, "CANCELLED", { lastPolledAt: now, finishedAt: now, error: message }))) return;
      await addPostalEvent(tx, { jobId: job.id, orgId: job.orgId, kind: "STATUS", status: "CANCELLED", data: { from: current, to: "CANCELLED", reason: message }, at: now });
      await finishEffects(tx, job, "CANCELLED", now);
    });
    return;
  }
  if (!["QUEUED", "HOLD", "DRAFT"].includes(current) || job.error !== null) {
    // Nur den Abfragezeitpunkt fortschreiben, damit der Auftrag nicht dauerhaft vorne in der Warteschlange steht.
    await dbInternal.$transaction((tx) => transitionPostalJob(tx, job.id, current, { lastPolledAt: now }));
    return;
  }
  const message = "Beim Briefdienst nicht gefunden (Abruf 404)";
  const noted = await dbInternal.$transaction(async (tx) => {
    if (!(await transitionPostalJob(tx, job.id, current, { lastPolledAt: now, error: message }))) return false;
    await addPostalEvent(tx, { jobId: job.id, orgId: job.orgId, kind: "STATUS", status: current, data: { error: message }, at: now });
    return true;
  });
  if (noted) {
    await notifyPostal(job.orgId, {
      type: "POSTAL_FAILED",
      title: "Postversand: Auftrag nicht auffindbar",
      body: `${job.docNumber}: ${message}. Im Kundenbereich des Briefdienstes pruefen.`,
      invoiceId: job.invoiceId,
      dedupeKey: `POSTAL_FAILED:${job.id}:404`,
      at: now,
    });
  }
}

/** UNKNOWN/SUBMITTING: ueber den eindeutigen Dateinamen in den Listen des Anbieters suchen. Nie Neuversand. */
async function reconcileJob(
  job: Candidate,
  mode: "TEST" | "LIVE",
  creds: LxpCredentials,
  loadLists: () => Promise<RemoteLists | null>,
  now: Date,
): Promise<"reconciled" | "failed" | "unavailable" | "pending"> {
  const lists = await loadLists();
  if (lists === null) return "unavailable";
  const hit = lists.jobs.find((r) => r.filenameOriginal === job.filename);

  if (hit && mapStatus(hit.status) === "CANCELLED") {
    // Beim Anbieter bereits storniert: nach eigener Regel abschliessen (kein Brief, kein Neuversand, kein Mahnungsvermerk).
    const t = totals(hit);
    const ok = await dbInternal.$transaction(async (tx) => {
      if (job.status === "SUBMITTING" && !(await transitionPostalJob(tx, job.id, "UNKNOWN", {}))) return false;
      const moved = await transitionPostalJob(tx, job.id, "CANCELLED", {
        providerJobId: hit.id,
        ...(t.priceCents !== undefined ? { priceCents: t.priceCents, vatCents: t.vatCents } : {}),
        lastPolledAt: now,
        finishedAt: now,
        error: null,
      });
      if (!moved) return false;
      await addPostalEvent(tx, {
        jobId: job.id,
        orgId: job.orgId,
        kind: "RECONCILED",
        status: "CANCELLED",
        data: { providerJobId: hit.id, from: job.status, to: "CANCELLED" },
        at: now,
      });
      await finishEffects(tx, job, "CANCELLED", now);
      return true;
    });
    return ok ? "reconciled" : "pending";
  }

  if (hit) {
    const status = mapStatus(hit.status);
    const t = totals(hit);
    const ok = await dbInternal.$transaction(async (tx) => {
      const moved = await transitionPostalJob(tx, job.id, status, {
        providerJobId: hit.id,
        ...(t.priceCents !== undefined ? { priceCents: t.priceCents, vatCents: t.vatCents } : {}),
        ...(t.address ? { providerAddress: t.address } : {}),
        trackingCode: t.trackingCode,
        trackingStatus: t.trackingStatus,
        submittedAt: job.createdAt,
        lastPolledAt: now,
        error: null,
        ...(status === "DONE" ? { finishedAt: now } : {}),
      });
      if (!moved) return false;
      await addPostalEvent(tx, {
        jobId: job.id,
        orgId: job.orgId,
        kind: "RECONCILED",
        status,
        data: { providerJobId: hit.id, from: job.status, to: status },
        at: now,
      });
      const row = await tx.postalJob.findUniqueOrThrow({ where: { id: job.id }, select: POSTAL_JOB_SELECT });
      await appendChangeLog(tx, {
        orgId: job.orgId,
        entity: "POSTAL",
        entityId: job.id,
        action: "RECONCILED",
        actor: "system:postal-poll",
        at: now,
        diff: { docType: job.docType, docId: job.docId, docNumber: job.docNumber, providerJobId: hit.id, mode, priceCents: t.priceCents ?? null },
      });
      if (mode === "LIVE") {
        if (job.docType === "DUNNING") {
          await markDunningSentByPost(tx, {
            orgId: job.orgId,
            jobId: job.id,
            invoiceId: job.invoiceId,
            dunningId: job.docId,
            docNumber: job.docNumber,
            at: now,
            actor: "system:postal-poll",
            status,
          });
        }
        await logActivity(tx, {
          orgId: job.orgId,
          entityType: "INVOICE",
          entityId: job.invoiceId,
          type: "POSTAL_SENT",
          actor: "system:postal-poll",
          at: now,
          data: { docType: job.docType, docId: job.docId, docNumber: job.docNumber, jobId: job.id, providerJobId: hit.id },
        });
      }
      await emitEvent(tx, { orgId: job.orgId, type: "postal.submitted", objectName: "PostalJob", objectId: job.id, data: serializePostalJob(row), now });
      if (status === "DONE") await finishEffects(tx, job, "DONE", now);
      return true;
    });
    return ok ? "reconciled" : "pending";
  }

  if (now.getTime() - job.createdAt.getTime() < GIVE_UP_AFTER_MS) return "pending";

  if (lists.truncated) {
    // Die Liste beim Anbieter ist laenger als geladen: kein Treffer beweist nichts. UNKNOWN lassen (Doppelversand ausschliessen).
    await notifyPostal(job.orgId, {
      type: "POSTAL_FAILED",
      title: "Postversand unklar",
      body: `${job.docNumber}: Uebertragung nicht abgleichbar (lange Auftragsliste) — im Kundenbereich des Briefdienstes pruefen, nicht erneut senden.`,
      invoiceId: job.invoiceId,
      dedupeKey: `POSTAL_FAILED:${job.id}:truncated`,
      at: now,
    });
    return "pending";
  }

  const message = redact("Uebertragung nicht nachweisbar — im Kundenbereich des Briefdienstes pruefen", creds);
  const failed = await dbInternal.$transaction(async (tx) => {
    if (!(await transitionPostalJob(tx, job.id, "FAILED", { error: message, finishedAt: now }))) return false;
    await addPostalEvent(tx, { jobId: job.id, orgId: job.orgId, kind: "FAILED", status: "FAILED", data: { error: message, reconciled: false }, at: now });
    const row = await tx.postalJob.findUniqueOrThrow({ where: { id: job.id }, select: POSTAL_JOB_SELECT });
    await appendChangeLog(tx, {
      orgId: job.orgId,
      entity: "POSTAL",
      entityId: job.id,
      action: "FAILED",
      actor: "system:postal-poll",
      at: now,
      diff: { docType: job.docType, docId: job.docId, docNumber: job.docNumber, mode, error: message },
    });
    await emitEvent(tx, { orgId: job.orgId, type: "postal.failed", objectName: "PostalJob", objectId: job.id, data: serializePostalJob(row), now });
    return true;
  });
  if (!failed) return "pending";
  await notifyPostal(job.orgId, {
    type: "POSTAL_FAILED",
    title: "Postversand nicht nachweisbar",
    body: `${job.docNumber}: nicht nachweisbar — im Kundenbereich pruefen.`,
    invoiceId: job.invoiceId,
    dedupeKey: `POSTAL_FAILED:${job.id}:unproven`,
    at: now,
  });
  return "failed";
}
