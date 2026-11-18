/**
 * Kontoabruf: manueller und automatischer Abruf, Zeitraum, Banksperre-Schutz, Job, Benachrichtigungen. Testjahr 2254.
 * Nie ein echtes Netz: das Bankprotokoll ist durch eine Attrappe ersetzt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal, prisma } from "@/lib/db";
import { berlinDateKey } from "@/lib/berlin-time";
import { decryptSecret, FINTS_BANKINFO_PURPOSE } from "@/lib/crypto/secrets";
import { FintsError, type FintsClient } from "@/lib/fints/client";
import { NotFoundError } from "@/domain/errors";
import { createBankConnection, selectAccounts, setAutoEnabled, setStoredPin } from "@/domain/bank-fetch/connections";
import { saveBankFetchSettings } from "@/domain/bank-fetch/settings";
import { connectBankConnection } from "@/domain/bank-fetch/setup";
import { cancelManualFetch, continueManualFetch, startManualFetch, type FetchOutcome } from "@/domain/bank-fetch/run";
import { runBankFetchJob } from "@/domain/bank-fetch/job";
import { sweepSessions } from "@/domain/bank-fetch/sessions";
import { sweepFetchSessions } from "@/domain/bank-fetch/run";
import { runScheduledJobs } from "@/domain/scheduler/runner";
import { camtDone, camtResult, decoupledChallenge, done, FakeFintsClient, syncResult } from "../helpers/fake-fints-client";
import { camtDocument, FINTS_BLZ, FINTS_IBAN, FINTS_IBAN_2, FINTS_OTHER_IBAN, FINTS_PRODUCT_ID, FINTS_URL, FINTS_USER } from "../helpers/fints-fixtures";

const holder = vi.hoisted(() => ({ client: null as unknown as FintsClient }));
vi.mock("@/domain/bank-fetch/client-factory", () => ({
  FINTS_PRODUCT_VERSION: "1.0",
  getFintsClient: () => holder.client,
}));

const NOW = new Date("2254-03-01T10:00:00.000Z");
/** Abstaende von zwei Minuten: ueber dem Mindestabstand manueller Abrufe. */
const t = (n: number) => new Date(NOW.getTime() + n * 120_000);
const PIN = "Pin-2254a";
const PIN2 = "Pin-2254b";
const TAN = "654321";
const MARKERS = [PIN, PIN2, TAN, FINTS_PRODUCT_ID, FINTS_USER];
const actor = { userId: "user-1", name: "tester" };

let fake = new FakeFintsClient();
let prevSecret: string | undefined;
const logs: string[] = [];
let seq = 0;

