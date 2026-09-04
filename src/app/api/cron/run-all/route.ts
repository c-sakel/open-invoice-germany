/**
 * Cron-Endpunkt: fuehrt beide Scheduler-Jobs seriell aus (recurring -> dunning, Phase 6,
 * Task 3). Auth-Muster identisch zu `/api/cron/run-recurring`.
 */
import { NextResponse } from "next/server";
import { runScheduledJobs } from "@/domain/scheduler/runner";

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
    const results = await runScheduledJobs({ trigger: "CRON" });
    const ok = results.every((r) => r.ok);
    return NextResponse.json({ ok, results }, { status: ok ? 200 : 207 });
  } catch (e) {
    console.error("cron/run-all:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
