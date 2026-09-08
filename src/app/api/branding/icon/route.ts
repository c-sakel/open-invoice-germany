import { NextResponse } from "next/server";
import { readFile as readAppFile } from "node:fs/promises";
import path from "node:path";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { readFile, sniffMime } from "@/lib/attachments/storage";
import { ASSET_CACHE_HEADERS, assetEtag, isWithinAttachmentsRoot } from "../asset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Favicon der Instanz (Phase 12c; Fix-Welle Fix 1: Containment-Pruefung, Byte-Sniff,
 * ETag) — OEFFENTLICH (in PUBLIC_PREFIXES): der Browser fordert das Icon bereits fuer
 * die Login-Seite an, also vor jeder Session.
 *
 * Fallback (mitgeliefertes src/app/favicon.ico) greift bei JEDER Abweichung vom
 * Normalfall — kein Upload, Datei nicht lesbar, Pfad ausserhalb von ATTACHMENTS_DIR
 * (isWithinAttachmentsRoot, asset.ts), oder die Bytes sniffen nicht als PNG. Bewusst
 * KEIN 404 wie bei /api/branding/appLogo: diese Route zeigt IMMER ein Icon (Vertrag mit
 * der Huelle), ein 404 wuerde in jedem Browser-Tab ein kaputtes Icon zeigen. Die
 * Sicherheitswirkung ist trotzdem vollstaendig — bei Containment-Verletzung wird die
 * Datei gar nicht erst gelesen.
 *
 * `?v=<updatedAt>` (von der Huelle, Task 3, an <link rel="icon"> angehaengt) ist reines
 * Cache-Busting fuer den Browser — diese Route liest den Parameter nicht, sondern setzt
 * auf ETag + `must-revalidate`.
 */
export async function GET() {
  try {
    const org = await getActiveOrg();
    const row = await dbInternal.brandingSettings.findUnique({
      where: { orgId: org.id },
      select: { faviconPath: true, updatedAt: true },
    });
    if (row?.faviconPath && isWithinAttachmentsRoot(row.faviconPath)) {
      const buffer = await readFile(row.faviconPath);
      if (sniffMime(buffer) === "image/png") {
        return new NextResponse(new Uint8Array(buffer), {
          status: 200,
          headers: { "content-type": "image/png", etag: assetEtag(row.updatedAt, row.faviconPath), ...ASSET_CACHE_HEADERS },
        });
      }
    }
  } catch {
    // keine Organisation / Datei nicht lesbar -> mitgeliefertes Icon
  }
  const fallback = await readAppFile(path.join(process.cwd(), "src/app/favicon.ico"));
  return new NextResponse(new Uint8Array(fallback), { status: 200, headers: { "content-type": "image/x-icon", ...ASSET_CACHE_HEADERS } });
}
