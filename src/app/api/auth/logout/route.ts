import { NextResponse } from "next/server";
import { clearPendingMfa, clearSession } from "@/lib/auth/server";

export const runtime = "nodejs";

export async function POST() {
  await clearSession();
  await clearPendingMfa();
  return NextResponse.json({ ok: true });
}
