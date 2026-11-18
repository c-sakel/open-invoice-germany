import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dialog, FinTSConfig } from "lib-fints";
import { FintsError } from "@/lib/fints/client";
import type { FintsErrorCode, FintsSession, FintsStep, FintsSyncResult, FintsCamtResult } from "@/lib/fints/client";
import { createFintsClient } from "@/lib/fints/lib-fints-adapter";
import { ALLOWED_SEGMENTS, probeLimits } from "@/lib/fints/transport";
import { FINTS_MAX_RESPONSE_BYTES, FINTS_PROBE_TIMEOUT_MS } from "@/domain/bank-fetch/limits";
import { runIsolated } from "@/lib/worker/isolated";
import {
  camtDocument,
  FINTS_IBAN,
  FINTS_IBAN_2,
  FINTS_PIN,
  FINTS_TAN,
  FINTS_USER,
  fintsAccess,
} from "../helpers/fints-fixtures";
import { startFintsTestServer, type FintsTestServer, type FintsTestServerOptions } from "../helpers/fints-test-server";
import { createTestTlsMaterial, opensslAvailable } from "../helpers/tls-material";

const hasOpenssl = opensslAvailable();
if (process.env.CI && !hasOpenssl) throw new Error("openssl fehlt in CI");
const tlsDescribe = hasOpenssl ? describe : describe.skip;

type Connector = { address: string; port: number; ca: string; requestTimeoutMs?: number; maxMessages?: number };

let server: FintsTestServer;
const connectorOf = (extra: Partial<Connector> = {}): Connector => ({ address: "127.0.0.1", port: server.port, ca: server.cert, ...extra });

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<FintsErrorCode | "OK" | "OTHER"> {
  try {
    await (typeof p === "function" ? p() : p);
    return "OK";
  } catch (e) {
    return e instanceof FintsError ? e.code : "OTHER";
  }
}

function resetServer(o: FintsTestServerOptions = {}): void {
  server.setOptions(o);
  server.messages.length = 0;
  server.hkcaz.length = 0;
  server.pinSends = 0;
  server.badPinSends = 0;
  server.ended = 0;
}

function done<T>(step: FintsStep<T>): Extract<FintsStep<T>, { kind: "done" }> {
  if (step.kind !== "done") throw new Error("Freigabe erwartet nicht");
  return step;
}

/** Erste Anmeldung: liefert die gespeicherte BPD/UPD fuer die naechsten Sitzungen. */
async function bankingInfoFromSync(): Promise<{ info: string; result: FintsSyncResult }> {
  const session = createFintsClient({ connector: connectorOf() }).open(fintsAccess());
  const step = done(await session.synchronize());
  const info = session.bankingInfo();
  await session.close();
  if (info === null) throw new Error("keine Bankdaten");
  return { info, result: step.value };
}

function openWith(info: string, tanMethodId: number | null, extra: Partial<Connector> = {}, allowSca = true): FintsSession {
  return createFintsClient({ connector: connectorOf(extra) }).open(fintsAccess({ bankingInfo: info, tanMethodId }), { allowSca });
}

