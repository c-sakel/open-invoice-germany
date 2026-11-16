/**
 * Server-Aktionen pruefen die Sitzung selbst (der Proxy schuetzt sie ueber oeffentliche Pfade nicht).
 * Statisch: jede "use server"-Datei unter src/app nutzt den gemeinsamen Helfer und kennt weder getActiveOrg noch
 * den Platzhalter-Akteur "system". Ausnahmen sind bewusst oeffentlich.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => null }));

const ROOT = path.resolve(__dirname, "../../src/app");
/** Bewusst oeffentlich: Kundenentscheidung ueber den geheimen Angebotslink (eigene Token-Pruefung). */
const PUBLIC_ACTIONS = new Set(["angebot/[token]/actions.ts"]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const serverFiles = walk(ROOT)
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .filter((f) => /^\s*["']use server["']/m.test(fs.readFileSync(f, "utf8").slice(0, 400)))
  .map((f) => path.relative(ROOT, f));

describe("Server-Aktionen verlangen eine Sitzung", () => {
  it("findet die Aktionsdateien", () => {
    expect(serverFiles.length).toBeGreaterThan(20);
    for (const p of PUBLIC_ACTIONS) expect(serverFiles).toContain(p);
  });

  it.each(serverFiles.filter((f) => !PUBLIC_ACTIONS.has(f)))("%s nutzt den Helfer und nie den Platzhalter-Akteur", (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    expect(src).toMatch(/requireActionOrg|requireSessionActor/);
    expect(src).not.toMatch(/getActiveOrg\b/);
    expect(src).not.toMatch(/getCurrentUserId\b/);
    expect(src).not.toMatch(/\?\?\s*"system"/);
  });

  it("ohne Sitzung: Abbruch mit festem Fehler und ohne Schreibwirkung", async () => {
    const { requireActionOrg, requireSessionActor, AuthRequiredError } = await import("@/lib/auth/require-session");
    await expect(requireSessionActor()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(requireActionOrg()).rejects.toThrow("Nicht angemeldet.");
    const { dbInternal } = await import("@/lib/db");
    const before = await dbInternal.exchangeRate.count();
    const { upsertExchangeRateAction } = await import("@/app/actions/exchange-rate");
    const fd = new FormData();
    fd.set("source", "MONTHLY");
    fd.set("currency", "USD");
    fd.set("rateDate", "2113-03-15");
    fd.set("rate", "1,1214");
    const res = await upsertExchangeRateAction({ ok: false }, fd);
    expect(res.ok).toBe(false);
    expect(await dbInternal.exchangeRate.count()).toBe(before);
  });
});
