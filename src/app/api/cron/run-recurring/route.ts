/**
 * Cron-Endpunkt: erzeugt alle fälligen Abo-Rechnungen.
 *
 * Aufruf z. B. täglich. Schutz: ist CRON_SECRET gesetzt, muss der Header
 *   Authorization: Bearer <CRON_SECRET>   (oder ?secret=<CRON_SECRET>)
 * passen. Ohne gesetztes Secret ist der Endpunkt nur via Self-Hosting-Netz
 * erreichbar — für öffentliche Deployments unbedingt CRON_SECRET setzen.
 *
 * Läuft seit Phase 6 (Task 3) intern über `runScheduledJobs` (nur Job "recurring"), damit
 * auch dieser — bereits vor Phase 6 bestehende — Aufruf im `SchedulerRun`-Protokoll landet.
 * Die Antwortform bleibt unverändert ({ ok, generated, abos }), ergänzt um `runId`.
 */
import { NextResponse } from "next/server";
import { runScheduledJobs } from "@/domain/scheduler/runner";
import type { RecurringRunSummary } from "@/domain/recurring/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get("secret") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
  try {
    const [result] = await runScheduledJobs({ jobs: ["recurring"], trigger: "CRON" });
    if (!result) return NextResponse.json({ error: "Job nicht ausgefuehrt" }, { status: 500 });
    if (!result.ok) return NextResponse.json({ error: result.error ?? "Fehler" }, { status: 500 });
    const abos = (result.summary.abos as RecurringRunSummary[] | undefined) ?? [];
    const generated = typeof result.summary.generated === "number" ? result.summary.generated : abos.reduce((n, s) => n + s.emitted.length, 0);
    return NextResponse.json({ ok: true, generated, abos, runId: result.runId });
  } catch (e) {
    console.error("cron/run-recurring:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
