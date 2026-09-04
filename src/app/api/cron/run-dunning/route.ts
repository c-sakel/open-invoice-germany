/**
 * Cron-Endpunkt: fuehrt nur den Mahn-Job aus (Phase 6, Task 3). Auth-Muster identisch zu
 * `/api/cron/run-recurring` (CRON_SECRET als Bearer-Header oder `?secret=`).
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
    const [result] = await runScheduledJobs({ jobs: ["dunning"], trigger: "CRON" });
    if (!result) return NextResponse.json({ error: "Job nicht ausgefuehrt" }, { status: 500 });
    if (!result.ok) return NextResponse.json({ error: result.error ?? "Fehler" }, { status: 500 });
    return NextResponse.json({ ok: true, runId: result.runId, ...result.summary });
  } catch (e) {
    console.error("cron/run-dunning:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
