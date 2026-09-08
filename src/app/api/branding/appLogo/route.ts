import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { loadBrandingSettings } from "@/domain/settings/branding";
import { readFile, sniffMime } from "@/lib/attachments/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE = { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } as const;

/**
 * App-Logo der Instanz (Phase 12c) — OEFFENTLICH (in PUBLIC_PREFIXES): die schlanke
 * Login-/Setup-Huelle zeigt es bereits vor jeder Session. Anders als /api/branding/icon
 * KEIN Fallback: ohne Upload zeigt die Huelle stattdessen das App-Kuerzel (appShortName)
 * als Text — 404 signalisiert das dem aufrufenden Client. Der gespeicherte Pfad traegt
 * keinen Dateityp, deshalb wird er ueber sniffMime aus dem Puffer bestimmt (nur
 * PNG/JPEG — dieselbe Beschraenkung wie beim Upload).
 */
export async function GET() {
  try {
    const branding = await loadBrandingSettings((await getActiveOrg()).id);
    if (!branding.appLogoPath) {
      return NextResponse.json({ error: "Kein Logo hinterlegt." }, { status: 404 });
    }
    const buffer = await readFile(branding.appLogoPath);
    const mime = sniffMime(buffer);
    if (mime !== "image/png" && mime !== "image/jpeg") {
      return NextResponse.json({ error: "Kein Logo hinterlegt." }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(buffer), { status: 200, headers: { "content-type": mime, ...CACHE } });
  } catch {
    return NextResponse.json({ error: "Kein Logo hinterlegt." }, { status: 404 });
  }
}