tlsDescribe("FinTS-Transport gegen den Testserver", () => {
  beforeAll(async () => {
    server = await startFintsTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("synchronize liefert Konten, TAN-Verfahren und Bankdaten ohne Banktexte", async () => {
    resetServer();
    const { info, result } = await bankingInfoFromSync();
    expect(result.accounts.map((a) => a.iban).sort()).toEqual([FINTS_IBAN, FINTS_IBAN_2].sort());
    expect(result.accounts.every((a) => a.camtSupported)).toBe(true);
    expect(result.tanMethods.map((m) => m.id).sort()).toEqual([910, 920, 923]);
    expect(result.tanMethods.find((m) => m.id === 923)?.decoupled).toBe(true);
    expect(result.tanMethods.find((m) => m.id === 910)?.decoupled).toBe(false);
    expect(result.camtFormats).toEqual(["urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"]);
    expect(result.maxHistoryDays).toBe(450);
    expect(Buffer.byteLength(info)).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.parse(info).bankMessages).toEqual([]);
    // Dialog ordentlich beendet (HKEND), erste Nachricht mit PIN.
    expect(server.ended).toBe(1);
    expect(server.messages[0]).toContain("HKIDN");
  });

  it("fetchCamt ohne Freigabe (3076) liefert die Dokumente bytegleich, Zeitraum als ganze Tage", async () => {
    resetServer({ sca: "none" });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "none" });
    const session = openWith(info, 923);
    const step = done(await session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01"));
    expect(step.scaUsed).toBe(false);
    expect(step.value.documents).toHaveLength(1);
    expect(Buffer.from(step.value.documents[0] ?? new Uint8Array()).equals(Buffer.from(camtDocument(FINTS_IBAN, "A1"), "utf8"))).toBe(true);
    expect(step.value.bytes).toBe(step.value.documents[0]?.length);
    expect(step.value.from).toBe("2026-10-01");
    expect(server.hkcaz).toEqual([{ iban: FINTS_IBAN, from: "2026-10-01", to: "2026-11-01", continuation: null }]);
    expect(step.bankCodes.every((c) => /^\d{4}$/.test(c))).toBe(true);
    await session.close();
  });

  it("begrenzt den Zeitraum auf die Speicherdauer der Bank", async () => {
    resetServer({ sca: "none" });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "none" });
    const session = openWith(info, null);
    const step = done(await session.fetchCamt(FINTS_IBAN, "2020-01-01", "2026-11-01"));
    // Das Ergebnis nennt den tatsaechlich abgerufenen Beginn.
    expect(step.value.from).toBe("2025-08-08");
    // 450 Tage vor dem 2026-11-01
    expect(server.hkcaz[0]?.from).toBe("2025-08-08");
    expect(server.hkcaz[0]?.to).toBe("2026-11-01");
  });

  it("setzt Portionen (3040) zusammen", async () => {
    const docs = [camtDocument(FINTS_IBAN, "P1"), camtDocument(FINTS_IBAN, "P2"), camtDocument(FINTS_IBAN, "P3")];
    resetServer({ documents: docs, pageSize: 1 });
    const { info } = await bankingInfoFromSync();
    resetServer({ documents: docs, pageSize: 1 });
    const session = openWith(info, null);
    const step = done(await session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01"));
    expect(step.value.documents.map((d) => Buffer.from(d).toString("utf8"))).toEqual(docs);
    expect(server.hkcaz.map((r) => r.continuation)).toEqual([null, "1", "2"]);
  });

  it("Freigabe in der App: zweimal ausstehend, dann Erfolg; ohne TAN", async () => {
    resetServer({ sca: "camt-decoupled", decoupledPending: 2 });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "camt-decoupled", decoupledPending: 2 });
    const session = openWith(info, 923);
    const first = await session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01");
    expect(first.kind).toBe("sca");
    if (first.kind !== "sca") return;
    expect(first.challenge.decoupled).toBe(true);
    expect(first.challenge.waitFirstMs).toBeGreaterThanOrEqual(2000);
    expect(first.challenge.waitNextMs).toBeGreaterThanOrEqual(2000);
    expect(first.challenge.maxPolls).toBe(5);
    expect(first.challenge.text.length).toBeLessThanOrEqual(500);
    expect((await session.continueSca()).kind).toBe("sca");
    expect((await session.continueSca()).kind).toBe("sca");
    const last = done(await session.continueSca());
    expect(last.scaUsed).toBe(true);
    expect((last.value as FintsCamtResult).documents).toHaveLength(1);
    expect(server.ended).toBe(1);
    // Zwei Statusabfragen ausstehend + eine erfolgreiche = 3 Statusnachrichten.
    expect(server.messages.filter((m) => m.includes("HKTAN") && !m.includes("HKCAZ") && !m.includes("HKIDN"))).toHaveLength(3);
  });

  it("Freigabe bei der Anmeldung (Synchronisation) wird fortgesetzt", async () => {
    resetServer({ sca: "none" });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "init-decoupled", decoupledPending: 0 });
    const session = openWith(info, 923);
    const step = await session.synchronize();
    expect(step.kind).toBe("sca");
    const finished = done(await session.continueSca());
    expect((finished.value as FintsSyncResult).accounts).toHaveLength(2);
    expect(finished.scaUsed).toBe(true);
  });

  it("Text-TAN mit Bild: Format wird vor dem Senden geprueft, falsche TAN wird gemeldet, richtige TAN liefert Dokumente", async () => {
    resetServer({ sca: "camt-text", photo: "valid" });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "camt-text", photo: "valid" });
    const session = openWith(info, 910);
    const first = await session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01");
    expect(first.kind).toBe("sca");
    if (first.kind !== "sca") return;
    expect(first.challenge.decoupled).toBe(false);
    expect(first.challenge.image?.mime).toBe("image/png");
    expect(first.challenge.text).toBe("Bitte TAN eingeben. Zweite Zeile");
    expect(/[\u0000-\u001f]/.test(first.challenge.text)).toBe(false);
    const before = server.messages.length;
    expect(await codeOf(session.continueSca("12 34"))).toBe("TAN_FORMAT");
    expect(await codeOf(session.continueSca())).toBe("TAN_FORMAT");
    expect(server.messages.length).toBe(before);
    const ok = done(await session.continueSca(FINTS_TAN));
    expect((ok.value as FintsCamtResult).documents).toHaveLength(1);
  });

  it("falsche TAN bricht ab und beendet den Dialog", async () => {
    resetServer({ sca: "camt-text" });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "camt-text" });
    const session = openWith(info, 910);
    await session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01");
    const err = await session.continueSca("000000").catch((e: unknown) => e);
    expect(err instanceof FintsError && err.code).toBe("SCA_REJECTED");
    expect(err instanceof FintsError && err.bankCodes).toContain("9941");
    expect(server.ended).toBe(1);
  });

  it.each([
    ["Bild unbekannten Typs", "unknown-type" as const, null],
    ["Bild mit gelogener Laenge", "lying-length" as const, "image/png"],
  ])("Freigabe-Bild: %s", async (_label, photo, mime) => {
    resetServer({ sca: "camt-text", photo });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "camt-text", photo });
    const step = await openWith(info, 910).fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01");
    expect(step.kind).toBe("sca");
    if (step.kind === "sca") expect(step.challenge.image?.mime ?? null).toBe(mime);
  });

  it("ohne Freigabe-Erlaubnis: Abbruch mit Abmelden", async () => {
    resetServer({ sca: "camt-decoupled" });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "camt-decoupled" });
    const session = openWith(info, 923, {}, false);
    const step = await session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01");
    expect(step.kind).toBe("sca");
    expect(server.messages.at(-1)).toContain("HKEND");
    expect(server.ended).toBe(1);
    expect(await codeOf(session.continueSca())).toBe("PROTOCOL_ERROR");
  });

  it("falsche PIN: genau eine Sendung, kein Abmelden", async () => {
    resetServer();
    const session = createFintsClient({ connector: connectorOf() }).open(fintsAccess({ pin: "Falsch-1234" }));
    const err = await session.synchronize().catch((e: unknown) => e);
    expect(err instanceof FintsError && err.code).toBe("PIN_REJECTED");
    expect(err instanceof FintsError && err.bankCodes).toContain("9931");
    expect(server.pinSends).toBe(1);
    expect(server.badPinSends).toBe(1);
    expect(server.messages).toHaveLength(1);
    await session.close();
    expect(server.messages).toHaveLength(1);
  });

  it("wrongPin und Sperre der Bank", async () => {
    resetServer({ wrongPin: true });
    expect(await codeOf(createFintsClient({ connector: connectorOf() }).open(fintsAccess()).synchronize())).toBe("PIN_REJECTED");
    resetServer({ wrongPin: true, lockAfter: 1 });
    const err = await createFintsClient({ connector: connectorOf() }).open(fintsAccess()).synchronize().catch((e: unknown) => e);
    expect(err instanceof FintsError && err.code).toBe("ACCESS_LOCKED");
    expect(server.pinSends).toBe(1);
    expect(server.messages).toHaveLength(1);
  });

  it("unklarer Code im Dialogaufbau: AUTH_UNCLEAR, eine Sendung", async () => {
    resetServer({ initCode: 9930 });
    const err = await createFintsClient({ connector: connectorOf() }).open(fintsAccess()).synchronize().catch((e: unknown) => e);
    expect(err instanceof FintsError && err.code).toBe("AUTH_UNCLEAR");
    expect(server.pinSends).toBe(1);
    expect(server.messages).toHaveLength(1);
  });

  it("Fehler beim Auftrag nach erfolgreicher Anmeldung: BANK_ERROR, danach Abmelden", async () => {
    resetServer({ sca: "none" });
    const { info } = await bankingInfoFromSync();
    resetServer({ orderCode: 9050 });
    const err = await openWith(info, null).fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01").catch((e: unknown) => e);
    expect(err instanceof FintsError && err.code).toBe("BANK_ERROR");
    expect(err instanceof FintsError && err.bankCodes).toContain("9050");
    expect(server.ended).toBe(1);
  });

  it("Bank ohne camt: NO_CAMT ohne Auftrag", async () => {
    resetServer({ noCamt: true });
    const { info, result } = await bankingInfoFromSync();
    expect(result.accounts.every((a) => !a.camtSupported)).toBe(true);
    resetServer({ noCamt: true });
    expect(await codeOf(openWith(info, null).fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01"))).toBe("NO_CAMT");
    expect(server.hkcaz).toHaveLength(0);
  });

  it("Konto der Bank unbekannt: PROTOCOL_ERROR ohne Netz", async () => {
    resetServer();
    const { info } = await bankingInfoFromSync();
    resetServer();
    expect(await codeOf(openWith(info, null).fetchCamt("DE75512108001245126199", "2026-10-01", "2026-11-01"))).toBe("PROTOCOL_ERROR");
    expect(server.messages).toHaveLength(0);
  });

  describe("feindliche Antworten", () => {
    it.each<[string, FintsTestServerOptions, FintsErrorCode, Partial<Connector>?]>([
      ["Endlosschleife der Fortsetzung", { endlessContinuation: true }, "TOO_LARGE", { maxMessages: 6 }],
      ["zu grosse Antwort", { hugeResponse: true }, "TOO_LARGE"],
      ["zu viele Segmente", { manySegments: true }, "TOO_LARGE"],
      ["unmaskiertes @", { malformedBinary: true }, "DECODE_FAILED"],
      ["ohne Rueckmeldung", { noHirmg: true }, "PROTOCOL_ERROR"],
      ["Weiterleitung", { redirect: true }, "HTTP_STATUS"],
      ["DOCTYPE im Dokument", { doctypeInCamt: true, sca: "none" }, "CAMT_UNSAFE"],
      ["Dokument eines anderen Kontos", { wrongIban: true, sca: "none" }, "ACCOUNT_MISMATCH"],
      ["zu langsam", { slow: 1500 }, "TIMEOUT", { requestTimeoutMs: 300 }],
    ])("%s -> %s", async (_label, options, expected, extra) => {
      let info: string | null = null;
      if (options.doctypeInCamt || options.wrongIban || options.endlessContinuation) {
        resetServer({ sca: "none" });
        info = (await bankingInfoFromSync()).info;
      }
      resetServer(options);
      const session = info
        ? openWith(info, null, extra)
        : createFintsClient({ connector: connectorOf(extra) }).open(fintsAccess());
      const p = info ? session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01") : session.synchronize();
      expect(await codeOf(p)).toBe(expected);
    });

    it("fremdes Zertifikat -> TLS_FAILED", async () => {
      resetServer();
      const other = createTestTlsMaterial("fints.example.org");
      const session = createFintsClient({ connector: { ...connectorOf(), ca: other.cert } }).open(fintsAccess());
      expect(await codeOf(session.synchronize())).toBe("TLS_FAILED");
      expect(server.messages).toHaveLength(0);
    });

    it("Server nicht erreichbar -> CONNECT_FAILED", async () => {
      resetServer();
      const session = createFintsClient({ connector: { ...connectorOf(), port: 1 } }).open(fintsAccess());
      expect(await codeOf(session.synchronize())).toBe("CONNECT_FAILED");
    });

  });

  it("Abmelden schlaegt fehl: der Vorgang gelingt trotzdem, close wirft nie", async () => {
    resetServer({ endFails: true });
    const session = createFintsClient({ connector: connectorOf() }).open(fintsAccess());
    const step = done(await session.synchronize());
    expect(step.value.accounts).toHaveLength(2);
    await expect(session.close()).resolves.toBeUndefined();
    expect(server.ended).toBe(0);
  });

  it("sendet nur lesende Segmente, nie die PIN im Klartext in Ausgaben, nie fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch darf nicht aufgerufen werden");
    });
    const sinks = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    resetServer({ sca: "camt-decoupled", decoupledPending: 1 });
    const { info } = await bankingInfoFromSync();
    const errors: unknown[] = [];
    // viele Wege: Erfolg, Freigabe, falsche PIN, kaputte Antwort
    const decoupled = openWith(info, 923);
    await decoupled.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01");
    await decoupled.continueSca();
    await decoupled.continueSca();
    for (const o of [{ wrongPin: true }, { malformedBinary: true }, { noHirmg: true }, { redirect: true }, { initCode: 9930 }] as FintsTestServerOptions[]) {
      resetServer(o);
      await createFintsClient({ connector: connectorOf() }).open(fintsAccess()).synchronize().catch((e: unknown) => errors.push(e));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    const everything = [...sinks.flatMap((s) => s.mock.calls.flat().map(String)), ...errors.map((e) => `${(e as Error).name} ${(e as Error).message}`)].join("\n");
    for (const secret of [FINTS_PIN, FINTS_USER, FINTS_IBAN, "TESTPRODUKT0000000001"]) expect(everything).not.toContain(secret);
    expect(sinks.every((s) => s.mock.calls.length === 0)).toBe(true);
    expect(errors.every((e) => e instanceof FintsError)).toBe(true);
  });

  it("Protokoll der Bank zeigt nur erlaubte Segmente", async () => {
    resetServer({ sca: "camt-decoupled", decoupledPending: 0 });
    const { info } = await bankingInfoFromSync();
    const session = openWith(info, 923);
    await session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01");
    await session.continueSca();
    const all = new Set(server.messages.flat());
    expect([...all].filter((id) => !ALLOWED_SEGMENTS.has(id))).toEqual([]);
    for (const id of ["HKIDN", "HKVVB", "HKCAZ", "HKTAN", "HKEND"]) expect(all.has(id)).toBe(true);
    for (const id of ["HKSAL", "HKKAZ", "HKCCS", "HKDSE"]) expect(all.has(id)).toBe(false);
  });

  it("nie zwei Dialoge gleichzeitig je Sitzung", async () => {
    resetServer({ sca: "none", slow: 150 });
    const { info } = await bankingInfoFromSync();
    resetServer({ sca: "none", slow: 150 });
    const session = openWith(info, null);
    const first = session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01");
    expect(await codeOf(session.fetchCamt(FINTS_IBAN, "2026-10-01", "2026-11-01"))).toBe("PROTOCOL_ERROR");
    expect((await first).kind).toBe("done");
  });
});

