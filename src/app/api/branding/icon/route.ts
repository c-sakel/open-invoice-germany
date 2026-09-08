import { NextResponse } from "next/server";
import { readFile as readAppFile } from "node:fs/promises";
import path from "node:path";
import { getActiveOrg } from "@/lib/org";
import { loadBrandingSettings } from "@/domain/settings/branding";
import { readFile } from "@/lib/attachments/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE = { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } as const;

/**
 * Favicon der Instanz (Phase 12c) — OEFFENTLICH (in PUBLIC_PREFIXES): der Browser fordert
 * das Icon bereits fuer die Login-Seite an, also vor jeder Session. Ohne eigenen Upload
 * liefert die Route das mitgelieferte src/app/favicon.ico.
 */
export async function GET() {
  try {
    const branding = await loadBrandingSettings((await getActiveOrg()).id);
    if (branding.faviconPath) {
      const buffer = await readFile(branding.faviconPath);
      return new NextResponse(new Uint8Array(buffer), { status: 200, headers: { "content-type": "image/png", ...CACHE } });
    }
  } catch {
    // keine Organisation / Datei nicht lesbar -> mitgeliefertes Icon
  }
  const fallback = await readAppFile(path.join(process.cwd(), "src/app/favicon.ico"));
  return new NextResponse(new Uint8Array(fallback), { status: 200, headers: { "content-type": "image/x-icon", ...CACHE } });
}
