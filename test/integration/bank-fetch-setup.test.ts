/**
 * Kontoabruf: Einstellungen, Bankzugaenge, PIN-Modi, Freigabe-Sitzungen, Einrichtung. Testjahr 2253.
 * Nie ein echtes Netz: das Bankprotokoll ist durch eine Attrappe ersetzt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { FintsError, type FintsClient } from "@/lib/fints/client";
import { NotFoundError } from "@/domain/errors";
import { BankFetchError } from "@/domain/bank-fetch/errors";
import {
  archiveBankConnection,
  createBankConnection,
  getBankConnection,
  listBankConnections,
  selectAccounts,
  setAutoEnabled,
  setStoredPin,
  updateBankConnection,
} from "@/domain/bank-fetch/connections";
import { loadBankFetchSettings, saveBankFetchSettings } from "@/domain/bank-fetch/settings";
import { connectBankConnection, continueSetup } from "@/domain/bank-fetch/setup";
import { sweepSessions } from "@/domain/bank-fetch/sessions";
import { acquireLease, releaseLease } from "@/domain/bank-fetch/lease";
import { authOutcomeData } from "@/domain/bank-fetch/connections";
import { toPublicChallenge } from "@/domain/bank-fetch/setup";
import { pinHmac } from "@/domain/bank-fetch/connections";
import { decoupledChallenge, done, FakeFintsClient, syncResult } from "../helpers/fake-fints-client";
import { FINTS_BLZ, FINTS_PRODUCT_ID, FINTS_URL, FINTS_USER } from "../helpers/fints-fixtures";

const holder = vi.hoisted(() => ({ client: null as unknown as FintsClient }));
vi.mock("@/domain/bank-fetch/client-factory", () => ({
  FINTS_PRODUCT_VERSION: "1.0",
  getFintsClient: () => holder.client,
}));

const NOW = new Date("2253-03-01T10:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const PIN = "Pin-2253a";
const PIN2 = "Pin-2253b";
const TAN = "654321";
const MARKERS = [PIN, PIN2, TAN, FINTS_PRODUCT_ID];
const actor = { userId: "user-1", name: "tester" };

let fake = new FakeFintsClient();
let prevSecret: string | undefined;
const logs: string[] = [];

const mkOrg = async (name: string, withProduct = true): Promise<string> => {
  const id = (await dbInternal.organization.create({ data: { legalName: `Einrichtung ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  if (withProduct) await saveBankFetchSettings(id, { productId: FINTS_PRODUCT_ID }, "tester");
  return id;
};
const connInput = (over: Record<string, unknown> = {}) => ({ label: "Testzugang", bankCode: FINTS_BLZ, url: FINTS_URL, userId: FINTS_USER, ...over });
const mkConn = (orgId: string, over: Record<string, unknown> = {}) => createBankConnection(orgId, connInput(over), "tester", NOW);
const rowOf = (id: string) => dbInternal.bankConnection.findUniqueOrThrow({ where: { id } });

beforeAll(() => {
  prevSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "kontoabruf-test-secret-0123456789";
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});
beforeEach(() => {
  fake = new FakeFintsClient();
  holder.client = fake;
  logs.length = 0;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => String(x)).join(" "));
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sweepSessions(Date.UTC(2300, 0, 1));
});

describe("Einstellungen", () => {
  it("ohne Produkt-ID kein Bankzugang und keine Anmeldung", async () => {
    const orgId = await mkOrg("OhneProdukt", false);
    await expect(mkConn(orgId)).rejects.toMatchObject({ code: "PRODUCT_ID_MISSING" });
    const row = await dbInternal.bankConnection.create({ data: { orgId, label: "x", bankCode: FINTS_BLZ, url: FINTS_URL, userId: FINTS_USER }, select: { id: true } });
    await expect(connectBankConnection(orgId, row.id, { pin: PIN }, actor, NOW)).rejects.toBeInstanceOf(BankFetchError);
    await expect(connectBankConnection(orgId, row.id, { pin: PIN }, actor, NOW)).rejects.toMatchObject({ code: "PRODUCT_ID_MISSING" });
    expect(fake.opens).toHaveLength(0);
  });

  it("gibt die Produkt-ID nie aus und protokolliert nur Feldnamen", async () => {
    const orgId = await mkOrg("Settings");
    const view = await loadBankFetchSettings(orgId);
    expect(view).toEqual({ productIdConfigured: true, autoHour: 6, firstFetchDays: 30 });
    expect(JSON.stringify(view)).not.toContain(FINTS_PRODUCT_ID);
    await saveBankFetchSettings(orgId, { autoHour: 7, firstFetchDays: 60 }, "tester");
    expect(await loadBankFetchSettings(orgId)).toEqual({ productIdConfigured: true, autoHour: 7, firstFetchDays: 60 });
    const log = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "BANK_CONNECTION" } });
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain(FINTS_PRODUCT_ID);
    await saveBankFetchSettings(orgId, { productId: null }, "tester");
    expect((await loadBankFetchSettings(orgId)).productIdConfigured).toBe(false);
  });

  it("lehnt ungueltige Werte und unbekannte Felder ab", async () => {
    const orgId = await mkOrg("SettingsBad");
    await expect(saveBankFetchSettings(orgId, { productId: "kurz" }, "t")).rejects.toThrow();
    await expect(saveBankFetchSettings(orgId, { autoHour: 24 }, "t")).rejects.toThrow();
    await expect(saveBankFetchSettings(orgId, { firstFetchDays: 90 }, "t")).rejects.toThrow();
    await expect(saveBankFetchSettings(orgId, { productId: FINTS_PRODUCT_ID, extra: 1 }, "t")).rejects.toThrow();
  });
});

describe("Bankzugaenge", () => {
  it("legt hoechstens drei an, archivierte zaehlen nicht", async () => {
    const orgId = await mkOrg("Limit");
    const a = await mkConn(orgId, { label: "A" });
    await mkConn(orgId, { label: "B" });
    await mkConn(orgId, { label: "C" });
    await expect(mkConn(orgId, { label: "D" })).rejects.toMatchObject({ code: "LIMIT_CONNECTIONS" });
    await archiveBankConnection(orgId, a.id, "tester", NOW);
    await expect(mkConn(orgId, { label: "D" })).resolves.toBeTruthy();
  });

  it("lehnt Adressen ausser https ab und speichert normalisiert", async () => {
    const orgId = await mkOrg("Url");
    await expect(mkConn(orgId, { url: "http://fints.example.org/fints" })).rejects.toThrow();
    await expect(mkConn(orgId, { url: "https://fints.example.org:8443/fints" })).rejects.toThrow();
    await expect(mkConn(orgId, { bankCode: "123" })).rejects.toThrow();
    const v = await mkConn(orgId, { url: "https://FINTS.example.org/fints" });
    expect(v.url).toBe("https://fints.example.org/fints");
  });

  it("Zugangsdaten ohne Zugriff durch fremde Firmen (404)", async () => {
    const a = await mkOrg("OrgA");
    const b = await mkOrg("OrgB");
    const v = await mkConn(a);
    await expect(getBankConnection(b, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateBankConnection(b, v.id, { label: "x" }, "t")).rejects.toBeInstanceOf(NotFoundError);
    await expect(archiveBankConnection(b, v.id, "t")).rejects.toBeInstanceOf(NotFoundError);
    await expect(setStoredPin(b, v.id, { pin: PIN, confirm: true }, "t")).rejects.toBeInstanceOf(NotFoundError);
    await expect(connectBankConnection(b, v.id, { pin: PIN }, actor, NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listBankConnections(b)).toEqual([]);
  });

  it("Archivieren leert Zugangsdaten und Bankdaten, das Protokoll bleibt", async () => {
    const orgId = await mkOrg("Archiv");
    const v = await mkConn(orgId);
    await setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", NOW);
    fake.syncAnswers.push(done(syncResult()));
    await connectBankConnection(orgId, v.id, {}, actor, NOW);
    const run = await dbInternal.bankFetchRun.create({
      data: { orgId, connectionId: v.id, trigger: "MANUAL", startedAt: NOW, finishedAt: NOW, result: "OK", actor: "tester" },
      select: { id: true },
    });
    await archiveBankConnection(orgId, v.id, "tester", NOW);
    const row = await rowOf(v.id);
    expect(row).toMatchObject({ pinEnc: null, bankingInfoJson: null, rejectedPinHmac: null, autoEnabled: false, state: "ARCHIVED" });
    expect(row.archivedAt).not.toBeNull();
    expect(await dbInternal.bankFetchRun.count({ where: { id: run.id } })).toBe(1);
    expect(await dbInternal.bankConnectionAccount.count({ where: { connectionId: v.id, selected: true } })).toBe(0);
    await expect(getBankConnection(orgId, v.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("PIN-Modi", () => {
  it("speichert die PIN nur verschluesselt und nur mit Bestaetigung", async () => {
    const orgId = await mkOrg("Pin");
    const v = await mkConn(orgId);
    await expect(setStoredPin(orgId, v.id, { pin: PIN }, "tester", NOW)).rejects.toThrow();
    await expect(setStoredPin(orgId, v.id, { pin: PIN, confirm: false }, "tester", NOW)).rejects.toThrow();
    expect((await rowOf(v.id)).pinEnc).toBeNull();
    await setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", NOW);
    const row = await rowOf(v.id);
    expect(row.pinEnc?.startsWith("v1:")).toBe(true);
    expect(row.pinMode).toBe("STORED");
    const view = await getBankConnection(orgId, v.id);
    expect(view.hasPin).toBe(true);
    expect(JSON.stringify(view)).not.toContain(PIN);
  });

  it("Aenderung der Kennung entwertet PIN, Freigabe und Bankdaten; Zurueck auf PIN je Abruf entfernt die PIN", async () => {
    const orgId = await mkOrg("Wechsel");
    const v = await mkConn(orgId);
    await setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", NOW);
    await dbInternal.bankConnection.update({ where: { id: v.id }, data: { autoEnabled: true, state: "READY", bankingInfoJson: "v1:x:y:z", tanMethodId: 923 } });
    const after = await updateBankConnection(orgId, v.id, { userId: "kunde4712" }, "tester", NOW);
    expect(after).toMatchObject({ hasPin: false, pinMode: "PER_FETCH", autoEnabled: false, state: "NEW", tanMethodId: null, userId: "kunde4712" });
    expect((await rowOf(v.id)).bankingInfoJson).toBeNull();
    await setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", NOW);
    const back = await updateBankConnection(orgId, v.id, { pinMode: "PER_FETCH" }, "tester", NOW);
    expect(back).toMatchObject({ hasPin: false, pinMode: "PER_FETCH" });
    // reine Beschriftung aendert nichts an den Zugangsdaten
    await setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", NOW);
    expect((await updateBankConnection(orgId, v.id, { label: "Neu" }, "tester", NOW)).hasPin).toBe(true);
  });

  it("eine abgelehnte PIN wird nie ohne ausdrueckliche Bestaetigung erneut gesendet", async () => {
    const orgId = await mkOrg("Abgelehnt");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(new FintsError("PIN_REJECTED", ["9931"]));
    await expect(connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW)).rejects.toMatchObject({ code: "PIN_REJECTED" });
    const row = await rowOf(v.id);
    expect(row).toMatchObject({ state: "PIN_REJECTED", autoEnabled: false, lastErrorCode: "PIN_REJECTED", authFailures: 1 });
    expect(row.rejectedPinHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rejectedPinHmac).not.toContain(PIN);
    expect(fake.sessions[0]?.closed).toBe(1);
    expect(row.leaseUntil).toBeNull();
    const log = await dbInternal.activityLog.findMany({ where: { orgId, type: "BANK_FETCH_PIN_REJECTED" } });
    expect(log).toHaveLength(1);

    const opens = fake.opens.length;
    await expect(connectBankConnection(orgId, v.id, { pin: PIN }, actor, at(1000))).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
    await expect(setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", NOW)).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
    expect(fake.opens.length).toBe(opens);

    // auch eine andere PIN braucht die Bestaetigung (zustandsbasiert)
    await expect(connectBankConnection(orgId, v.id, { pin: PIN2 }, actor, at(1500))).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
    expect(fake.opens.length).toBe(opens);
    fake.syncAnswers.push(done(syncResult()));
    await expect(connectBankConnection(orgId, v.id, { pin: PIN2, unlockConfirmed: true }, actor, at(2000))).resolves.toMatchObject({ state: "DONE" });
    expect((await rowOf(v.id)).state).toBe("NEW");

    // mit Bestaetigung ist dieselbe PIN wieder moeglich
    await setStoredPin(orgId, v.id, { pin: PIN, confirm: true, unlockConfirmed: true }, "tester", NOW);
    const unlocked = await rowOf(v.id);
    expect(unlocked.rejectedPinHmac).toBeNull();
    expect(unlocked.state).toBe("NEW");
  });

  it("ein unklarer Anmeldefehler schaltet aus und sperrt dieselbe PIN", async () => {
    const orgId = await mkOrg("Unklar");
    const v = await mkConn(orgId);
    await setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", NOW);
    fake.syncAnswers.push(new FintsError("AUTH_UNCLEAR", ["9010"]));
    await expect(connectBankConnection(orgId, v.id, {}, actor, NOW)).rejects.toMatchObject({ code: "AUTH_UNCLEAR" });
    expect(await rowOf(v.id)).toMatchObject({ state: "AUTH_UNCLEAR", autoEnabled: false });
    await expect(connectBankConnection(orgId, v.id, {}, actor, at(5000))).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
  });

  it("nach Schluesselwechsel bleibt die Sperre bestehen (Zustand, nicht HMAC)", async () => {
    const orgId = await mkOrg("Schluessel");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(new FintsError("PIN_REJECTED", ["9931"]));
    await expect(connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW)).rejects.toMatchObject({ code: "PIN_REJECTED" });
    const secret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "anderer-schluessel-test-0123456789";
    try {
      expect(pinHmac(PIN)).not.toBe((await rowOf(v.id)).rejectedPinHmac);
      const opens = fake.opens.length;
      await expect(connectBankConnection(orgId, v.id, { pin: PIN }, actor, at(1000))).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
      await expect(setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", at(1000))).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
      expect(fake.opens.length).toBe(opens);
    } finally {
      process.env.AUTH_SECRET = secret;
    }
  });

  it("von der Bank gesperrter Zugang: nur die ausdrueckliche Entsperr-Bestaetigung, nie eine neue PIN allein", async () => {
    const orgId = await mkOrg("Gesperrt");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(new FintsError("ACCESS_LOCKED", ["9931"]));
    await expect(connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW)).rejects.toMatchObject({ code: "ACCESS_LOCKED" });
    const opens = fake.opens.length;
    await expect(setStoredPin(orgId, v.id, { pin: PIN2, confirm: true }, "tester", at(1000))).rejects.toMatchObject({ code: "ACCESS_LOCKED" });
    await expect(setStoredPin(orgId, v.id, { pin: PIN2, confirm: true, unlockConfirmed: true }, "tester", at(1000))).rejects.toMatchObject({ code: "ACCESS_LOCKED" });
    await expect(connectBankConnection(orgId, v.id, { pin: PIN2, unlockConfirmed: true }, actor, at(1000))).rejects.toMatchObject({ code: "ACCESS_LOCKED" });
    expect(fake.opens.length).toBe(opens);
    expect((await rowOf(v.id)).state).toBe("PIN_REJECTED");
    // eine voruebergehende Stoerung hebt die Sperre nicht auf
    fake.syncAnswers.push(new FintsError("TIMEOUT"));
    await expect(connectBankConnection(orgId, v.id, { pin: PIN2, bankUnlockConfirmed: true }, actor, at(2000))).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(connectBankConnection(orgId, v.id, { pin: PIN2, unlockConfirmed: true }, actor, at(3000))).rejects.toMatchObject({ code: "ACCESS_LOCKED" });
    await setStoredPin(orgId, v.id, { pin: PIN2, confirm: true, bankUnlockConfirmed: true }, "tester", at(4000));
    expect(await rowOf(v.id)).toMatchObject({ state: "NEW", lastErrorCode: null, rejectedPinHmac: null });
  });

  it("zwei parallele Aufrufe: der zweite sieht die Ablehnung des ersten nie als veraltet", async () => {
    const orgId = await mkOrg("Parallel");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(new FintsError("PIN_REJECTED", ["9931"]));
    const results = await Promise.allSettled([
      connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW),
      connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW),
    ]);
    expect(fake.opens).toHaveLength(1);
    const codes = results.map((r) => (r.status === "rejected" ? (r.reason as { code?: string }).code : "ok")).sort();
    // je nach Ablauf: Sperre gehalten (BUSY) oder Ablehnung des ersten bereits sichtbar; nie ein zweiter Bankkontakt
    expect(codes).toContain("PIN_REJECTED");
    expect(["BUSY", "PIN_PREVIOUSLY_REJECTED"]).toContain(codes.find((c) => c !== "PIN_REJECTED"));
    await expect(connectBankConnection(orgId, v.id, { pin: PIN }, actor, at(1000))).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
    expect(fake.opens).toHaveLength(1);
  });

  it("die Sperre gibt nur ihr Besitzer frei", async () => {
    const orgId = await mkOrg("Besitzer");
    const v = await mkConn(orgId);
    const first = await acquireLease(orgId, v.id, NOW);
    expect(first).not.toBeNull();
    expect(await acquireLease(orgId, v.id, at(1000))).toBeNull();
    // abgelaufen: ein anderer erwirbt, die alte Kennung gibt nichts mehr frei
    const second = await acquireLease(orgId, v.id, at(11 * 60_000));
    expect(second).not.toBeNull();
    await releaseLease(orgId, v.id, first as Date);
    expect((await rowOf(v.id)).leaseUntil).toEqual(second);
    await releaseLease(orgId, v.id, second as Date);
    expect((await rowOf(v.id)).leaseUntil).toBeNull();
  });

  it("Archivieren bei laufendem Vorgang: BUSY; danach schreibt kein Ergebnis auf den archivierten Zugang", async () => {
    const orgId = await mkOrg("ArchivBusy");
    const v = await mkConn(orgId);
    fake.syncAnswers.push({ kind: "sca", challenge: { decoupled: false, text: "TAN eingeben", image: null, waitFirstMs: 0, waitNextMs: 0, maxPolls: 0 } });
    const res = await connectBankConnection(orgId, v.id, { pin: PIN, tanMethodId: 920 }, actor, NOW);
    if (res.state !== "SCA") throw new Error("SCA erwartet");
    await expect(archiveBankConnection(orgId, v.id, "tester", at(1000))).rejects.toMatchObject({ code: "BUSY" });
    expect((await rowOf(v.id)).archivedAt).toBeNull();
    fake.sessions[0]?.continueAnswersPush(done(syncResult(), true));
    await continueSetup(orgId, res.token, { tan: TAN }, actor, at(10));
    await archiveBankConnection(orgId, v.id, "tester", at(2000));
    // ein spaet eintreffendes Ergebnis veraendert den archivierten Zugang nicht
    const before = await rowOf(v.id);
    const { applyAuthOutcome } = await import("@/domain/bank-fetch/connections");
    await applyAuthOutcome(orgId, v.id, { ok: false, error: new FintsError("PIN_REJECTED"), pinHmac: pinHmac(PIN) }, "t", at(3000));
    await applyAuthOutcome(orgId, v.id, { ok: true, scaUsed: true }, "t", at(3000));
    expect(await rowOf(v.id)).toEqual(before);
  });

  it("Erfolg der Einrichtung bleibt NEW, ein manueller Abruf macht den Zugang bereit", () => {
    expect(authOutcomeData("NEW", { ok: true, scaUsed: false }, NOW)).toMatchObject({ state: "NEW" });
    expect(authOutcomeData("NEW", { ok: true, scaUsed: false, manualFetch: true }, NOW)).toMatchObject({ state: "READY" });
  });

  it("TAN-Bild nur als PNG, JPEG oder GIF; sonst verworfen mit Hinweis", () => {
    const base = { decoupled: false, text: "x", waitFirstMs: 0, waitNextMs: 0, maxPolls: 0 };
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toPublicChallenge({ ...base, image: { mime: "image/png", bytes } }, 0)).toMatchObject({ imageOmitted: false });
    expect(toPublicChallenge({ ...base, image: { mime: "image/svg+xml" as "image/png", bytes } }, 0)).toMatchObject({ imageDataUrl: null, imageOmitted: true });
    expect(toPublicChallenge({ ...base, image: { mime: "text/html" as "image/png", bytes } }, 0).imageDataUrl).toBeNull();
    expect(toPublicChallenge({ ...base, image: null }, 0)).toMatchObject({ imageOmitted: false });
  });

  it("voruebergehende Fehler lassen den Zugang unveraendert und merken nur den Code", async () => {
    const orgId = await mkOrg("Netz");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(new FintsError("TIMEOUT"));
    await expect(connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW)).rejects.toMatchObject({ code: "TIMEOUT" });
    const row = await rowOf(v.id);
    expect(row).toMatchObject({ state: "NEW", lastErrorCode: "TIMEOUT", rejectedPinHmac: null, transientFailuresToday: 1 });
  });
});

describe("Einrichtung", () => {
  it("ohne Freigabe: Konten und verschluesselte Bankdaten", async () => {
    const orgId = await mkOrg("Ohne");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(done(syncResult()));
    const res = await connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW);
    expect(res.state).toBe("DONE");
    if (res.state !== "DONE") return;
    expect(res.view.accounts).toHaveLength(2);
    expect(res.view.state).toBe("NEW");
    expect(res.view.lastSuccessAt).toEqual(NOW);
    expect(res.view.lastScaAt).toBeNull();
    const row = await rowOf(v.id);
    expect(row.bankingInfoJson?.startsWith("v1:")).toBe(true);
    expect(row.bankingInfoJson).not.toContain("Mustermann");
    expect(row.bankingInfoJson).not.toContain("DE89370400440532013000");
    expect(row.leaseUntil).toBeNull();
    expect(fake.opens[0]).toMatchObject({ productId: FINTS_PRODUCT_ID, userId: FINTS_USER, bankCode: FINTS_BLZ, pin: PIN, bankingInfo: null });
    expect(fake.sessions[0]?.closed).toBe(1);
    // zweiter Lauf liest die Bankdaten entschluesselt zurueck
    fake.syncAnswers.push(done(syncResult()));
    await connectBankConnection(orgId, v.id, { pin: PIN }, actor, at(1000));
    expect(fake.opens[1]?.bankingInfo).toContain("Mustermann");
    expect(await dbInternal.bankConnectionAccount.count({ where: { connectionId: v.id } })).toBe(2);
  });

  it("Konten werden fortgeschrieben, nie geloescht; nicht mehr gemeldete verlieren Abruf und Auswahl", async () => {
    const orgId = await mkOrg("Fortschreiben");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(done(syncResult()));
    await connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW);
    const all = await dbInternal.bankConnectionAccount.findMany({ where: { connectionId: v.id }, select: { id: true, iban: true } });
    await selectAccounts(orgId, v.id, { accountIds: all.map((a) => a.id) }, "tester", NOW);
    const [first] = syncResult().accounts;
    if (!first) throw new Error("Fixture");
    fake.syncAnswers.push(done(syncResult({ accounts: [{ ...first, productName: "Umbenannt" }] })));
    await connectBankConnection(orgId, v.id, { pin: PIN }, actor, at(1000));
    const rows = await dbInternal.bankConnectionAccount.findMany({ where: { connectionId: v.id }, orderBy: { iban: "asc" } });
    expect(rows).toHaveLength(2);
    const gone = rows.find((r) => r.iban === "DE02120300000000202051");
    const kept = rows.find((r) => r.iban === first.iban);
    expect(gone).toMatchObject({ camtSupported: false, selected: false });
    expect(kept).toMatchObject({ camtSupported: true, selected: true, productName: "Umbenannt" });
  });

  it("laesst ein Verfahren waehlen (Freigabe in der App zuerst) und fuehrt dann die Anmeldung aus", async () => {
    const orgId = await mkOrg("Verfahren");
    const v = await mkConn(orgId);
    const methods = [
      { id: 920, name: "Foto", decoupled: false, media: [], mediaRequired: false },
      { id: 923, name: "App", decoupled: true, media: ["Handy"], mediaRequired: true },
    ];
    fake.syncAnswers.push(done(syncResult({ tanMethods: methods })));
    const first = await connectBankConnection(orgId, v.id, { pin: PIN }, actor, NOW);
    expect(first.state).toBe("CHOOSE_TAN_METHOD");
    if (first.state !== "CHOOSE_TAN_METHOD") return;
    expect(first.methods.map((m) => m.id)).toEqual([923, 920]);
    expect((await rowOf(v.id)).bankingInfoJson?.startsWith("v1:")).toBe(true);
    expect(await dbInternal.bankConnectionAccount.count({ where: { connectionId: v.id } })).toBe(0);
    expect(fake.sessions[0]?.closed).toBe(1);

    fake.syncAnswers.push(done(syncResult({ tanMethods: methods })));
    const second = await connectBankConnection(orgId, v.id, { pin: PIN, tanMethodId: 923, tanMediaName: "Handy" }, actor, at(1000));
    expect(second.state).toBe("DONE");
    expect(fake.opens[1]).toMatchObject({ tanMethodId: 923, tanMediaName: "Handy" });
    expect(await rowOf(v.id)).toMatchObject({ tanMethodId: 923, tanMediaName: "Handy" });
  });

  it("mit Freigabe in der App: Token, zu fruehe Abfrage ohne Bankkontakt, dann fertig mit Zeitpunkt der Freigabe", async () => {
    const orgId = await mkOrg("Decoupled");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(decoupledChallenge({ waitFirstMs: 1000, waitNextMs: 1000 }));
    const res = await connectBankConnection(orgId, v.id, { pin: PIN, tanMethodId: 923 }, actor, NOW);
    expect(res.state).toBe("SCA");
    if (res.state !== "SCA") return;
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.challenge).toMatchObject({ decoupled: true, text: "Bitte in der App freigeben", imageDataUrl: null });
    expect(JSON.stringify(res)).not.toContain(PIN);
    const session = fake.sessions[0];
    expect(session).toBeDefined();
    // Sperre gehalten: kein zweiter Dialog fuer denselben Zugang
    await expect(connectBankConnection(orgId, v.id, { pin: PIN }, actor, at(1))).rejects.toMatchObject({ code: "BUSY" });
    expect(fake.opens).toHaveLength(1);

    const early = await continueSetup(orgId, res.token, {}, actor, at(500));
    expect(early.state).toBe("SCA");
    expect(session?.continueCalls).toBe(0);

    session?.continueAnswersPush(done(syncResult(), true));
    const fin = await continueSetup(orgId, res.token, {}, actor, at(3000));
    expect(fin.state).toBe("DONE");
    if (fin.state !== "DONE") return;
    expect(fin.view.lastScaAt).toEqual(at(3000));
    expect(fin.view.accounts).toHaveLength(2);
    expect(session?.closed).toBe(1);
    expect((await rowOf(v.id)).leaseUntil).toBeNull();
    // Token ist verbraucht
    await expect(continueSetup(orgId, res.token, {}, actor, at(4000))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Freigabe per TAN: Format wird geprueft, die Sitzung bleibt offen", async () => {
    const orgId = await mkOrg("Tan");
    const v = await mkConn(orgId);
    fake.syncAnswers.push({ kind: "sca", challenge: { decoupled: false, text: "TAN eingeben", image: { mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }, waitFirstMs: 0, waitNextMs: 0, maxPolls: 0 } });
    const res = await connectBankConnection(orgId, v.id, { pin: PIN, tanMethodId: 920 }, actor, NOW);
    if (res.state !== "SCA") throw new Error("SCA erwartet");
    expect(res.challenge.imageDataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    await expect(continueSetup(orgId, res.token, {}, actor, at(10))).rejects.toMatchObject({ code: "TAN_FORMAT" });
    await expect(continueSetup(orgId, res.token, { tan: "12 34" }, actor, at(20))).rejects.toMatchObject({ code: "TAN_FORMAT" });
    expect(fake.sessions[0]?.continueCalls).toBe(0);
    fake.sessions[0]?.continueAnswersPush(done(syncResult(), true));
    const fin = await continueSetup(orgId, res.token, { tan: TAN }, actor, at(30));
    expect(fin.state).toBe("DONE");
    expect(fake.sessions[0]?.tans).toEqual([TAN]);
  });

  it("fremde Firma oder anderer Benutzer sehen die Sitzung nicht (404), der Eigentuemer kann fortsetzen", async () => {
    const a = await mkOrg("SessA");
    const b = await mkOrg("SessB");
    const v = await mkConn(a);
    fake.syncAnswers.push(decoupledChallenge());
    const res = await connectBankConnection(a, v.id, { pin: PIN, tanMethodId: 923 }, actor, NOW);
    if (res.state !== "SCA") throw new Error("SCA erwartet");
    await expect(continueSetup(b, res.token, {}, actor, at(3000))).rejects.toBeInstanceOf(NotFoundError);
    await expect(continueSetup(a, res.token, {}, { userId: "user-2", name: "anderer" }, at(3000))).rejects.toBeInstanceOf(NotFoundError);
    await expect(continueSetup(a, "gibt-es-nicht", {}, actor, at(3000))).rejects.toBeInstanceOf(NotFoundError);
    fake.sessions[0]?.continueAnswersPush(done(syncResult(), true));
    await expect(continueSetup(a, res.token, {}, actor, at(3000))).resolves.toMatchObject({ state: "DONE" });
  });

  it("abgelaufene Sitzung: 404, Dialog beendet, Sperre frei", async () => {
    const orgId = await mkOrg("Ablauf");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(decoupledChallenge());
    const res = await connectBankConnection(orgId, v.id, { pin: PIN, tanMethodId: 923 }, actor, NOW);
    if (res.state !== "SCA") throw new Error("SCA erwartet");
    await expect(continueSetup(orgId, res.token, {}, actor, at(6 * 60_000))).rejects.toBeInstanceOf(NotFoundError);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.sessions[0]?.closed).toBeGreaterThanOrEqual(1);
    expect((await rowOf(v.id)).leaseUntil).toBeNull();
  });

  it("mehr Statusabfragen als erlaubt: SCA_TIMEOUT und Dialog beendet", async () => {
    const orgId = await mkOrg("Polls");
    const v = await mkConn(orgId);
    fake.syncAnswers.push(decoupledChallenge({ maxPolls: 1 }));
    const res = await connectBankConnection(orgId, v.id, { pin: PIN, tanMethodId: 923 }, actor, NOW);
    if (res.state !== "SCA") throw new Error("SCA erwartet");
    fake.sessions[0]?.continueAnswersPush(decoupledChallenge({ maxPolls: 1 }));
    const again = await continueSetup(orgId, res.token, {}, actor, at(3000));
    expect(again.state).toBe("SCA");
    await expect(continueSetup(orgId, res.token, {}, actor, at(6000))).rejects.toMatchObject({ code: "SCA_TIMEOUT" });
    expect(fake.sessions[0]?.closed).toBe(1);
    expect(fake.sessions[0]?.continueCalls).toBe(1);
    expect((await rowOf(v.id)).leaseUntil).toBeNull();
  });
});

describe("Kontoauswahl und automatischer Abruf", () => {
  async function connWithAccounts(orgId: string, label: string, n: number, camt = true): Promise<{ id: string; accountIds: string[] }> {
    const v = await mkConn(orgId, { label });
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const iban = `DE${String(10 + i).padStart(2, "0")}${label.charCodeAt(0)}${String(i).padStart(14, "0")}`.slice(0, 22);
      ids.push((await dbInternal.bankConnectionAccount.create({ data: { orgId, connectionId: v.id, iban, camtSupported: camt }, select: { id: true } })).id);
    }
    return { id: v.id, accountIds: ids };
  }

  it("hoechstens zehn ausgewaehlte Konten je Firma", async () => {
    const orgId = await mkOrg("Auswahl");
    const a = await connWithAccounts(orgId, "A", 6);
    const b = await connWithAccounts(orgId, "B", 5);
    await selectAccounts(orgId, a.id, { accountIds: a.accountIds }, "tester", NOW);
    await expect(selectAccounts(orgId, b.id, { accountIds: b.accountIds }, "tester", NOW)).rejects.toMatchObject({ code: "LIMIT_ACCOUNTS" });
    await expect(selectAccounts(orgId, b.id, { accountIds: b.accountIds.slice(0, 4) }, "tester", NOW)).resolves.toBeTruthy();
    // fremde Konto-Id
    await expect(selectAccounts(orgId, b.id, { accountIds: [a.accountIds[0] ?? ""] }, "tester", NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Konten ohne CAMT lassen sich nicht auswaehlen", async () => {
    const orgId = await mkOrg("OhneCamt");
    const a = await connWithAccounts(orgId, "C", 1, false);
    await expect(selectAccounts(orgId, a.id, { accountIds: a.accountIds }, "tester", NOW)).rejects.toMatchObject({ code: "ACCOUNT_NOT_SUPPORTED" });
  });

  it("automatischer Abruf nur mit gespeicherter PIN, Konto und Erfolg nach den letzten Zugangsdaten", async () => {
    const orgId = await mkOrg("Auto");
    const a = await connWithAccounts(orgId, "D", 1);
    await expect(setAutoEnabled(orgId, a.id, true, "tester", NOW)).rejects.toMatchObject({ code: "PIN_NOT_STORED" });
    await setStoredPin(orgId, a.id, { pin: PIN, confirm: true }, "tester", NOW);
    await expect(setAutoEnabled(orgId, a.id, true, "tester", NOW)).rejects.toMatchObject({ code: "NO_ACCOUNT_SELECTED" });
    await selectAccounts(orgId, a.id, { accountIds: a.accountIds }, "tester", NOW);
    await expect(setAutoEnabled(orgId, a.id, true, "tester", NOW)).rejects.toMatchObject({ code: "TEST_REQUIRED" });
    // Erfolg liegt vor den Zugangsdaten -> weiter gesperrt
    await dbInternal.bankConnection.update({ where: { id: a.id }, data: { state: "READY", lastSuccessAt: at(-3600_000), credentialsChangedAt: NOW } });
    await expect(setAutoEnabled(orgId, a.id, true, "tester", NOW)).rejects.toMatchObject({ code: "TEST_REQUIRED" });
    await dbInternal.bankConnection.update({ where: { id: a.id }, data: { lastSuccessAt: at(60_000) } });
    const v = await setAutoEnabled(orgId, a.id, true, "tester", NOW);
    expect(v.autoEnabled).toBe(true);
    const next = (await rowOf(a.id)).nextAutoAt;
    expect(next).not.toBeNull();
    expect(next && next.getTime() > NOW.getTime()).toBe(true);
    const off = await setAutoEnabled(orgId, a.id, false, "tester", NOW);
    expect(off.autoEnabled).toBe(false);
    expect((await rowOf(a.id)).nextAutoAt).toBeNull();
  });
});

describe("Keine Geheimnisse ausserhalb von pinEnc", () => {
  it("PIN, TAN und Produkt-ID stehen in keiner Zeile, keiner Antwort und keiner Konsolenausgabe", async () => {
    const orgId = await mkOrg("Suche");
    const v = await mkConn(orgId);
    await setStoredPin(orgId, v.id, { pin: PIN, confirm: true }, "tester", NOW);
    fake.syncAnswers.push({ kind: "sca", challenge: { decoupled: false, text: "TAN eingeben", image: null, waitFirstMs: 0, waitNextMs: 0, maxPolls: 0 } });
    const res = await connectBankConnection(orgId, v.id, { tanMethodId: 920 }, actor, NOW);
    if (res.state !== "SCA") throw new Error("SCA erwartet");
    fake.sessions[0]?.continueAnswersPush(done(syncResult(), true));
    const fin = await continueSetup(orgId, res.token, { tan: TAN }, actor, at(10));
    await selectAccounts(orgId, v.id, { accountIds: [] }, "tester", NOW);
    // Ablehnung mit PIN2 erzeugt den Ablehnungs-HMAC, nie den Klartext
    fake.syncAnswers.push(new FintsError("PIN_REJECTED", ["9931"]));
    await expect(connectBankConnection(orgId, v.id, { pin: PIN2 }, actor, at(20))).rejects.toBeInstanceOf(FintsError);

    const rows: unknown[] = [];
    for (const t of ["BankFetchSettings", "BankConnection", "BankConnectionAccount", "BankFetchRun", "ActivityLog", "ChangeLog", "Notification"]) {
      rows.push(await dbInternal.$queryRawUnsafe(`SELECT * FROM "${t}"`));
    }
    const dump = JSON.stringify(rows, (_k, val: unknown) => (typeof val === "bigint" ? val.toString() : val));
    const outputs = JSON.stringify([res, fin, await listBankConnections(orgId), await loadBankFetchSettings(orgId)]) + logs.join("\n");
    for (const m of [PIN, PIN2, TAN]) {
      expect(dump).not.toContain(m);
      expect(outputs).not.toContain(m);
    }
    expect(outputs).not.toContain(FINTS_PRODUCT_ID);
    // die Produkt-ID steht nur in BankFetchSettings
    const rest = JSON.stringify(rows.filter((_r, i) => i !== 0), (_k, val: unknown) => (typeof val === "bigint" ? val.toString() : val));
    expect(rest).not.toContain(FINTS_PRODUCT_ID);
    for (const m of MARKERS) expect(logs.join("\n")).not.toContain(m);
  });
});