const mkOrg = async (name: string): Promise<string> => {
  const id = (await dbInternal.organization.create({ data: { legalName: `Abruf ${name} GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" }, select: { id: true } })).id;
  await saveBankFetchSettings(id, { productId: FINTS_PRODUCT_ID }, "tester");
  return id;
};
const doc = (iban: string, tag: string) => camtDocument(iban, `${tag}-${++seq}`);
/** Antworten fuer beide Konten (Reihenfolge nach IBAN aufsteigend). */
const pushBoth = (tag: string) => fake.camtAnswers.push(camtDone([doc(FINTS_IBAN_2, tag)]), camtDone([doc(FINTS_IBAN, tag)]));
const rowOf = (id: string) => dbInternal.bankConnection.findUniqueOrThrow({ where: { id } });
const runsOf = (id: string) => dbInternal.bankFetchRun.findMany({ where: { connectionId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const done_ = (o: FetchOutcome) => {
  if (o.state !== "DONE") throw new Error("Freigabe erwartet");
  return o.runs;
};

/** Eingerichteter Zugang mit zwei Konten, gespeicherter PIN, erfolgreichem manuellem Abruf und eingeschaltetem Abruf. */
async function mkReady(name: string, opts: { auto?: boolean } = {}): Promise<{ orgId: string; id: string }> {
  const orgId = await mkOrg(name);
  const conn = await createBankConnection(orgId, { label: "Testzugang", bankCode: FINTS_BLZ, url: FINTS_URL, userId: FINTS_USER }, "tester", NOW);
  fake.syncAnswers.push(done(syncResult()));
  const set = await connectBankConnection(orgId, conn.id, { pin: PIN }, actor, NOW);
  if (set.state !== "DONE") throw new Error("Einrichtung erwartet");
  await selectAccounts(orgId, conn.id, { accountIds: set.view.accounts.map((a) => a.id) }, "tester", NOW);
  await setStoredPin(orgId, conn.id, { pin: PIN, confirm: true }, "tester", NOW);
  pushBoth(`seed-${name}`);
  done_(await startManualFetch(orgId, conn.id, {}, actor, t(1)));
  if (opts.auto !== false) {
    await setAutoEnabled(orgId, conn.id, true, "tester", t(1));
    await dbInternal.bankConnection.update({ where: { id: conn.id }, data: { nextAutoAt: new Date(NOW.getTime() - 1000) }, select: { id: true } });
  }
  return { orgId, id: conn.id };
}

beforeAll(() => {
  prevSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "kontoabruf-lauf-secret-0123456789";
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
});
beforeEach(async () => {
  fake = new FakeFintsClient();
  holder.client = fake;
  logs.length = 0;
  // Zugaenge anderer Testdateien duerfen vom Job nicht erfasst werden.
  await dbInternal.bankConnection.updateMany({ data: { autoEnabled: false } });
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => String(x)).join(" "));
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sweepSessions(Date.UTC(2400, 0, 1));
});

describe("manueller Abruf", () => {
  it("importiert beide Konten, das erste Mal macht den Zugang bereit, Bankdaten werden aktualisiert", async () => {
    const orgId = await mkOrg("Manuell");
    const conn = await createBankConnection(orgId, { label: "Z", bankCode: FINTS_BLZ, url: FINTS_URL, userId: FINTS_USER }, "tester", NOW);
    fake.syncAnswers.push(done(syncResult()));
    const set = await connectBankConnection(orgId, conn.id, { pin: PIN }, actor, NOW);
    if (set.state !== "DONE") throw new Error("x");
    await selectAccounts(orgId, conn.id, { accountIds: set.view.accounts.map((a) => a.id) }, "tester", NOW);
    expect((await rowOf(conn.id)).state).toBe("NEW");
    fake.info = '{"bpd":{"version":2},"upd":{"bankAccounts":[]},"systemId":"S4712"}';
    pushBoth("manuell");
    const runs = done_(await startManualFetch(orgId, conn.id, { pin: PIN }, actor, t(1)));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.result === "OK" && r.importedCount === 1 && r.scaUsed === false)).toBe(true);
    const row = await rowOf(conn.id);
    expect(row).toMatchObject({ state: "READY", authFailures: 0, lastErrorCode: null, leaseUntil: null, lastScaAt: null });
    expect(row.lastSuccessAt).not.toBeNull();
    expect(decryptSecret(row.bankingInfoJson ?? "", FINTS_BANKINFO_PURPOSE)).toBe(fake.info);
    const imports = await dbInternal.bankStatementImport.findMany({ where: { orgId }, select: { origin: true, importedCount: true } });
    expect(imports).toEqual([{ origin: "FINTS", importedCount: 1 }, { origin: "FINTS", importedCount: 1 }]);
    const accs = await dbInternal.bankConnectionAccount.findMany({ where: { connectionId: conn.id }, select: { lastFetchedTo: true } });
    expect(accs.every((a) => a.lastFetchedTo !== null && berlinDateKey(a.lastFetchedTo) === "2254-03-01")).toBe(true);
    const rows = await runsOf(conn.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ trigger: "MANUAL", result: "OK", actor: "tester", documents: 1, importedCount: 1 });
    expect(fake.sessions.every((s) => s.closed >= 1)).toBe(true);
  });

  it("Startdatum begrenzt den Zeitraum, ein zweiter Abruf nach einer Minute ist erlaubt, davor nicht", async () => {
    const { orgId, id } = await mkReady("Zeitraum", { auto: false });
    fake.fetches.length = 0;
    pushBoth("zeitraum");
    await expect(startManualFetch(orgId, id, { from: "2254-01-01" }, actor, new Date(t(1).getTime() + 30_000))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fake.fetches).toHaveLength(0);
    done_(await startManualFetch(orgId, id, { from: "2254-01-01" }, actor, t(2)));
    expect(fake.fetches.map((f) => f.from)).toEqual(["2254-01-01", "2254-01-01"]);
    expect(fake.fetches.every((f) => f.to === "2254-03-01")).toBe(true);
    await expect(startManualFetch(orgId, id, { from: "2254-02-30" }, actor, t(5))).rejects.toThrow();
  });

  it("derselbe Dokumentsatz ist nichts Neues und kein Fehler", async () => {
    const { orgId, id } = await mkReady("Doppelt", { auto: false });
    const a = doc(FINTS_IBAN_2, "same");
    const b = doc(FINTS_IBAN, "same");
    fake.camtAnswers.push(camtDone([a]), camtDone([b]));
    done_(await startManualFetch(orgId, id, {}, actor, t(2)));
    fake.camtAnswers.push(camtDone([a]), camtDone([b]));
    const runs = done_(await startManualFetch(orgId, id, {}, actor, t(4)));
    expect(runs.map((r) => [r.result, r.importedCount])).toEqual([["OK", 0], ["OK", 0]]);
    expect(await rowOf(id)).toMatchObject({ authFailures: 0, lastErrorCode: null, state: "READY" });
  });

  it("Freigabe in der App: Token, Fortsetzen, weitere Konten, lastScaAt", async () => {
    const { orgId, id } = await mkReady("Decoupled", { auto: false });
    fake.camtAnswers.push(decoupledChallenge(), camtDone([doc(FINTS_IBAN, "dec")]));
    fake.continueAnswers.push(camtDone([doc(FINTS_IBAN_2, "dec")], true));
    const first = await startManualFetch(orgId, id, {}, actor, t(2));
    if (first.state !== "SCA") throw new Error("Freigabe erwartet");
    expect(first.challenge.decoupled).toBe(true);
    expect((await rowOf(id)).leaseUntil).not.toBeNull();
    // zu frueh: kein Bankkontakt
    const wait = await continueManualFetch(orgId, first.token, {}, actor, t(2));
    expect(wait.state).toBe("SCA");
    expect(fake.sessions.at(-1)?.continueCalls).toBe(0);
    const fin = await continueManualFetch(orgId, first.token, {}, actor, new Date(t(2).getTime() + 3000));
    const runs = done_(fin);
    expect(runs.map((r) => r.result)).toEqual(["OK", "OK"]);
    expect(runs[0]?.scaUsed).toBe(true);
    const row = await rowOf(id);
    expect(row.lastScaAt).not.toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(row.state).toBe("READY");
    await expect(continueManualFetch(orgId, first.token, {}, actor, t(3))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Abbrechen beendet den Dialog und vermerkt SCA_CANCELLED", async () => {
    const { orgId, id } = await mkReady("Abbruch", { auto: false });
    fake.camtAnswers.push(decoupledChallenge());
    const first = await startManualFetch(orgId, id, {}, actor, t(2));
    if (first.state !== "SCA") throw new Error("Freigabe erwartet");
    const session = fake.sessions.at(-1)!;
    const before = session.closed;
    await cancelManualFetch(orgId, first.token, actor, t(2));
    expect(session.closed).toBeGreaterThan(before);
    const rows = await runsOf(id);
    expect(rows.at(-1)).toMatchObject({ result: "SCA_CANCELLED", trigger: "MANUAL" });
    expect(await rowOf(id)).toMatchObject({ leaseUntil: null, state: "READY" });
    await expect(cancelManualFetch(orgId, first.token, actor, t(3))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("zwei gleichzeitige Abrufe: einer ist BUSY", async () => {
    const { orgId, id } = await mkReady("Parallel", { auto: false });
    let release: () => void = () => undefined;
    fake.gate.wait = new Promise<void>((res) => {
      release = res;
    });
    pushBoth("parallel");
    const p1 = startManualFetch(orgId, id, {}, actor, t(2));
    const p2 = startManualFetch(orgId, id, {}, actor, t(2));
    const settled = Promise.allSettled([p1, p2]);
    await new Promise((r) => setTimeout(r, 400));
    release();
    const res = await settled;
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = res.find((r) => r.status === "rejected");
    expect(rej && rej.status === "rejected" && (rej.reason as { code?: string }).code).toBe("BUSY");
  });

  it("Konto ohne Umsatzabruf wird uebersprungen, ein fremdes Dokument importiert nichts", async () => {
    const { orgId, id } = await mkReady("Konten", { auto: false });
    const acc = await dbInternal.bankConnectionAccount.findFirstOrThrow({ where: { connectionId: id, iban: FINTS_IBAN_2 }, select: { id: true } });
    await dbInternal.bankConnectionAccount.update({ where: { id: acc.id }, data: { camtSupported: false }, select: { id: true } });
    fake.fetches.length = 0;
    fake.camtAnswers.push(camtDone([camtDocument(FINTS_OTHER_IBAN, "fremd")]));
    const runs = done_(await startManualFetch(orgId, id, {}, actor, t(2)));
    expect(fake.fetches.map((f) => f.iban)).toEqual([FINTS_IBAN]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ result: "ACCOUNT_MISMATCH", importedCount: 0, importId: null });
    const a = await dbInternal.bankConnectionAccount.findFirstOrThrow({ where: { connectionId: id, iban: FINTS_IBAN }, select: { lastFetchedTo: true } });
    expect(a.lastFetchedTo).not.toBeNull(); // Stand vom ersten Abruf, nicht fortgeschrieben
    expect(berlinDateKey(a.lastFetchedTo!)).toBe("2254-03-01");
    const imports = await dbInternal.bankStatementImport.count({ where: { orgId, origin: "FINTS" } });
    expect(imports).toBe(2); // nur die beiden des ersten Abrufs
    expect((await rowOf(id)).state).toBe("ERROR");
  });

  it("zu viele und zu grosse Dokumente werden vor dem Lesen abgelehnt", async () => {
    const { orgId, id } = await mkReady("Grenzen", { auto: false });
    const tiny = new Uint8Array(1);
    fake.camtAnswers.push({ kind: "done", value: { documents: Array.from({ length: 401 }, () => tiny), bytes: 401 }, scaUsed: false, bankCodes: [] }, camtDone([]));
    const r1 = done_(await startManualFetch(orgId, id, {}, actor, t(2)));
    expect(r1[0]?.result).toBe("TOO_MANY_DOCUMENTS");
    expect(r1[0]?.importedCount).toBe(0);
    const big = new Uint8Array(11 * 1024 * 1024);
    fake.camtAnswers.push({ kind: "done", value: { documents: [big, big, big, big, big, big], bytes: big.length * 6 }, scaUsed: false, bankCodes: [] }, camtDone([]));
    const r2 = done_(await startManualFetch(orgId, id, {}, actor, t(4)));
    expect(r2[0]?.result).toBe("DOCUMENTS_TOO_LARGE");
  });

  it("Org B sieht und steuert nichts von Org A", async () => {
    const a = await mkReady("OrgA", { auto: false });
    const orgB = await mkOrg("OrgB");
    await expect(startManualFetch(orgB, a.id, {}, actor, t(2))).rejects.toBeInstanceOf(NotFoundError);
    fake.camtAnswers.push(decoupledChallenge());
    const first = await startManualFetch(a.orgId, a.id, {}, actor, t(2));
    if (first.state !== "SCA") throw new Error("Freigabe erwartet");
    await expect(continueManualFetch(orgB, first.token, {}, actor, t(2))).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelManualFetch(orgB, first.token, actor, t(2))).rejects.toBeInstanceOf(NotFoundError);
    await expect(continueManualFetch(a.orgId, first.token, {}, { userId: "user-2", name: "anderer" }, t(2))).rejects.toBeInstanceOf(NotFoundError);
    await cancelManualFetch(a.orgId, first.token, actor, t(2));
    expect(await dbInternal.bankFetchRun.count({ where: { orgId: orgB } })).toBe(0);
  });

  it("Lauf-Zeilen sind unveraenderlich", async () => {
    const { id } = await mkReady("Unveraenderlich", { auto: false });
    const rows = await runsOf(id);
    await expect(prisma.bankFetchRun.updateMany({ where: { id: rows[0]!.id }, data: { result: "X" } })).rejects.toThrow();
    await expect(prisma.bankFetchRun.deleteMany({ where: { id: rows[0]!.id } })).rejects.toThrow();
  });
});

describe("Banksperre-Schutz", () => {
  it("falsche PIN im Job: eine Sendung, PIN weg, danach kein Bankkontakt, dieselbe PIN manuell gesperrt", async () => {
    const { orgId, id } = await mkReady("Sperre");
    const base = fake.opens.length;
    fake.camtAnswers.push(new FintsError("PIN_REJECTED", ["9931"]));
    const sum = await runBankFetchJob(NOW);
    expect(sum.errors).toBe(1);
    expect(fake.opens.length - base).toBe(1);
    const row = await rowOf(id);
    expect(row).toMatchObject({ state: "PIN_REJECTED", pinEnc: null, autoEnabled: false, nextAutoAt: null, lastErrorCode: "PIN_REJECTED" });
    expect(row.rejectedPinHmac).not.toBeNull();
    const log = await dbInternal.activityLog.findMany({ where: { orgId, entityType: "BANK_CONNECTION", entityId: id, type: { in: ["BANK_FETCH_PIN_REJECTED", "BANK_FETCH_ACTION"] } }, select: { type: true } });
    expect(log.map((l) => l.type).sort()).toEqual(["BANK_FETCH_ACTION", "BANK_FETCH_PIN_REJECTED"]);
    expect(await dbInternal.notification.count({ where: { orgId, type: "BANK_FETCH_ACTION" } })).toBe(1);
    await runBankFetchJob(t(100));
    expect(fake.opens.length - base).toBe(1);
    await expect(startManualFetch(orgId, id, { pin: PIN }, actor, t(3))).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
    expect(fake.opens.length - base).toBe(1);
  });

  it("unklarer Anmeldefehler: erst AUTH_UNCLEAR mit PIN, wiederholt -> PIN_REJECTED, insgesamt zwei Sendungen", async () => {
    const { orgId, id } = await mkReady("Unklar", { auto: false });
    const base = fake.opens.length;
    fake.camtAnswers.push(new FintsError("AUTH_UNCLEAR", ["9930"]));
    await expect(startManualFetch(orgId, id, {}, actor, t(2))).rejects.toMatchObject({ code: "AUTH_UNCLEAR" });
    let row = await rowOf(id);
    expect(row).toMatchObject({ state: "AUTH_UNCLEAR", autoEnabled: false, authFailures: 1 });
    expect(row.pinEnc).not.toBeNull();
    await expect(startManualFetch(orgId, id, {}, actor, t(4))).rejects.toMatchObject({ code: "PIN_PREVIOUSLY_REJECTED" });
    expect(fake.opens.length - base).toBe(1);
    fake.camtAnswers.push(new FintsError("AUTH_UNCLEAR", ["9930"]));
    await expect(startManualFetch(orgId, id, { unlockConfirmed: true }, actor, t(6))).rejects.toMatchObject({ code: "AUTH_UNCLEAR" });
    row = await rowOf(id);
    expect(row).toMatchObject({ state: "PIN_REJECTED", pinEnc: null });
    expect(fake.opens.length - base).toBe(2);
  });

  it("Freigabe im Job: SCA_REQUIRED, Sitzung geschlossen, Meldung einmal, der naechste Lauf sendet nichts", async () => {
    const { orgId, id } = await mkReady("JobSca");
    const base = fake.opens.length;
    fake.camtAnswers.push(decoupledChallenge());
    const sum = await runBankFetchJob(NOW);
    expect(sum.scaRequired).toBe(1);
    expect(fake.opens.length - base).toBe(1);
    expect(fake.sessions.at(-1)!.closed).toBeGreaterThanOrEqual(1);
    const row = await rowOf(id);
    expect(row).toMatchObject({ state: "SCA_REQUIRED", autoEnabled: true, leaseUntil: null });
    expect((await runsOf(id)).at(-1)).toMatchObject({ result: "SCA_REQUIRED", trigger: "AUTO", actor: "system:bank-fetch" });
    await runBankFetchJob(t(100));
    await runBankFetchJob(t(1000));
    expect(fake.opens.length - base).toBe(1);
    expect(await dbInternal.notification.count({ where: { orgId, type: "BANK_FETCH_ACTION", dedupeKey: { contains: "SCA" } } })).toBe(1);
    // manuell mit Freigabe: wieder bereit, automatischer Abruf bleibt eingeschaltet
    fake.camtAnswers.push(decoupledChallenge(), camtDone([doc(FINTS_IBAN, "nach")]));
    fake.continueAnswers.push(camtDone([doc(FINTS_IBAN_2, "nach")], true));
    const first = await startManualFetch(orgId, id, {}, actor, t(2000));
    if (first.state !== "SCA") throw new Error("Freigabe erwartet");
    done_(await continueManualFetch(orgId, first.token, {}, actor, new Date(t(2000).getTime() + 3000)));
    expect(await rowOf(id)).toMatchObject({ state: "READY", autoEnabled: true });
  });

  it("voruebergehende Fehler: +2 h, hoechstens zwei Sendungen am Tag, dann naechster Tag; Meldung erst am zweiten Fehltag", async () => {
    const { orgId, id } = await mkReady("Transient");
    const timeout = () => new FintsError("TIMEOUT");
    fake.camtAnswers.push(timeout());
    await runBankFetchJob(NOW);
    let row = await rowOf(id);
    expect(row).toMatchObject({ state: "READY", transientFailuresToday: 1 });
    expect(row.nextAutoAt?.getTime()).toBe(NOW.getTime() + 2 * 3_600_000);
    fake.camtAnswers.push(timeout());
    const base = fake.opens.length;
    await runBankFetchJob(new Date(NOW.getTime() + 2 * 3_600_000));
    fake.camtAnswers.push(timeout());
    await runBankFetchJob(new Date(NOW.getTime() + 4 * 3_600_000));
    expect(fake.opens.length - base).toBe(1); // zweite (und letzte) Sendung des Tages
    row = await rowOf(id);
    expect(row.transientFailuresToday).toBe(2);
    expect(berlinDateKey(row.nextAutoAt!)).toBe("2254-03-02");
    expect(await dbInternal.notification.count({ where: { orgId, type: "BANK_FETCH_ERROR" } })).toBe(0);
    // Folgetag: der Vortag war ein Fehlschlag -> Meldung (ein Eintrag je Code und Tag)
    fake.camtAnswers.push(timeout());
    await runBankFetchJob(new Date("2254-03-02T06:00:00.000Z"));
    fake.camtAnswers.push(timeout());
    await runBankFetchJob(new Date("2254-03-02T09:00:00.000Z"));
    expect(await dbInternal.notification.count({ where: { orgId, type: "BANK_FETCH_ERROR" } })).toBe(1);
    expect((await rowOf(id)).transientFailuresToday).toBe(2); // neuer Tag, Zaehlung neu begonnen
  });

  it("nach Erfolg im Job: naechster Berliner Tag, Import ueber den CAMT-Import", async () => {
    const { orgId, id } = await mkReady("JobOk");
    pushBoth("job");
    const sum = await runBankFetchJob(NOW);
    expect(sum).toEqual({ connections: 1, accounts: 2, imported: 2, errors: 0, scaRequired: 0 });
    const row = await rowOf(id);
    expect(row.state).toBe("READY");
    expect(berlinDateKey(row.nextAutoAt!)).toBe("2254-03-02");
    expect(await dbInternal.bankStatementImport.count({ where: { orgId, origin: "FINTS" } })).toBe(4);
  });

  it("der Job sendet nie ohne gespeicherte PIN oder bei ausgeschaltetem Abruf", async () => {
    const { id } = await mkReady("Nie");
    const base = fake.opens.length;
    await dbInternal.bankConnection.update({ where: { id }, data: { pinEnc: null }, select: { id: true } });
    await runBankFetchJob(NOW);
    await dbInternal.bankConnection.update({ where: { id }, data: { autoEnabled: false }, select: { id: true } });
    await runBankFetchJob(NOW);
    expect(fake.opens.length - base).toBe(0);
  });

  it("die Warnung zur ablaufenden Freigabe kommt einmal je letzter Freigabe", async () => {
    const { orgId, id } = await mkReady("Warnung");
    await dbInternal.bankConnection.update({ where: { id }, data: { lastScaAt: new Date("2253-09-10T10:00:00.000Z"), nextAutoAt: new Date("2255-01-01T00:00:00.000Z") }, select: { id: true } });
    await runBankFetchJob(NOW);
    await runBankFetchJob(t(100));
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: id, type: "BANK_FETCH_ACTION" } })).toBe(1);
    const n = await dbInternal.notification.findMany({ where: { orgId, type: "BANK_FETCH_ACTION" }, select: { dedupeKey: true, link: true } });
    expect(n).toHaveLength(1);
    expect(n[0]?.dedupeKey).toBe(`BANK_FETCH_SCA_RENEW:${id}:2253-09-10`);
    expect(n[0]?.link).toBe("/einstellungen/kontoabruf");
  });
});

describe("Fehler vor dem Bankkontakt, Ablauf, Luecke", () => {
  it("nicht lesbare PIN: ein Versuch, Abruf aus, naechster Tag, eine Meldung", async () => {
    const { orgId, id } = await mkReady("Unlesbar");
    const base = fake.opens.length;
    await dbInternal.bankConnection.update({ where: { id }, data: { pinEnc: "kaputt" }, select: { id: true } });
    const a = await runBankFetchJob(NOW);
    await runBankFetchJob(t(100));
    await runBankFetchJob(t(1000));
    expect(a.connections).toBe(1);
    expect(a.errors).toBe(1);
    expect(fake.opens.length - base).toBe(0);
    const row = await rowOf(id);
    expect(row.autoEnabled).toBe(false);
    expect(berlinDateKey(row.nextAutoAt!)).toBe("2254-03-02");
    expect(await dbInternal.notification.count({ where: { orgId, type: "BANK_FETCH_ACTION", dedupeKey: { contains: "BLOCKED" } } })).toBe(1);
  });

  it("Zugang ohne Bankdaten: kein zweiter Versuch am selben Tag, Abruf bleibt an, eine Meldung", async () => {
    const { orgId, id } = await mkReady("OhneInfo");
    await dbInternal.bankConnection.update({ where: { id }, data: { bankingInfoJson: null }, select: { id: true } });
    await runBankFetchJob(NOW);
    const sum = await runBankFetchJob(t(100));
    expect(sum.connections).toBe(0);
    const row = await rowOf(id);
    expect(row.autoEnabled).toBe(true);
    expect(berlinDateKey(row.nextAutoAt!)).toBe("2254-03-02");
    expect(await dbInternal.notification.count({ where: { orgId, type: "BANK_FETCH_ACTION", dedupeKey: { contains: "BLOCKED" } } })).toBe(1);
  });

  it("abgelaufene Freigabe-Sitzung: Lauf SCA_TIMEOUT, Sperre frei", async () => {
    const { orgId, id } = await mkReady("Ablauf", { auto: false });
    fake.camtAnswers.push(decoupledChallenge());
    const first = await startManualFetch(orgId, id, {}, actor, t(2));
    expect(first.state).toBe("SCA");
    expect(await sweepFetchSessions(t(2).getTime() + 6 * 60_000)).toBe(1);
    expect((await runsOf(id)).at(-1)).toMatchObject({ result: "SCA_TIMEOUT", trigger: "MANUAL" });
    expect((await rowOf(id)).leaseUntil).toBeNull();
    expect(await sweepFetchSessions(t(2).getTime() + 7 * 60_000)).toBe(0);
  });

  it("gekuerzter Zeitraum: einmalige Meldung mit Hinweis auf den CAMT-Import", async () => {
    const { orgId, id } = await mkReady("Luecke");
    await dbInternal.bankConnectionAccount.updateMany({ where: { connectionId: id }, data: { lastFetchedTo: new Date("2253-06-01T00:00:00.000Z") } });
    pushBoth("luecke");
    await runBankFetchJob(NOW);
    const n = await dbInternal.notification.findMany({ where: { orgId, dedupeKey: { contains: "GAP" } }, select: { title: true, dedupeKey: true } });
    expect(n).toHaveLength(1);
    expect(n[0]?.title).toContain("25.05.2253");
    expect(n[0]?.dedupeKey).toBe(`BANK_FETCH_ACTION:GAP:${id}:2253-05-25`);
  });
});

describe("Ausgaben ohne Geheimnisse", () => {
  it("weder PIN noch TAN noch Kennung noch Produkt-ID in Protokollen, Meldungen, Laeufen und Logs", async () => {
    const { orgId, id } = await mkReady("Byte");
    fake.camtAnswers.push(new FintsError("PIN_REJECTED", ["9931"]));
    await runScheduledJobs({ jobs: ["bank-fetch"], trigger: "MANUAL", now: NOW });
    fake.camtAnswers.push(decoupledChallenge(), camtDone([doc(FINTS_IBAN, "byte")]));
    fake.continueAnswers.push(new FintsError("SCA_REJECTED", ["9941"]));
    const first = await startManualFetch(orgId, id, { pin: PIN2, unlockConfirmed: true }, actor, t(2));
    if (first.state === "SCA") await expect(continueManualFetch(orgId, first.token, { tan: TAN }, actor, new Date(t(2).getTime() + 3000))).rejects.toBeDefined();
    const dump = JSON.stringify([
      await dbInternal.bankFetchRun.findMany({ where: { orgId } }),
      await dbInternal.notification.findMany({ where: { orgId } }),
      await dbInternal.activityLog.findMany({ where: { orgId } }),
      await dbInternal.schedulerRun.findMany({ where: { job: "bank-fetch" }, select: { summaryJson: true, error: true } }),
      await dbInternal.changeLog.findMany({ where: { orgId } }),
      logs,
    ]);
    for (const m of MARKERS) expect(dump).not.toContain(m);
    const conn = JSON.stringify(await dbInternal.bankConnection.findUniqueOrThrow({ where: { id }, select: { bankingInfoJson: true, rejectedPinHmac: true, lastErrorCode: true } }));
    for (const m of [PIN, PIN2, TAN, "Erika Mustermann", "S4711"]) expect(conn).not.toContain(m);
    const summaryRows = await dbInternal.schedulerRun.findMany({ where: { job: "bank-fetch" }, select: { summaryJson: true } });
    expect(summaryRows.length).toBeGreaterThan(0);
    expect(camtResult([]).bytes).toBe(0);
  });
});
