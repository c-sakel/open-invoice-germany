/**
 * Kontoabruf, Oberflaechen-Kern (Server-Action-Logik): nur eigene Firma, PIN/TAN/Produkt-ID nie in Antworten oder Logs,
 * feste Fehlertexte, Entsperren nur mit Bestaetigung, Abruf mit Freigabe in der App bis zum Import. Testjahr 2256.
 * Nie ein echtes Netz: das Bankprotokoll ist durch eine Attrappe ersetzt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { FintsError, type FintsClient } from "@/lib/fints/client";
import { saveBankFetchSettings } from "@/domain/bank-fetch/settings";
import { sweepSessions } from "@/domain/bank-fetch/sessions";
import {
  archiveConnectionCore,
  connectCore,
  continueFetchCore,
  continueSetupCore,
  createConnectionCore,
  loadClientConnections,
  saveSettingsCore,
  selectAccountsCore,
  setAutoCore,
  startFetchCore,
  storePinCore,
  updateConnectionCore,
} from "@/components/bank-fetch/bank-fetch-core";
import { bankFetchErrorText, NOT_FOUND_TEXT, SESSION_LOST_TEXT } from "@/components/bank-fetch/bank-fetch-ui";
import { camtDone, decoupledChallenge, done, FakeFintsClient, syncResult } from "../helpers/fake-fints-client";
import { camtDocument, FINTS_BLZ, FINTS_IBAN_2, FINTS_PRODUCT_ID, FINTS_URL, FINTS_USER } from "../helpers/fints-fixtures";

const holder = vi.hoisted(() => ({ client: null as unknown as FintsClient }));
vi.mock("@/domain/bank-fetch/client-factory", () => ({
  FINTS_PRODUCT_VERSION: "1.0",
  getFintsClient: () => holder.client,
}));

const NOW = new Date("2256-03-01T10:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const PIN = "Pin-2256a";
const TAN = "246810";
const MARKERS = [PIN, TAN, FINTS_PRODUCT_ID];
const actor = "user-2256";

let fake = new FakeFintsClient();
let prevSecret: string | undefined;
const logs: string[] = [];

const mkOrg = async (name: string, withProduct = true): Promise<string> => {
  const id = (await dbInternal.organization.create({ data: { legalName: `Oberflaeche ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  if (withProduct) await saveBankFetchSettings(id, { productId: FINTS_PRODUCT_ID }, "tester");
  return id;
};
const input = (over: Record<string, unknown> = {}) => ({ label: "Testzugang", bankCode: FINTS_BLZ, url: FINTS_URL, userId: FINTS_USER, ...over });
const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`Unerwarteter Fehler: ${r.error}`);
  return r.data;
};
const noMarkers = (label: string, value: unknown): void => {
  const text = JSON.stringify(value);
  for (const m of MARKERS) expect(text, `${label}: ${m}`).not.toContain(m);
};

beforeAll(() => {
  prevSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "kontoabruf-oberflaeche-secret-0123456789";
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});
beforeEach(() => {
  fake = new FakeFintsClient();
  holder.client = fake;
  logs.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => String(x)).join(" "));
    });
  }
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await sweepSessions(Date.UTC(2400, 0, 1));
});

describe("Einstellungen und Bankzugaenge", () => {
  it("Produkt-ID: Antwort enthaelt nur Schalter, ungueltige ID und fehlende ID geben feste Texte", async () => {
    const org = await mkOrg("Settings", false);
    const bad = await saveSettingsCore(org, actor, { productId: "zu kurz!" });
    expect(bad).toEqual({ ok: false, error: "Die Produkt-ID besteht aus 10 bis 30 Buchstaben und Ziffern." });
    expect(await createConnectionCore(org, actor, input())).toEqual({ ok: false, error: bankFetchErrorText("PRODUCT_ID_MISSING") });
    const ok = await saveSettingsCore(org, actor, { productId: FINTS_PRODUCT_ID });
    expect(must(ok)).toEqual({ productIdConfigured: true, autoHour: 6, firstFetchDays: 30 });
    noMarkers("Einstellungen", ok);
  });

  it("http:// und fremde Adressen werden mit festem Text abgelehnt", async () => {
    const org = await mkOrg("Url");
    const r = await createConnectionCore(org, actor, input({ url: "http://fints.example.org/fints" }));
    expect(r).toEqual({ ok: false, error: bankFetchErrorText("URL_INVALID") });
    expect(await dbInternal.bankConnection.count({ where: { orgId: org } })).toBe(0);
  });

  it("nur die eigene Firma: fremde Ids sind nicht zu unterscheiden von unbekannten", async () => {
    const a = await mkOrg("A");
    const b = await mkOrg("B");
    const view = must(await createConnectionCore(a, actor, input()));
    expect(await loadClientConnections(b)).toEqual([]);
    const upd = await updateConnectionCore(b, actor, view.id, { label: "Fremd" });
    const unknown = await updateConnectionCore(b, actor, "unbekannt0000000000000000", { label: "Fremd" });
    expect(upd).toEqual({ ok: false, error: NOT_FOUND_TEXT });
    expect(upd).toEqual(unknown);
    expect(await archiveConnectionCore(b, actor, view.id)).toEqual({ ok: false, error: NOT_FOUND_TEXT });
    expect(await selectAccountsCore(b, actor, view.id, { accountIds: [] })).toEqual({ ok: false, error: NOT_FOUND_TEXT });
    expect((await dbInternal.bankConnection.findUniqueOrThrow({ where: { id: view.id } })).label).toBe("Testzugang");
  });

  it("PIN speichern nur mit Bestaetigung; die Sicht verraet nur 'gespeichert'", async () => {
    const org = await mkOrg("Pin");
    const view = must(await createConnectionCore(org, actor, input()));
    expect(view.pinMode).toBe("PER_FETCH");
    expect(await storePinCore(org, actor, view.id, { pin: PIN })).toEqual({ ok: false, error: "Bitte die Speicherung der PIN ausdrücklich bestätigen." });
    const all = must(await storePinCore(org, actor, view.id, { pin: PIN, confirm: true }));
    expect(all[0]).toMatchObject({ pinMode: "STORED", hasPin: true });
    noMarkers("Sicht", all);
    const row = await dbInternal.bankConnection.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.pinEnc).not.toContain(PIN);
    // Automatischer Abruf: erst nach erfolgreichem Abruf (feste Texte).
    expect(await setAutoCore(org, actor, view.id, true)).toEqual({ ok: false, error: bankFetchErrorText("NO_ACCOUNT_SELECTED") });
  });

  it("Entsperren nur per ausdruecklicher Bestaetigung", async () => {
    const org = await mkOrg("Sperre");
    const view = must(await createConnectionCore(org, actor, input()));
    fake.syncAnswers.push(new FintsError("PIN_REJECTED", ["9931"]));
    expect(await connectCore(org, actor, view.id, { pin: PIN })).toEqual({ ok: false, error: bankFetchErrorText("PIN_REJECTED") });
    const opens = fake.opens.length;
    expect(await connectCore(org, actor, view.id, { pin: PIN })).toEqual({ ok: false, error: bankFetchErrorText("PIN_PREVIOUSLY_REJECTED") });
    expect(await startFetchCore(org, actor, view.id, { pin: PIN })).toEqual({ ok: false, error: bankFetchErrorText("PIN_PREVIOUSLY_REJECTED") });
    expect(fake.opens.length).toBe(opens);
    fake.syncAnswers.push(done(syncResult()));
    const again = must(await connectCore(org, actor, view.id, { pin: PIN, unlockConfirmed: true }));
    expect(again.state).toBe("DONE");
    expect(fake.opens.length).toBe(opens + 1);
  });
});

describe("Einrichtung und Abruf mit Freigabe in der App", () => {
  it("bis zum Import; PIN, TAN und Produkt-ID nie in Antworten oder Logs; fremdes Token gibt denselben Text", async () => {
    const org = await mkOrg("Ablauf");
    const other = await mkOrg("Fremd");
    const replies: unknown[] = [];
    const view = must(await createConnectionCore(org, actor, input()));
    replies.push(view);

    fake.syncAnswers.push(decoupledChallenge());
    fake.continueAnswers.push(done(syncResult()));
    const first = must(await connectCore(org, actor, view.id, { pin: PIN }));
    replies.push(first);
    if (first.state !== "SCA") throw new Error("Freigabe erwartet");
    expect(first.challenge.decoupled).toBe(true);

    // Zu frueh gefragt: weiter warten, ohne die Bank zu fragen.
    const early = must(await continueSetupCore(org, actor, first.token, {}));
    expect(early.state).toBe("SCA");
    expect(fake.sessions[0]?.continueCalls).toBe(0);
    // Ein fremdes Token und ein unbekanntes Token liefern denselben Text.
    const foreign = await continueSetupCore(other, actor, first.token, {});
    const unknown = await continueSetupCore(other, actor, "unbekannt-unbekannt-unbekannt", {});
    expect(foreign).toEqual({ ok: false, error: SESSION_LOST_TEXT });
    expect(foreign).toEqual(unknown);

    vi.setSystemTime(at(3_000));
    const set = must(await continueSetupCore(org, actor, first.token, {}));
    replies.push(set);
    if (set.state !== "DONE") throw new Error("Einrichtung erwartet");
    expect(set.connection.accounts).toHaveLength(2);
    expect(set.connection.accounts.every((a) => /^[A-Z]{2}\d{2} \*{4} \d{4}$/.test(a.ibanMasked))).toBe(true);
    noMarkers("Einrichtung", replies);

    const sel = must(await selectAccountsCore(org, actor, view.id, { accountIds: [set.connection.accounts[0]!.id] }));
    expect(sel.accounts.filter((a) => a.selected)).toHaveLength(1);

    fake.camtAnswers.push(decoupledChallenge());
    fake.continueAnswers.push(camtDone([camtDocument(FINTS_IBAN_2, "ui-1")]));
    vi.setSystemTime(at(5 * 60_000));
    const fetchStart = must(await startFetchCore(org, actor, view.id, { pin: PIN }));
    replies.push(fetchStart);
    if (fetchStart.state !== "SCA") throw new Error("Freigabe erwartet");
    expect(fetchStart.challenge.text).toBe("Bitte in der App freigeben");
    expect(await continueFetchCore(other, actor, fetchStart.token, {})).toEqual({ ok: false, error: SESSION_LOST_TEXT });

    vi.setSystemTime(at(5 * 60_000 + 3_000));
    const fetched = must(await continueFetchCore(org, actor, fetchStart.token, {}));
    replies.push(fetched);
    if (fetched.state !== "DONE") throw new Error("Abruf erwartet");
    expect(fetched.runs).toHaveLength(1);
    expect(fetched.runs[0]).toMatchObject({ result: "OK", importedCount: 1, duplicateCount: 0 });
    expect(fetched.runs[0]?.iban).not.toContain(FINTS_IBAN_2);

    const imports = await dbInternal.bankStatementImport.findMany({ where: { orgId: org }, select: { origin: true, importedCount: true } });
    expect(imports).toEqual([{ origin: "FINTS", importedCount: 1 }]);
    expect(await dbInternal.bankStatementImport.count({ where: { orgId: other } })).toBe(0);

    noMarkers("Antworten", replies);
    for (const line of logs) for (const m of MARKERS) expect(line).not.toContain(m);
    // Auch in der Datenbank steht die PIN nirgends im Klartext (Modus je Abruf).
    const row = await dbInternal.bankConnection.findUniqueOrThrow({ where: { id: view.id } });
    expect(JSON.stringify(row)).not.toContain(PIN);
    const runRows = await dbInternal.bankFetchRun.findMany({ where: { orgId: org } });
    expect(JSON.stringify(runRows)).not.toContain(PIN);
  });

  it("falsche TAN-Eingabe wird nicht an die Bank gesendet (Format)", async () => {
    const org = await mkOrg("Tan");
    const view = must(await createConnectionCore(org, actor, input()));
    fake.syncAnswers.push({ kind: "sca", challenge: { decoupled: false, text: "TAN eingeben", image: null, waitFirstMs: 0, waitNextMs: 0, maxPolls: 1 } });
    const r = must(await connectCore(org, actor, view.id, { pin: PIN }));
    if (r.state !== "SCA") throw new Error("TAN erwartet");
    expect(r.challenge.decoupled).toBe(false);
    const bad = await continueSetupCore(org, actor, r.token, { tan: "12 34" });
    expect(bad).toEqual({ ok: false, error: bankFetchErrorText("TAN_FORMAT") });
    noMarkers("TAN", bad);
  });
});
