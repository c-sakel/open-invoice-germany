/**
 * REST und MCP des DATEV-Exports: Scopes, Einstellungen, Kontenzuordnung, Bestaetigung nur ueber die Domain
 * (Oberflaeche), Vorschau, Lauf, Wiederholung, Download, Debitorennummer am Kunden, MCP-Datei.
 * Nummernkennung 2226, Belegdaten 2096; die Uhr steht nach dem Aufbau auf 2096-05-10.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { confirmDatevMapping } from "@/domain/export/datev/settings";
import { recordPayment } from "@/domain/invoice/payment";
import { sha256Hex } from "@/lib/archive/storage";
import { server } from "@/mcp/server";
import { GET as ExportList, POST as ExportPost } from "@/app/api/v1/DatevExport/route";
import { GET as ExportGet } from "@/app/api/v1/DatevExport/[id]/route";
import { GET as ExportFile } from "@/app/api/v1/DatevExport/[id]/file/route";
import { GET as ExportStatus } from "@/app/api/v1/DatevExport/status/route";
import { GET as SettingsGet, PUT as SettingsPut } from "@/app/api/v1/Settings/datev/route";
import { GET as MappingGet, PUT as MappingPut } from "@/app/api/v1/Settings/datev/mapping/route";
import { POST as TemplatePost } from "@/app/api/v1/Settings/datev/template/route";
import { PATCH as ContactPatch } from "@/app/api/v1/Contact/[id]/route";
import { mkCustomer, mkDatevInvoice, mkDatevOrg, type DatevTestOrg } from "../helpers/datev-fixtures";

const MAR = new Date("2096-03-10T10:00:00.000Z");
const MAR_PAY = new Date("2096-03-20T10:00:00.000Z");
const NOW = new Date("2096-05-10T10:00:00.000Z");
const prevSecret = process.env.AUTH_SECRET;
const prevArchive = process.env.ARCHIVE_DIR;

let tmpDir: string;
let outDir: string;
let org: DatevTestOrg;
let other: DatevTestOrg;
let secondCustomer = "";
let otherCustomer = "";
let adminToken = "";
let writeToken = "";
let readToken = "";
let otherToken = "";

function req(url: string, opts: { method?: string; token?: string; body?: unknown } = {}): Request {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;
type Err = { error: { code: string; reason?: string; message: string; details?: { issues?: unknown[] } } };

const post = (token: string, body: unknown) => ExportPost(req("http://x/api/v1/DatevExport", { method: "POST", token, body }));
const PERIOD = { from: "2096-03", to: "2096-03", mode: "PERIOD" } as const;

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  inputSchema?: { safeParseAsync: (d: unknown) => Promise<{ success: true; data: unknown } | { success: false; error: { message: string } }> };
}
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  if (tool.inputSchema) {
    const parsed = await tool.inputSchema.safeParseAsync(args);
    if (!parsed.success) return { content: [{ type: "text", text: `Validierung fehlgeschlagen: ${parsed.error.message}` }], isError: true };
    return tool.handler(parsed.data as Record<string, unknown>);
  }
  return tool.handler(args);
}
const text = (r: ToolResult): string => r.content.map((c) => c.text).join("\n");

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-secret-datev-api-0123456789abcdef";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-api-"));
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-api-out-"));
  process.env.ARCHIVE_DIR = tmpDir;
  org = await mkDatevOrg("Datev Api GmbH", "2226", MAR);
  other = await mkDatevOrg("Datev Api Fremd GmbH", "2226", MAR);
  secondCustomer = await mkCustomer(org, "Zweiter Kunde GmbH", "K-2");
  otherCustomer = await mkCustomer(other, "Fremder Kunde GmbH", "K-9");
  orgStore.id = org.orgId;
  const a = await mkDatevInvoice(org, { issue: MAR, netCents: 10000, taxRate: 19 });
  await mkDatevInvoice(org, { issue: MAR, netCents: 20000, taxRate: 7 });
  await recordPayment(a.id, { amountCents: a.grossCents, paidAt: MAR_PAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org.orgId, now: MAR_PAY, provider: "BANK", providerPaymentId: "bk_dv2226a" });
  adminToken = (await createApiKey(org.orgId, { name: "Datev-Admin", scopes: ["read", "write", "admin"] })).token;
  writeToken = (await createApiKey(org.orgId, { name: "Datev-Write", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(org.orgId, { name: "Datev-Read", scopes: ["read"] })).token;
  otherToken = (await createApiKey(other.orgId, { name: "Datev-Fremd", scopes: ["read", "write", "admin"] })).token;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterAll(async () => {
  vi.useRealTimers();
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevArchive === undefined) delete process.env.ARCHIVE_DIR;
  else process.env.ARCHIVE_DIR = prevArchive;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(outDir, { recursive: true, force: true });
  await dbInternal.$disconnect();
});

describe("Scopes", () => {
  it("write und read: 403 auf Export, Einstellungen, Zuordnung, Vorlage und Download", async () => {
    for (const token of [writeToken, readToken]) {
      expect((await post(token, PERIOD)).status).toBe(403);
      expect((await SettingsGet(req("http://x/api/v1/Settings/datev", { token }))).status).toBe(403);
      expect((await SettingsPut(req("http://x/api/v1/Settings/datev", { method: "PUT", token, body: { clientNumber: 1 } }))).status).toBe(403);
      expect((await MappingGet(req("http://x/api/v1/Settings/datev/mapping", { token }))).status).toBe(403);
      expect((await MappingPut(req("http://x/api/v1/Settings/datev/mapping", { method: "PUT", token, body: { rows: [] } }))).status).toBe(403);
      expect((await TemplatePost(req("http://x/api/v1/Settings/datev/template", { method: "POST", token, body: { chart: "SKR03" } }))).status).toBe(403);
      expect((await ExportFile(req("http://x/api/v1/DatevExport/x/file", { token }), idCtx("x"))).status).toBe(403);
      // Protokoll, Posten und Status enthalten Belegnummern und Betraege: ebenfalls nur admin.
      expect((await ExportList(req("http://x/api/v1/DatevExport", { token }))).status).toBe(403);
      expect((await ExportGet(req("http://x/api/v1/DatevExport/x", { token }), idCtx("x"))).status).toBe(403);
      expect((await ExportStatus(req("http://x/api/v1/DatevExport/status", { token }))).status).toBe(403);
    }
  });
  it("ohne Schluessel: 401", async () => {
    expect((await ExportList(req("http://x/api/v1/DatevExport"))).status).toBe(401);
  });
});

describe("Einstellungen und Zuordnung", () => {
  it("Bestaetigung nur in der Oberflaeche: confirmed/confirmedNote -> 400", async () => {
    for (const body of [{ confirmedNote: "ok ok" }, { confirmed: true }]) {
      const res = await SettingsPut(req("http://x/api/v1/Settings/datev", { method: "PUT", token: adminToken, body }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await json(res))).toContain("nur in der Oberflaeche");
    }
  });

  it("Einstellungen setzen, Vorlage SKR04 liefert Zeilen, ungueltiger Schluessel -> 400", async () => {
    const put = await SettingsPut(req("http://x/api/v1/Settings/datev", { method: "PUT", token: adminToken, body: { consultantNumber: 123456, clientNumber: 12345, exportPayments: true } }));
    expect(put.status).toBe(200);
    expect((await json<{ data: { consultantNumber: number; confirmed: boolean } }>(put)).data).toMatchObject({ consultantNumber: 123456, confirmed: false });
    const tpl = await TemplatePost(req("http://x/api/v1/Settings/datev/template", { method: "POST", token: adminToken, body: { chart: "SKR04" } }));
    expect(tpl.status).toBe(200);
    expect((await json<{ data: { added: number } }>(tpl)).data.added).toBeGreaterThan(0);
    const rows = (await json<{ data: unknown[] }>(await MappingGet(req("http://x/api/v1/Settings/datev/mapping", { token: adminToken })))).data;
    expect(rows.length).toBeGreaterThan(0);
    const bad = await MappingPut(req("http://x/api/v1/Settings/datev/mapping", { method: "PUT", token: adminToken, body: { rows: [{ kind: "REVENUE", key: "kaputt", account: 8400, buKey: null }] } }));
    expect(bad.status).toBe(400);
    // Kontenrahmenwechsel auf SKR03 (Vorschlagswerte werden ersetzt).
    expect((await TemplatePost(req("http://x/api/v1/Settings/datev/template", { method: "POST", token: adminToken, body: { chart: "SKR03" } }))).status).toBe(200);
  });
});

describe("Export", () => {
  let exportId = "";
  let exportSha = "";

  it("ohne Bestaetigung 422 NOT_CONFIRMED (Lauf und Vorschau)", async () => {
    for (const body of [PERIOD, { ...PERIOD, dryRun: true }]) {
      const res = await post(adminToken, body);
      expect(res.status).toBe(422);
      expect((await json<Err>(res)).error.reason).toBe("NOT_CONFIRMED");
    }
    expect(await dbInternal.datevExport.count({ where: { orgId: org.orgId } })).toBe(0);
  });

  it("Einstellungsaenderung per REST entwertet die Bestaetigung", async () => {
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "test");
    const status = async () => (await json<{ data: { confirmed: boolean } }>(await ExportStatus(req("http://x/api/v1/DatevExport/status", { token: adminToken })))).data.confirmed;
    expect(await status()).toBe(true);
    await SettingsPut(req("http://x/api/v1/Settings/datev", { method: "PUT", token: adminToken, body: { dictationCode: "AB" } }));
    expect(await status()).toBe(false);
    expect((await post(adminToken, PERIOD)).status).toBe(422);
    await confirmDatevMapping(org.orgId, "mit dem Steuerberater abgestimmt", "test");
    expect(await status()).toBe(true);
  });

  it("dryRun: 200 mit Vorschau, nichts geschrieben", async () => {
    const before = { exports: await dbInternal.datevExport.count({ where: { orgId: org.orgId } }), items: await dbInternal.datevExportItem.count({ where: { orgId: org.orgId } }), files: await fs.readdir(tmpDir) };
    const res = await post(adminToken, { ...PERIOD, dryRun: true });
    expect(res.status).toBe(200);
    const body = await json<{ data: { objectName: string; months: string[]; itemCount: number; files: unknown[] } }>(res);
    expect(body.data).toMatchObject({ objectName: "DatevPlan", months: ["2096-03"] });
    expect(body.data.itemCount).toBeGreaterThan(0);
    expect(await dbInternal.datevExport.count({ where: { orgId: org.orgId } })).toBe(before.exports);
    expect(await dbInternal.datevExportItem.count({ where: { orgId: org.orgId } })).toBe(before.items);
    expect(await fs.readdir(tmpDir)).toEqual(before.files);
  });

  it("Lauf 201, Download liefert Bytes mit gespeichertem SHA-256", async () => {
    const res = await post(adminToken, PERIOD);
    expect(res.status).toBe(201);
    const view = (await json<{ data: { id: string; sha256: string; files: { name: string }[]; itemCount: number } }>(res)).data;
    exportId = view.id;
    exportSha = view.sha256;
    expect(view.files.length).toBeGreaterThanOrEqual(3);
    const file = await ExportFile(req(`http://x/api/v1/DatevExport/${exportId}/file`, { token: adminToken }), idCtx(exportId));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/zip");
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment; filename="DATEV-Export_[0-9A-Za-z_-]+\.zip"$/);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-length")).toBe(String((await file.clone().arrayBuffer()).byteLength));
    expect(sha256Hex(Buffer.from(await file.arrayBuffer()))).toBe(exportSha);
  });

  it("zweiter Lauf 409 ALREADY_EXPORTED, mit repeat 201", async () => {
    const res = await post(adminToken, PERIOD);
    expect(res.status).toBe(409);
    expect((await json<Err>(res)).error.reason).toBe("ALREADY_EXPORTED");
    const again = await post(adminToken, { ...PERIOD, repeat: true });
    expect(again.status).toBe(201);
    expect((await json<{ data: { repeat: boolean; repeats: { identical: boolean | null }[] } }>(again)).data.repeat).toBe(true);
  });

  it("Liste, Protokoll mit Posten (seitenweise), Status; fremde Org -> 404; ungueltige Seite -> 400", async () => {
    const list = await json<{ data: { id: string }[]; total: number }>(await ExportList(req("http://x/api/v1/DatevExport", { token: adminToken })));
    expect(list.total).toBe(2);
    expect(list.data.map((e) => e.id)).toContain(exportId);
    const one = await json<{ data: { id: string; items: { objectName: string; itemKey: string }[]; itemTotal: number } }>(await ExportGet(req(`http://x/api/v1/DatevExport/${exportId}?limit=1`, { token: adminToken }), idCtx(exportId)));
    expect(one.data.id).toBe(exportId);
    expect(one.data.items).toHaveLength(1);
    expect(one.data.itemTotal).toBeGreaterThan(1);
    expect(one.data.items[0].objectName).toBe("DatevExportItem");
    expect((await ExportGet(req(`http://x/api/v1/DatevExport/${exportId}?limit=0`, { token: adminToken }), idCtx(exportId))).status).toBe(400);
    const st = await json<{ data: { exportedMonths: { month: string }[] } }>(await ExportStatus(req("http://x/api/v1/DatevExport/status", { token: adminToken })));
    expect(st.data.exportedMonths.map((m) => m.month)).toEqual(["2096-03"]);
    expect((await ExportGet(req(`http://x/api/v1/DatevExport/${exportId}`, { token: otherToken }), idCtx(exportId))).status).toBe(404);
    expect((await ExportFile(req(`http://x/api/v1/DatevExport/${exportId}/file`, { token: otherToken }), idCtx(exportId))).status).toBe(404);
    expect((await ExportFile(req(`http://x/api/v1/DatevExport/${exportId}/file`), idCtx(exportId))).status).toBe(401);
    expect(JSON.stringify(one)).not.toContain("internalNotes");
  });
});

describe("Debitorennummer am Kunden", () => {
  const patch = (token: string, id: string, body: unknown) => ContactPatch(req(`http://x/api/v1/Contact/${id}`, { method: "PATCH", token, body }), idCtx(id));

  it("Bereich, Eindeutigkeit, Sperre nach Export; Lesen im Kunden", async () => {
    const exported = (await dbInternal.customer.findUniqueOrThrow({ where: { id: org.customerId }, select: { datevAccount: true } })).datevAccount;
    expect(exported).not.toBeNull();
    const low = await patch(writeToken, secondCustomer, { datevAccount: 5 });
    expect(low.status).toBe(422);
    expect((await json<Err>(low)).error.reason).toBe("ACCOUNT_OUT_OF_RANGE");
    const dup = await patch(writeToken, secondCustomer, { datevAccount: exported });
    expect(dup.status).toBe(409);
    const ok = await patch(writeToken, secondCustomer, { datevAccount: 20007, name: "Zweiter Kunde AG" });
    expect(ok.status).toBe(200);
    expect((await json<{ data: { datevAccount: number; name: string } }>(ok)).data).toMatchObject({ datevAccount: 20007, name: "Zweiter Kunde AG" });
    const locked = await patch(writeToken, org.customerId, { datevAccount: 20008 });
    expect(locked.status).toBe(409);
    expect((await json<Err>(locked)).error.reason).toBe("DEBTOR_LOCKED");
    expect((await dbInternal.customer.findUniqueOrThrow({ where: { id: org.customerId }, select: { datevAccount: true } })).datevAccount).toBe(exported);
    // Fehler in den uebrigen Feldern setzt die Nummer nicht.
    const bad = await patch(writeToken, secondCustomer, { datevAccount: null, name: "" });
    expect(bad.status).toBe(400);
    expect((await dbInternal.customer.findUniqueOrThrow({ where: { id: secondCustomer }, select: { datevAccount: true } })).datevAccount).toBe(20007);
    // Scheitert ein uebriges Feld in der Pruefung gegen die Datenbank, bleibt auch die Nummer unveraendert.
    const foreignMethod = await dbInternal.paymentMethod.findFirst({ where: { orgId: other.orgId }, select: { id: true } });
    const rolled = await patch(writeToken, secondCustomer, { datevAccount: 20011, defaultPaymentMethodId: foreignMethod?.id ?? "fremd-unbekannt" });
    expect(rolled.status).toBe(400);
    expect((await dbInternal.customer.findUniqueOrThrow({ where: { id: secondCustomer }, select: { datevAccount: true } })).datevAccount).toBe(20007);
    // Fremde Org: nicht auffindbar.
    expect((await patch(otherToken, secondCustomer, { datevAccount: 20009 })).status).toBe(404);
    expect(otherCustomer).not.toBe("");
  });

  it("der Kunden-Import kennt das Feld nicht (Spalte wird ignoriert, Guard bleibt)", async () => {
    const { createCustomer } = await import("@/domain/customer/save");
    const c = await createCustomer(org.orgId, { name: "Import AG", addressLine1: "Weg 1", postalCode: "12345", city: "Stadt", datevAccount: 20099 });
    expect(c.datevAccount).toBeNull();
  });
});

describe("MCP", () => {
  beforeAll(() => {
    // Neues Rate-Limit-Fenster (10 Laeufe je Minute und Organisation).
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
  });

  it("export_datev: dryRun ohne Datei, Lauf schreibt die ZIP nach outputDir", async () => {
    const dry = await callTool("export_datev", { ...PERIOD, repeat: true, dryRun: true, outputDir: outDir });
    expect(dry.isError).toBeFalsy();
    expect(text(dry)).toContain("DatevPlan");
    expect(await fs.readdir(outDir)).toEqual([]);
    const run = await callTool("export_datev", { ...PERIOD, repeat: true, outputDir: outDir });
    expect(run.isError).toBeFalsy();
    const files = await fs.readdir(outDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^datev-2096-03-2096-03-[0-9a-f]{8}\.zip$/);
    const target = path.join(outDir, files[0]);
    const bytes = await fs.readFile(target);
    expect(text(run)).toContain(target);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const stored = await dbInternal.datevExport.findFirstOrThrow({ where: { orgId: org.orgId }, orderBy: { createdAt: "desc" }, select: { sha256: true } });
    expect(sha256Hex(bytes)).toBe(stored.sha256);
    expect(text(run)).not.toContain("internalNotes");
  });

  it("outputDir: relativ, mit .., nicht vorhanden oder Datei -> Fehler ohne Lauf; zweiter Lauf ueberschreibt nichts", async () => {
    const countBefore = await dbInternal.datevExport.count({ where: { orgId: org.orgId } });
    const aFile = path.join(outDir, (await fs.readdir(outDir))[0]);
    for (const dir of ["relativ/pfad", `${outDir}/../${path.basename(outDir)}`, path.join(outDir, "gibt-es-nicht"), aFile]) {
      const r = await callTool("export_datev", { ...PERIOD, repeat: true, outputDir: dir });
      expect(r.isError, dir).toBe(true);
      expect(text(r)).toContain("outputDir");
    }
    expect(await dbInternal.datevExport.count({ where: { orgId: org.orgId } })).toBe(countBefore);
    const second = await callTool("export_datev", { ...PERIOD, repeat: true, outputDir: outDir });
    expect(second.isError).toBeFalsy();
    const files = await fs.readdir(outDir);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
  });

  it("Schreibfehler nach dem Lauf: Antwort nennt Export-Id und den erneuten Download", async () => {
    if (process.getuid?.() === 0) return;
    const ro = await fs.mkdtemp(path.join(os.tmpdir(), "oig-datev-ro-"));
    await fs.chmod(ro, 0o500);
    try {
      const r = await callTool("export_datev", { ...PERIOD, repeat: true, outputDir: ro });
      expect(r.isError).toBe(true);
      const latest = await dbInternal.datevExport.findFirstOrThrow({ where: { orgId: org.orgId }, orderBy: { createdAt: "desc" }, select: { id: true } });
      expect(text(r)).toContain(latest.id);
      expect(text(r)).toContain(`/api/v1/DatevExport/${latest.id}/file`);
    } finally {
      await fs.chmod(ro, 0o700);
      await fs.rm(ro, { recursive: true, force: true });
    }
  });

  it("ohne repeat: Fehlertext mit Code; ungueltiger Zeitraum", async () => {
    const r = await callTool("export_datev", { ...PERIOD, outputDir: outDir });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("ALREADY_EXPORTED");
    const bad = await callTool("export_datev", { from: "2096-13", to: "2096-03", mode: "PERIOD", outputDir: outDir });
    expect(bad.isError).toBe(true);
  });

  it("Status, Liste, Einstellungen lesen", async () => {
    expect(text(await callTool("get_datev_status"))).toContain("DatevStatus");
    expect(JSON.parse(text(await callTool("list_datev_exports", {}))).length).toBeGreaterThanOrEqual(3);
    const s = JSON.parse(text(await callTool("get_datev_settings"))) as { settings: { confirmed: boolean }; mapping: unknown[] };
    expect(s.settings.confirmed).toBe(true);
    expect(s.mapping.length).toBeGreaterThan(0);
  });

  it("update_datev_mapping entwertet die Bestaetigung; Settings-Bestaetigung ist kein MCP-Feld", async () => {
    const before = JSON.parse(text(await callTool("get_datev_settings"))) as { mapping: { kind: string; key: string; account: number; buKey: string | null }[] };
    const rows = before.mapping.map((r) => ({ kind: r.kind, key: r.key, account: r.account, buKey: r.buKey }));
    rows[0] = { ...rows[0], account: rows[0].account === 8400 ? 8401 : 8400 };
    const res = await callTool("update_datev_mapping", { rows });
    expect(res.isError).toBeFalsy();
    const after = JSON.parse(text(await callTool("get_datev_settings"))) as { settings: { confirmed: boolean; confirmationStale: boolean } };
    expect(after.settings).toMatchObject({ confirmed: false, confirmationStale: true });
    const blocked = await callTool("export_datev", { ...PERIOD, repeat: true, outputDir: outDir });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("NOT_CONFIRMED");
    const tool = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tool).filter((n) => /datev/.test(n) && /confirm/.test(n))).toEqual([]);
    const s2 = await callTool("update_datev_settings", { exportDebtors: true });
    expect(s2.isError).toBeFalsy();
    expect((await callTool("update_datev_settings", {})).isError).toBe(true);
    for (const [tool, extra] of [["update_datev_settings", { exportDebtors: true }], ["update_datev_mapping", { rows: [] }], ["apply_datev_template", { chart: "SKR03" }]] as const) {
      for (const field of ["confirmed", "confirmedHash", "confirmedNote"]) {
        const refused = await callTool(tool, { ...extra, [field]: field === "confirmed" ? true : "x" });
        expect(refused.isError, `${tool} ${field}`).toBe(true);
        expect(text(refused)).toContain("nur in der Oberflaeche");
      }
    }
    expect((await callTool("apply_datev_template", { chart: "SKR03" })).isError).toBeFalsy();
  });

  it("update_customer: datevAccount gesperrt nach Export", async () => {
    const r = await callTool("update_customer", { customer: org.customerId, datevAccount: 20010 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("DEBTOR_LOCKED");
  });
});

describe("Download fuer die Oberflaeche", () => {
  it("Sitzungsroute: Org-Scope, attachment, sicherer Dateiname, kein inline; fremde und unbekannte Id -> 404", async () => {
    const { GET: SessionFile } = await import("@/app/api/datev/[id]/file/route");
    const row = await dbInternal.datevExport.findFirstOrThrow({ where: { orgId: org.orgId }, orderBy: { createdAt: "asc" }, select: { id: true, sha256: true } });
    const res = await SessionFile(new Request(`http://x/api/datev/${row.id}/file`), idCtx(row.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="DATEV-Export_[0-9A-Za-z_-]+\.zip"$/);
    expect(disposition).not.toContain("inline");
    expect(disposition).not.toMatch(/[\\/]|\.\./);
    expect(sha256Hex(Buffer.from(await res.arrayBuffer()))).toBe(row.sha256);
    orgStore.id = other.orgId;
    try {
      expect((await SessionFile(new Request("http://x"), idCtx(row.id))).status).toBe(404);
      expect((await SessionFile(new Request("http://x"), idCtx("../../etc/passwd"))).status).toBe(404);
    } finally {
      orgStore.id = org.orgId;
    }
  });

  it("die Sitzungsroute liegt nicht unter den oeffentlichen Praefixen (Anmeldung ueber den Proxy)", async () => {
    const { PUBLIC_PREFIXES } = await import("@/proxy");
    expect(PUBLIC_PREFIXES.some((p) => "/api/datev/x/file".startsWith(p))).toBe(false);
  });
});

describe("Zeichen mit Formelwirkung bis in die ZIP", () => {
  it("Kundenname mit weichem Trenner, Minuszeichen, Vollbreite-Gleichheitszeichen und ungleich: kein Zellanfang als Formel", async () => {
    const { runDatevExport } = await import("@/domain/export/datev/run");
    const { setupDatev, unzipBuffer } = await import("../helpers/datev-fixtures");
    const u = await mkDatevOrg("Datev Zeichen GmbH", "2226", MAR);
    const names = ["\u00AD=1+1", "\u2212cmd|' /c calc'!A0", "\uFF1DSUMME(A1)", "\u2260=2", "+HYPERLINK(\"http://x\")", "@SUM(1)"];
    for (const [i, name] of names.entries()) {
      const c = await mkCustomer(u, name, `U-${i}`);
      await mkDatevInvoice(u, { customerId: c, issue: MAR, netCents: 1000 + i });
    }
    await setupDatev(u.orgId);
    orgStore.id = u.orgId;
    try {
      const view = await runDatevExport(u.orgId, PERIOD, "test");
      const { bytes } = await (await import("@/domain/export/datev/run")).readDatevExportFile(u.orgId, view.id);
      const z = unzipBuffer(bytes);
      try {
        const deb = z.read("EXTF_Debitoren.csv").toString("latin1");
        const cells = deb.split("\r\n").slice(2).flatMap((l) => l.split(";"));
        const fold = (v: string) => v.replace(/^"/, "").replace(/"$/, "");
        for (const cell of cells) {
          const t = fold(cell);
          expect(/^[=+\-@\t\r]/.test(t) && !/^-?\d+([.,]\d+)?$/.test(t), `Zelle: ${t}`).toBe(false);
        }
        expect(cells.filter((c) => /^"'/.test(c)).length).toBeGreaterThanOrEqual(1);
        for (const name of z.names.filter((n) => n.startsWith("EXTF_Buchungsstapel"))) {
          const stapel = z.read(name).toString("latin1");
          for (const cell of stapel.split("\r\n").slice(2).flatMap((l) => l.split(";"))) {
            const t = fold(cell);
            expect(/^[=@]/.test(t), `Stapelzelle: ${t}`).toBe(false);
          }
        }
      } finally {
        z.cleanup();
      }
    } finally {
      orgStore.id = org.orgId;
    }
  });
});

describe("Rate-Limit", () => {
  it("11. Export-Aufruf je Minute und Organisation -> 429", async () => {
    vi.setSystemTime(new Date(NOW.getTime() + 60 * 60_000));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(adminToken, { ...PERIOD, dryRun: true })).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
