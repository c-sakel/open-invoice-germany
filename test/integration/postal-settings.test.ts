/** Phase 16d T3 — Postversand-Einstellungen, Verbindungstest, Preisabfrage (nur Transport-Fake, nie Netz). */
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { dbInternal } from "@/lib/db";
import { SecretsUnavailableError } from "@/lib/crypto/secrets";
import {
  loadPostalCredentials,
  loadPostalSettings,
  PostalDisabledError,
  PostalNotConfiguredError,
  savePostalSettings,
} from "@/domain/postal/settings";
import { queryPostalPrice, testPostalConnection } from "@/domain/postal/connection";
import type { LxpTransport, LxpTransportRequest, LxpTransportResponse } from "@/lib/postal/transport";

const KEY = "lxp-test-key-16d-000000000000";
const USER = "lxp-test-user";
const fx = (n: string): unknown => JSON.parse(readFileSync(path.join(__dirname, "../fixtures/letterxpress", `${n}.json`), "utf8"));
const ctx = { actor: "tester", source: "UI" as const };
let orgId: string;
let httpsSpy: ReturnType<typeof vi.spyOn>;
const prevSecret = process.env.AUTH_SECRET;

function fake(res: LxpTransportResponse): { transport: LxpTransport; calls: LxpTransportRequest[] } {
  const calls: LxpTransportRequest[] = [];
  return { calls, transport: async (req) => (calls.push(req), res) };
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  orgId = (await dbInternal.organization.create({ data: { legalName: "Post GmbH", addressLine1: "Weg 1", postalCode: "21339", city: "Lüneburg" } })).id;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});
beforeEach(() => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("Einstellungen", () => {
  it("Defaults ohne Zeile", async () => {
    const v = await loadPostalSettings(orgId);
    expect(v).toMatchObject({ enabled: false, mode: "DRY_RUN", effective: "OFF_DRY_RUN", hasApiKey: false, apiKeyLast4: null });
    expect(await loadPostalCredentials(orgId)).toBeNull();
  });

  it("Zugang nur verschluesselt, View ohne Klartext, Merge bewahrt Schluessel", async () => {
    const v = await savePostalSettings(orgId, { username: USER, apiKey: KEY }, ctx);
    expect(v).toMatchObject({ hasApiKey: true, apiKeyLast4: "0000", username: USER });
    expect(JSON.stringify(v)).not.toContain(KEY);
    const row = await dbInternal.postalSettings.findUniqueOrThrow({ where: { orgId }, select: { apiKeyEnc: true } });
    expect(row.apiKeyEnc?.startsWith("v1:")).toBe(true);
    expect(row.apiKeyEnc).not.toContain(KEY);
    // ohne apiKey bleibt der alte; Schalter bleiben beim Speichern anderer Felder erhalten
    await savePostalSettings(orgId, { autoDunningPost: true }, ctx);
    await savePostalSettings(orgId, { color: "4" }, ctx);
    const v2 = await loadPostalSettings(orgId);
    expect(v2).toMatchObject({ hasApiKey: true, apiKeyLast4: "0000", autoDunningPost: true, color: "4" });
    expect((await loadPostalCredentials(orgId))?.apiKey).toBe(KEY);
  });

  it("ohne AUTH_SECRET: SecretsUnavailableError, nichts gespeichert", async () => {
    delete process.env.AUTH_SECRET;
    await expect(savePostalSettings(orgId, { apiKey: "neuer-schluessel-9999", color: "1" }, ctx)).rejects.toBeInstanceOf(SecretsUnavailableError);
    process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
    const v = await loadPostalSettings(orgId);
    expect(v.color).toBe("4");
    expect(v.apiKeyLast4).toBe("0000");
  });

  it("LIVE nur mit Kostenbestaetigung", async () => {
    await expect(savePostalSettings(orgId, { enabled: true, mode: "LIVE" }, ctx)).rejects.toBeInstanceOf(ZodError);
    expect(await loadPostalSettings(orgId)).toMatchObject({ enabled: false, mode: "DRY_RUN" });
    const ok = await savePostalSettings(orgId, { enabled: true, mode: "LIVE", acknowledgeCosts: true }, ctx);
    expect(ok.effective).toBe("LIVE");
    // bereits Live: weitere Speicherungen brauchen keine erneute Bestaetigung
    await savePostalSettings(orgId, { duplex: true }, ctx);
    await savePostalSettings(orgId, { mode: "DRY_RUN" }, ctx);
    expect((await savePostalSettings(orgId, { enabled: true }, ctx)).effective).toBe("DRY_RUN");
  });

  it("TEST braucht ebenfalls Bestaetigung; Modus bleibt unveraendert", async () => {
    const o = (await dbInternal.organization.create({ data: { legalName: "Test-Post GmbH", addressLine1: "Weg 2", postalCode: "21339", city: "Lüneburg" } })).id;
    await expect(savePostalSettings(o, { enabled: true, mode: "TEST" }, ctx)).rejects.toBeInstanceOf(ZodError);
    expect(await loadPostalSettings(o)).toMatchObject({ enabled: false, mode: "DRY_RUN" });
    const ok = await savePostalSettings(o, { enabled: true, mode: "TEST", acknowledgeCosts: true }, ctx);
    expect(ok.effective).toBe("TEST");
    // TEST -> LIVE ist weiterhin ein Versandzustand: keine erneute Bestaetigung noetig
    expect((await savePostalSettings(o, { mode: "LIVE" }, ctx)).effective).toBe("LIVE");
  });

  it("parallele Speicherungen verlieren keinen Schalter und umgehen die Bestaetigung nicht", async () => {
    const o = (await dbInternal.organization.create({ data: { legalName: "Parallel GmbH", addressLine1: "Weg 3", postalCode: "21339", city: "Lüneburg" } })).id;
    const res = await Promise.allSettled([
      savePostalSettings(o, { duplex: true }, ctx),
      savePostalSettings(o, { autoDunningPost: true }, ctx),
      savePostalSettings(o, { enabled: true, mode: "TEST" }, ctx),
      savePostalSettings(o, { color: "4" }, ctx),
    ]);
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
    expect(await loadPostalSettings(o)).toMatchObject({ duplex: true, autoDunningPost: true, color: "4", enabled: false, mode: "DRY_RUN" });
  });

  it("apiKey zusammen mit clearApiKey wird abgelehnt; kurzer Schluessel ebenso", async () => {
    await expect(savePostalSettings(orgId, { apiKey: KEY, clearApiKey: true }, ctx)).rejects.toBeInstanceOf(ZodError);
    await expect(savePostalSettings(orgId, { apiKey: "kurz-12345" }, ctx)).rejects.toBeInstanceOf(ZodError);
  });

  it("API/MCP: nur Druckoptionen", async () => {
    for (const src of ["API", "MCP"] as const) {
      expect((await savePostalSettings(orgId, { color: "4" }, { actor: "k", source: src })).color).toBe("4");
      for (const bad of [{ enabled: true }, { mode: "LIVE" }, { apiKey: "abcdefgh12" }, { autoDunningPost: true }]) {
        await expect(savePostalSettings(orgId, bad, { actor: "k", source: src })).rejects.toBeInstanceOf(ZodError);
      }
    }
  });

  it("clearApiKey entfernt den Schluessel", async () => {
    const org2 = (await dbInternal.organization.create({ data: { legalName: "Post2 GmbH", addressLine1: "Weg 2", postalCode: "21339", city: "Lüneburg" } })).id;
    await savePostalSettings(org2, { username: USER, apiKey: KEY }, ctx);
    const v = await savePostalSettings(org2, { clearApiKey: true }, ctx);
    expect(v).toMatchObject({ hasApiKey: false, apiKeyLast4: null });
    expect(await loadPostalCredentials(org2)).toBeNull();
  });

  it("ActivityLog ohne Schluessel und Benutzername", async () => {
    const org3 = (await dbInternal.organization.create({ data: { legalName: "Post3 GmbH", addressLine1: "Weg 3", postalCode: "21339", city: "Lüneburg" } })).id;
    await savePostalSettings(org3, { enabled: true, mode: "TEST", acknowledgeCosts: true, username: USER, apiKey: KEY }, ctx);
    const logs = await dbInternal.activityLog.findMany({ where: { orgId: org3, type: "POSTAL_SETTINGS_CHANGED" }, select: { entityType: true, dataJson: true } });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.entityType).toBe("POSTAL");
    const data = JSON.parse(logs[0]?.dataJson ?? "{}") as { changed: string[]; enabled: boolean; mode: string; autoDunningPost: boolean };
    expect(data).toMatchObject({ enabled: true, mode: "TEST", autoDunningPost: false });
    expect(data.changed).toEqual(expect.arrayContaining(["enabled", "mode"]));
    expect(logs[0]?.dataJson).not.toContain(KEY);
    expect(logs[0]?.dataJson).not.toContain(USER);
  });
});

