import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { unreadCount } from "@/domain/notifications/create";
import { describeError } from "@/lib/safe-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Task 4: `GET /api/notifications/unread-count` — fuer den `UnreadBadge`-Zaehler in der
 *  Sidebar (`src/components/shell/UnreadBadge.tsx`, Abschluss-Review Phase 11a). */
export async function GET() {
  try {
    const org = await getActiveOrg();
    const count = await unreadCount(org.id);
    return NextResponse.json({ count });
  } catch (e) {
    console.error("GET /api/notifications/unread-count:", describeError(e));
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
