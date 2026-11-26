import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { dashboardSummary } from "@/domain/dashboard/summary";
import { describeError } from "@/lib/safe-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const org = await getActiveOrg();
    const summary = await dashboardSummary(org.id, new Date());
    return NextResponse.json(summary);
  } catch (e) {
    console.error("GET /api/dashboard:", describeError(e));
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