describe("Verbindungstest", () => {
  let org: string;
  beforeEach(async () => {
    org = (await dbInternal.organization.create({ data: { legalName: "Test GmbH", addressLine1: "Weg 4", postalCode: "21339", city: "Lüneburg" } })).id;
  });

  it("ohne Zugang: PostalNotConfiguredError", async () => {
    const { transport, calls } = fake({ status: 200, json: fx("balance") });
    await expect(testPostalConnection(org, { transport })).rejects.toBeInstanceOf(PostalNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  it("ok: nur /balance, auth.mode je Modus, auch bei enabled=false", async () => {
    await savePostalSettings(org, { username: USER, apiKey: KEY }, ctx);
    const f = fake({ status: 200, json: fx("balance") });
    const now = new Date("2026-11-13T10:00:00Z");
    const r = await testPostalConnection(org, { transport: f.transport, now });
    expect(r.ok).toBe(true);
    expect(f.calls.map((c) => c.path)).toEqual(["/balance"]);
    expect((f.calls[0]?.body as { auth: { mode: string } }).auth.mode).toBe("test");
    const v = await loadPostalSettings(org);
    expect(v).toMatchObject({ lastTestOk: true, lastTestError: null, enabled: false });
    expect(v.lastBalanceCents).toBe(r.ok ? r.balanceCents : -1);
    expect(v.lastTestAt?.toISOString()).toBe(now.toISOString());

    await savePostalSettings(org, { enabled: true, mode: "LIVE", acknowledgeCosts: true }, ctx);
    const f2 = fake({ status: 200, json: fx("balance") });
    await testPostalConnection(org, { transport: f2.transport });
    expect((f2.calls[0]?.body as { auth: { mode: string } }).auth.mode).toBe("live");
  });

  it("401: Zugangsdaten abgelehnt", async () => {
    await savePostalSettings(org, { username: USER, apiKey: KEY }, ctx);
    const f = fake({ status: 401, json: fx("unauthorized") });
    expect(await testPostalConnection(org, { transport: f.transport })).toEqual({ ok: false, error: "Zugangsdaten abgelehnt" });
    expect(await loadPostalSettings(org)).toMatchObject({ lastTestOk: false, lastTestError: "Zugangsdaten abgelehnt" });
  });

  it("Fehlertext geschwaerzt", async () => {
    await savePostalSettings(org, { username: USER, apiKey: KEY }, ctx);
    const f = fake({ status: 403, json: { message: `Benutzer ${USER} mit ${KEY} gesperrt` } });
    const r = await testPostalConnection(org, { transport: f.transport });
    expect(r.ok).toBe(false);
    const text = r.ok ? "" : r.error;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(USER);
  });

  it("Schluessel nicht lesbar (AUTH_SECRET gewechselt)", async () => {
    await savePostalSettings(org, { username: USER, apiKey: KEY }, ctx);
    process.env.AUTH_SECRET = "ein-ganz-anderes-secret-0123456789";
    const f = fake({ status: 200, json: fx("balance") });
    const r = await testPostalConnection(org, { transport: f.transport });
    expect(r).toEqual({ ok: false, error: "Schluessel nicht lesbar (AUTH_SECRET gewechselt?)" });
    expect(f.calls).toHaveLength(0);
    expect(await loadPostalSettings(org)).toMatchObject({ hasApiKey: true, apiKeyLast4: null });
  });
});

describe("Preisabfrage", () => {
  it("enabled=false: PostalDisabledError ohne Transportaufruf", async () => {
    const o = (await dbInternal.organization.create({ data: { legalName: "Preis GmbH", addressLine1: "Weg 5", postalCode: "21339", city: "Lüneburg" } })).id;
    await savePostalSettings(o, { username: USER, apiKey: KEY }, ctx);
    const f = fake({ status: 200, json: fx("price") });
    await expect(queryPostalPrice(o, { pages: 2 }, { transport: f.transport })).rejects.toBeInstanceOf(PostalDisabledError);
    expect(f.calls).toHaveLength(0);

    await savePostalSettings(o, { enabled: true }, ctx);
    const r = await queryPostalPrice(o, { pages: 2, registered: "r1" }, { transport: f.transport });
    expect(r.priceCents).toBeGreaterThan(0);
    expect(f.calls.map((c) => c.path)).toEqual(["/price"]);
    await expect(queryPostalPrice(o, { pages: 2, registered: "r1", shipping: "international" }, { transport: f.transport })).rejects.toBeInstanceOf(ZodError);
    expect(f.calls).toHaveLength(1);
  });
});