describe("FinTS-Transport ohne Testserver", () => {
  it("Netzsperre unter Vitest ohne Test-Anschluss", () => {
    expect(() => createFintsClient().open(fintsAccess())).toThrowError(expect.objectContaining({ code: "NETWORK_BLOCKED" }));
  });

  it("ungueltige Adresse -> URL_INVALID vor jedem Netz", () => {
    const client = createFintsClient({ connector: { address: "127.0.0.1", port: 1, ca: "x" } });
    expect(() => client.open(fintsAccess({ url: "http://fints.example.org/" }))).toThrowError(expect.objectContaining({ code: "URL_INVALID" }));
  });

  it("die Bibliothek faellt nie auf ihren eigenen HTTP-Client zurueck", () => {
    // Nach dem ersten open sind die Haken gesetzt; ein Dialog ohne registrierten Transport scheitert sofort.
    createFintsClient({ connector: { address: "127.0.0.1", port: 1, ca: "x" } }).open(fintsAccess());
    const config = FinTSConfig.forFirstTimeUse("TESTPRODUKT0000000001", "1.0", "https://fints.example.org/", "37040044", "kunde4711", "x");
    expect(() => new Dialog(config)).toThrowError(expect.objectContaining({ code: "PROTOCOL_ERROR" }));
  });

  it("Probe-Grenzen wachsen mit der Antwortgroesse bis zu einer festen Obergrenze", () => {
    const small = probeLimits(1024);
    const big = probeLimits(FINTS_MAX_RESPONSE_BYTES);
    expect(small.timeoutMs).toBeGreaterThanOrEqual(FINTS_PROBE_TIMEOUT_MS);
    expect(small.timeoutMs).toBeLessThan(FINTS_PROBE_TIMEOUT_MS + 50);
    expect(big.timeoutMs).toBeGreaterThan(small.timeoutMs);
    expect(big.maxHeapMb).toBeGreaterThan(small.maxHeapMb);
    expect(probeLimits(FINTS_MAX_RESPONSE_BYTES * 10)).toEqual(big);
  });

  it("grosse rechtmaessige Antwort nahe der Grenze wird mit den skalierten Grenzen angenommen, ein Hang bleibt DECODE_FAILED", async () => {
    const n = 12 * 1024 * 1024;
    const text = `HNHBK:1:3+000000000041+300+D1+1+D1:1'HIRMG:3:2+0010::ok'HICAZ:4:1:3+DE89370400440532013000:X:280:37040044+urn:iso:std:iso:20022:tech:xsd:camt.052.001.02+@${n}@${"x".repeat(n)}'HNHBS:5:1+1'`;
    const limits = probeLimits(text.length);
    const big = await runIsolated<{ text: string; parted: string | null }, boolean>({
      job: "probe-decode",
      script: "fints",
      input: { text, parted: null },
      ...limits,
    });
    expect(big).toEqual({ ok: true, value: true });
    const hang = await runIsolated<{ text: string; parted: string | null }, boolean>({
      job: "probe-decode",
      script: "fints",
      input: { text: "HIRMS:4:2+0010::a@5:4+x'", parted: null },
      timeoutMs: 2000,
      maxHeapMb: 256,
    });
    expect(hang).toEqual({ ok: false, reason: "TIMEOUT" });
  }, 30_000);

  it("Probe-Dekodierung im Worker: gueltig, ungueltig und Endlosschleife (Zeitlimit)", async () => {
    const run = (text: string) =>
      runIsolated<{ text: string; parted: string | null }, boolean>({
        job: "probe-decode",
        script: "fints",
        input: { text, parted: null },
        timeoutMs: 2000,
        maxHeapMb: 256,
      });
    expect((await run("HNHBK:1:3+000000000041+300+D1+1+D1:1'HIRMG:3:2+0010::ok'HNHBS:4:1+1'")).ok).toBe(true);
    expect((await run("garbage")).ok).toBe(false);
    const started = Date.now();
    const hang = await run("HIRMS:4:2+0010::a@5:4+x'");
    expect(hang).toEqual({ ok: false, reason: "TIMEOUT" });
    // Der Hauptprozess blieb frei: Zeitlimit greift, es gibt keine Blockade.
    expect(Date.now() - started).toBeLessThan(6000);
  }, 20_000);
});
