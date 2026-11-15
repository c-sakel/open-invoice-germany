/**
 * DATEV-Oberflaechen-Actions: Validierung mit deutschen Fehlertexten, Bestaetigung nur mit Haken und Notiz,
 * Ursprungspruefung, Vorschau ohne Schreibzugriff, Export, Debitorennummer-Sperre im Kundenformular-Pfad.
 * Nummernkennung 2230, Belegdaten 2096.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ orgId: "", origin: null as string | null, site: null as string | null }));
vi.mock("@/lib/org", () => ({ getActiveOrg: async () => ({ id: state.orgId }) }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "ui-user" }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({
  headers: async () => {
    const h: Record<string, string | null> = { host: "app.example.test", origin: state.origin, "sec-fetch-site": state.site };
    return { get: (name: string): string | null => h[name.toLowerCase()] ?? null };
  },
}));

import { dbInternal } from "@/lib/db";
import { saveDatevSettings } from "@/domain/export/datev/settings";
import { applyDatevTemplate } from "@/domain/export/datev/mapping";
import { updateCustomerWithDatev } from "@/domain/customer/update-with-datev";
import { listUsedMappingKeys } from "@/domain/export/datev/used-keys";
import {
  applyDatevTemplateAction,
  confirmDatevMappingAction,
  previewDatevExportAction,
  runDatevExportAction,
  saveDatevMappingAction,
  saveDatevSettingsAction,
} from "@/app/einstellungen/datev/actions";
import { mkDatevInvoice, mkDatevOrg, type DatevTestOrg } from "../helpers/datev-fixtures";

const MAR = new Date("2096-03-10T10:00:00.000Z");
let tmpDir: string;
let prevArchive: string | undefined;
let org: DatevTestOrg;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-ui-"));
  prevArchive = process.env.ARCHIVE_DIR;
  process.env.ARCHIVE_DIR = tmpDir;
  org = await mkDatevOrg("Datev Oberflaeche GmbH", "2230", MAR);
  state.orgId = org.orgId;
  await mkDatevInvoice(org, { issue: MAR });
  // Die Actions verwenden die aktuelle Zeit; nur Date wird auf einen Zeitpunkt nach dem Beleg gesetzt.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2096-06-10T10:00:00.000Z") });
});

afterAll(async () => {
  vi.useRealTimers();
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("DATEV-Actions", () => {
  it("ungültige Beraternummer liefert einen deutschen Fehlertext", async () => {
    const r = await saveDatevSettingsAction({ consultantNumber: 12 });
    expect(r).toEqual({ ok: false, error: "Beraternummer: ganze Zahl von 1001 bis 9999999" });
  });

  it("fremder Ursprung wird abgelehnt", async () => {
    state.origin = "https://boese.example.test";
    const r = await saveDatevSettingsAction({ consultantNumber: 123456 });
    expect(r).toEqual({ ok: false, error: "Anfrage nicht zulässig." });
    state.origin = null;
    state.site = "cross-site";
    expect((await confirmDatevMappingAction({ note: "Kanzlei Muster", acknowledged: true })).ok).toBe(false);
    state.site = null;
    state.origin = "https://app.example.test";
    expect((await saveDatevSettingsAction({ consultantNumber: 123456, clientNumber: 12345, exportPayments: false })).ok).toBe(true);
    state.origin = null;
  });

  it("Bestätigung ohne Haken oder ohne Notiz scheitert, nichts wird bestätigt", async () => {
    await applyDatevTemplateAction({ chart: "SKR03" });
    const noTick = await confirmDatevMappingAction({ note: "Kanzlei Muster", acknowledged: false });
    expect(noTick.ok).toBe(false);
    if (!noTick.ok) expect(noTick.error).toContain("mit dem Steuerberater abgestimmt");
    const noNote = await confirmDatevMappingAction({ note: "", acknowledged: true });
    expect(noNote).toEqual({ ok: false, error: "Notiz: 3 bis 200 Zeichen" });
    expect((await dbInternal.datevSettings.findUniqueOrThrow({ where: { orgId: org.orgId }, select: { confirmedHash: true } })).confirmedHash).toBeNull();
  });

  it("Export vor der Bestätigung wird gesperrt", async () => {
    const r = await previewDatevExportAction({ from: "2096-03", to: "2096-03", mode: "PERIOD" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bestaetigt");
  });

  it("Vorlage meldet Zeilen ohne Vorschlag; Zuordnung speichern macht die Bestätigung hinfällig", async () => {
    const t = await applyDatevTemplateAction({ chart: "SKR03" });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.withoutSuggestion).toContain("REVENUE REGULAR|Z|0");
    const c = await confirmDatevMappingAction({ note: "Kanzlei Muster, 12.04.", acknowledged: true });
    expect(c).toEqual({ ok: true });
    const row = await dbInternal.datevSettings.findUniqueOrThrow({ where: { orgId: org.orgId }, select: { confirmedHash: true, confirmedNote: true } });
    expect(row.confirmedHash).not.toBeNull();
    expect(row.confirmedNote).toBe("Kanzlei Muster, 12.04.");
    expect(await saveDatevMappingAction([{ kind: "REVENUE", key: "REGULAR|S|19", account: 8401, buKey: null }])).toEqual({ ok: true });
    // Nach dem Ersetzen fehlen andere Zeilen: Vorschau scheitert wegen fehlender Bestaetigung.
    const p = await previewDatevExportAction({ from: "2096-03", to: "2096-03", mode: "PERIOD" });
    expect(p.ok).toBe(false);
    // ungueltiger Schluessel -> deutscher Text
    const bad = await saveDatevMappingAction([{ kind: "REVENUE", key: "kaputt", account: 8400, buKey: null }]);
    expect(bad).toEqual({ ok: false, error: "Schluessel passt nicht zur Art" });
  });

  it("benötigte Schlüssel kommen aus den festgeschriebenen Belegen", async () => {
    const used = await listUsedMappingKeys(org.orgId);
    expect(used).toContainEqual({ kind: "REVENUE", key: "REGULAR|S|19", count: 1 });
    // Kasse und Ueberweisung brauchen keine Zuordnungszeile.
    expect(used.some((u) => u.key === "METHOD:CASH" || u.key === "METHOD:TRANSFER")).toBe(false);
  });

  it("Vorschau schreibt nichts, Export erzeugt Protokoll und Datei, Wiederholung braucht Freigabe", async () => {
    await saveDatevMappingAction([]);
    await applyDatevTemplateAction({ chart: "SKR03" });
    expect((await confirmDatevMappingAction({ note: "Kanzlei Muster, 13.04.", acknowledged: true })).ok).toBe(true);
    const before = await dbInternal.datevExport.count({ where: { orgId: org.orgId } });
    const p = await previewDatevExportAction({ from: "2096-03", to: "2096-03", mode: "PERIOD" });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.preview.itemCount).toBe(1);
      expect(p.preview.issues).toEqual([]);
    }
    expect(await dbInternal.datevExport.count({ where: { orgId: org.orgId } })).toBe(before);
    const e = await runDatevExportAction({ from: "2096-03", to: "2096-03", mode: "PERIOD" });
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.export.lineCount).toBeGreaterThan(0);
      expect(e.export.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const again = await runDatevExportAction({ from: "2096-03", to: "2096-03", mode: "PERIOD" });
    expect(again.ok).toBe(false);
    const rep = await previewDatevExportAction({ from: "2096-03", to: "2096-03", mode: "PERIOD" });
    expect(rep.ok && rep.preview.repeats.length).toBe(1);
    const forced = await runDatevExportAction({ from: "2096-03", to: "2096-03", mode: "PERIOD", repeat: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.export.repeat).toBe(true);
  });

  it("Debitorennummer ist nach dem Export am Kunden gesperrt", async () => {
    await expect(updateCustomerWithDatev(org.orgId, org.customerId, { datevAccount: 10099 }, "ui-user")).rejects.toThrow(/gesperrt/);
  });

  it("Zahlungsexport lässt sich einschalten, Einstellungen bleiben gültig", async () => {
    const r = await saveDatevSettingsAction({ exportPayments: true });
    expect(r.ok).toBe(true);
    await saveDatevSettings(org.orgId, { exportPayments: false }, "test");
    await applyDatevTemplate(org.orgId, "SKR03", "test");
  });
});
