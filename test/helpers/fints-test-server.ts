/**
 * Lokaler Testserver fuer FinTS ueber HTTPS (nur 127.0.0.1, nie eine echte Bank). Das Zertifikat entsteht zur Laufzeit.
 * Die geskriptete Bank liefert BPD (Zwei-Schritt-Verfahren mit Freigabe in der App, TAN per Text und Bild), UPD mit zwei Konten,
 * HICAZ mit camt.052 (auch in Portionen), die Freigabeschritte und eine Reihe feindlicher Antworten. Sie liest die Anfragen mit der
 * Dekodierung der Bibliothek und protokolliert Segmentkennungen und die Zahl der PIN-Sendungen (nie die PIN selbst).
 */
import https from "node:https";
import { Message } from "lib-fints";
import type { Segment } from "lib-fints";
import { camtDocument, FINTS_BLZ, FINTS_HOST, FINTS_IBAN, FINTS_IBAN_2, FINTS_PIN, FINTS_TAN, FINTS_USER } from "./fints-fixtures";
import { createTestTlsMaterial } from "./tls-material";

export interface FintsTestServerOptions {
  /** Erwartete PIN. */
  pin?: string;
  /** Jede PIN ablehnen (Code 9931). */
  wrongPin?: boolean;
  /** Nach so vielen abgelehnten PIN-Sendungen meldet die Bank den Zugang als gesperrt (3938). */
  lockAfter?: number;
  /** Freigabe: keine (3076), in der App beim Abruf, per Text-TAN beim Abruf, in der App schon bei der Anmeldung. */
  sca?: "none" | "camt-decoupled" | "camt-text" | "init-decoupled";
  /** Kurzform fuer sca "camt-decoupled". */
  scaAlways?: boolean;
  /** So oft meldet die Bank bei der Statusabfrage 3956 (noch ausstehend). */
  decoupledPending?: number;
  /** Bei der Freigabe mit Text zusaetzlich ein Bild (photoTAN). */
  photo?: "valid" | "unknown-type" | "lying-length";
  /** Eigene Dokumente (Rohtext); Standard ein Dokument fuer die abgefragte IBAN. */
  documents?: string[];
  /** Dokumente je Portion (3040-Fortsetzung). */
  pageSize?: number;
  /** Jede Antwort auf HKCAZ verweist auf eine weitere Portion (Endlosschleife der Bank). */
  endlessContinuation?: boolean;
  /** Antwort groesser als erlaubt. */
  hugeResponse?: boolean;
  /** Antwort mit mehr Segmentenden als erlaubt. */
  manySegments?: boolean;
  /** Antwort mit unmaskiertem `@` ohne Gegenstueck (Endlosschleife der Bibliothek). */
  malformedBinary?: boolean;
  /** Antwort ohne Rueckmeldung zur Nachricht. */
  noHirmg?: boolean;
  /** Antwort mit Weiterleitung. */
  redirect?: boolean;
  /** Dokument gehoert zu einem anderen Konto. */
  wrongIban?: boolean;
  /** Dokument mit DOCTYPE. */
  doctypeInCamt?: boolean;
  /** Verzoegerung der Antwort in ms. */
  slow?: number;
  /** Bei der Anmeldung einen nicht belegten Code melden (Dialogaufbau). */
  initCode?: number;
  /** Auf HKCAZ mit Code 9xxx antworten (nach erfolgreicher Anmeldung). */
  orderCode?: number;
  /** Auf HKEND nicht antworten (Abmelden schlaegt fehl). */
  endFails?: boolean;
  /** Bank bietet kein camt (HICAZS fehlt). */
  noCamt?: boolean;
}

export interface FintsTestServer {
  port: number;
  host: string;
  /** Zertifikat (oeffentlicher Teil) zum Pruefen der Verbindung. */
  cert: string;
  /** Segmentkennungen je empfangener Nachricht (inklusive Huellen). */
  messages: string[][];
  /** Anzahl Nachrichten mit einer PIN. */
  pinSends: number;
  /** Anzahl Nachrichten mit falscher PIN. */
  badPinSends: number;
  /** HKCAZ-Anfragen (Konto und Zeitraum). */
  hkcaz: { iban: string | null; from: string | null; to: string | null; continuation: string | null }[];
  /** Zahl der abgeschlossenen Dialoge (HKEND beantwortet). */
  ended: number;
  setOptions(o: FintsTestServerOptions): void;
  close(): Promise<void>;
}

const esc = (s: string): string => s.replace(/[?:+'@]/g, (c) => `?${c}`);
type Code = [number, string, ...string[]];

const codeText = (codes: Code[]): string =>
  codes.map(([c, t, ...p]) => `${String(c).padStart(4, "0")}::${esc(t)}${p.length ? `:${p.map(esc).join(":")}` : ""}`).join("+");
const hirmg = (...codes: Code[]): string => `HIRMG:3:2+${codeText(codes)}'`;
const hirms = (ref: number, ...codes: Code[]): string => `HIRMS:4:2:${ref}+${codeText(codes)}'`;
const hitan = (ref: string, challenge: string, extra = ""): string => `HITAN:5:7:4+4++${ref}+${esc(challenge)}${extra}'`;

const hibpa = (): string => `HIBPA:4:3:3+12+280:${FINTS_BLZ}+Testbank Muster+3+1+300'`;
const hipins = (): string => `HIPINS:164:1:4+1+1+0+5:38:6:USERID:CUSTID:HKCAZ:J:HKSAL:N:HKTAB:N:HKSPA:N'`;
const hicazs = (days = 450): string => `HICAZS:16:1:4+1+1+0+${days}:N:N:${esc("urn:iso:std:iso:20022:tech:xsd:camt.052.001.08")}'`;
const hispas = (): string => `HISPAS:17:1:4+1+1+0+J:J:N:sepa.pain.001.001.03.xsd'`;
const hitabs = (): string => `HITABS:18:4:4+1+1+0+N:N:N:N:5'`;

interface Method {
  id: number;
  name: string;
  zka?: string;
  zkaVer?: string;
  decoupled?: { max: number; first: number; between: number };
}
const METHODS: Method[] = [
  { id: 923, name: "pushTAN", zka: "Decoupled", zkaVer: "1.0", decoupled: { max: 5, first: 0, between: 0 } },
  { id: 920, name: "photoTAN" },
  { id: 910, name: "smsTAN" },
];

function hitans7(): string {
  const m = METHODS.map((x) =>
    [
      x.id, 2, esc(`M${x.id}`), esc(x.zka ?? ""), esc(x.zkaVer ?? ""), esc(x.name), 6, 1, "TAN", 3, "J", 2, "N", 0, 0, "N", "N", "00", 0, "N", 0,
      ...(x.decoupled ? [x.decoupled.max, x.decoupled.first, x.decoupled.between, "J", "N"] : ["", "", "", "", ""]),
    ].join(":"),
  ).join(":");
  return `HITANS:163:7:4+1+1+0+J:N:0:${m}'`;
}

const hiupa = (): string => `HIUPA:165:4:4+${FINTS_USER}+3+0'`;
const hiupd = (nr: number, iban: string, acct: string): string =>
  `HIUPD:${nr}:6:4+${acct}::280:${FINTS_BLZ}+${iban}+${FINTS_USER}+1+EUR+Max Muster++Giro++HKSPA:1+HKCAZ:1+HKTAB:1'`;

function wrap(dialogId: string, msgNr: number, body: string): string {
  const inner = `${body}HNHBS:99:1+${msgNr}'`;
  const placeholder = `HNHBK:1:3+000000000000+300+${dialogId}+${msgNr}+${dialogId}:${msgNr}'`;
  const total = placeholder.length + inner.length;
  return placeholder.replace("000000000000", String(total).padStart(12, "0")) + inner;
}

const toWire = (xml: string): string => Buffer.from(xml, "utf8").toString("latin1");
const DESC = "urn?:iso?:std?:iso?:20022?:tech?:xsd?:camt.052.001.08";

function hicaz(iban: string, docs: string[]): string {
  const wire = docs.map(toWire);
  return `HICAZ:5:1:4+${iban}:TESTDEFF+${DESC}+${wire.map((d) => `@${d.length}@${d}`).join(":")}'`;
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108020000009077", "hex");

function photoElement(kind: "valid" | "unknown-type" | "lying-length"): string {
  const mime = Buffer.from("image/png", "latin1");
  const image = kind === "unknown-type" ? Buffer.from("MZ-not-an-image-at-all", "latin1") : PNG;
  const size = kind === "lying-length" ? Buffer.from([255, 255]) : Buffer.from([image.length >> 8, image.length & 255]);
  const bin = Buffer.concat([Buffer.from([0, mime.length]), mime, size, image]).toString("latin1");
  return `+@${bin.length}@${bin}`;
}

interface HktanLike {
  tanProcess?: string;
}
interface HnhbkLike {
  dialogId: string;
  msgNr: number;
}
interface HnshaLike {
  customSignature?: { pin?: string; tan?: string };
}
interface HkcazLike {
  account?: { iban?: string };
  from?: Date;
  to?: Date;
  continuationMark?: string;
}

const ENVELOPE = new Set(["HNHBK", "HNHBS", "HNSHK", "HNSHA", "HNVSK", "HNVSD"]);

export async function startFintsTestServer(initial: FintsTestServerOptions = {}): Promise<FintsTestServer> {
  let opts: FintsTestServerOptions = { ...initial };
  const material = createTestTlsMaterial(FINTS_HOST);
  const server: FintsTestServer = {
    port: 0,
    host: FINTS_HOST,
    cert: material.cert,
    messages: [],
    pinSends: 0,
    badPinSends: 0,
    hkcaz: [],
    ended: 0,
    setOptions(o) {
      opts = { ...o };
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
  let dialogCounter = 0;
  let polls = 0;
  let initPending = false;
  let wrongSoFar = 0;
  const sca = (): NonNullable<FintsTestServerOptions["sca"]> => opts.sca ?? (opts.scaAlways ? "camt-decoupled" : "none");

  const docsFor = (iban: string): string[] => {
    if (opts.doctypeInCamt) return [`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE d [<!ENTITY a "x">]><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"><BkToCstmrAcctRpt>&a;</BkToCstmrAcctRpt></Document>`];
    if (opts.wrongIban) return [camtDocument("DE75512108001245126199", "W1")];
    return opts.documents ?? [camtDocument(iban, "A1")];
  };

  function respond(req: Message): string | { status: number; body: string } {
    const ids = req.segments.map((s) => s.header.segId);
    server.messages.push(ids);
    const inner = ids.filter((i) => !ENVELOPE.has(i));
    const hnhbk = req.findSegment("HNHBK") as (Segment & HnhbkLike) | undefined;
    const msgNr = hnhbk?.msgNr ?? 1;
    const hasInit = inner.includes("HKIDN");
    const dlg = hasInit ? `DLG${++dialogCounter}` : (hnhbk?.dialogId ?? "DLG0");
    const hnsha = req.findSegment("HNSHA") as (Segment & HnshaLike) | undefined;
    const sentPin = hnsha?.customSignature?.pin ?? "";
    const sentTan = hnsha?.customSignature?.tan ?? "";
    const hktan = req.findSegment("HKTAN") as (Segment & HktanLike) | undefined;
    if (sentPin !== "") server.pinSends++;
    const body = (b: string): string => wrap(dlg, msgNr, b);
    const ok = hirmg([10, "Nachricht entgegengenommen."]);

    if (opts.redirect) return { status: 302, body: "" };
    if (opts.hugeResponse) return "A".repeat(23_000_000);
    if (opts.noHirmg) return body("");
    if (opts.malformedBinary) return body(`HIRMS:4:2+0010::a@5:4+x'`);
    if (opts.manySegments) return body(ok + "HIRMS:4:2+0010::x'".repeat(25_000));

    if (inner.includes("HKEND")) {
      if (opts.endFails) return { status: 500, body: "" };
      server.ended++;
      return body(hirmg([100, "Dialog beendet."]));
    }

    if (hasInit) {
      const pinOk = !opts.wrongPin && sentPin === (opts.pin ?? FINTS_PIN);
      if (!pinOk) {
        server.badPinSends++;
        wrongSoFar++;
        if (opts.lockAfter !== undefined && wrongSoFar >= opts.lockAfter) {
          return body(hirmg([3938, "Zugang vorlaeufig gesperrt."], [9931, "Anmeldename oder PIN falsch."]));
        }
        return body(hirmg([9931, "Anmeldename oder PIN falsch."]));
      }
      if (opts.initCode !== undefined) return body(hirmg([opts.initCode, "Fehler beim Dialogaufbau."]));
      const bpd =
        hibpa() + hipins() + hitans7() + (opts.noCamt ? "" : hicazs()) + hispas() + hitabs() + hiupa() +
        hiupd(167, FINTS_IBAN, "0532013000") + hiupd(168, FINTS_IBAN_2, "0000202051");
      const answers = hirmg([10, "Nachricht entgegengenommen."], [3920, "Zugelassene Zwei-Schritt-Verfahren.", "923", "920", "910"]);
      if (hktan) {
        if (sca() === "init-decoupled") {
          initPending = true;
          polls = 0;
          return body(answers + hirms(3, [3955, "Bitte in der App freigeben."]) + hitan("REFINIT", "Bitte in der App freigeben."));
        }
        return body(answers + hirms(3, [3076, "Keine starke Kundenauthentifizierung erforderlich."]) + (inner.includes("HKSYN") ? `HISYN:6:4:4+SYS4711'` : "") + bpd);
      }
      return body(answers + (inner.includes("HKSYN") ? `HISYN:6:4:4+SYS4711'` : "") + bpd);
    }

    if (sentPin !== (opts.pin ?? FINTS_PIN) || opts.wrongPin) {
      server.badPinSends++;
      return body(hirmg([9931, "Anmeldename oder PIN falsch."]));
    }

    if (inner.includes("HKTAB")) return body(ok + hirms(3, [20, "ok"]) + `HITAB:5:4:3+0+A:1:::::::::::Mein Geraet::::::::'`);
    if (inner.includes("HKSPA")) {
      return body(ok + hirms(3, [20, "ok"]) + `HISPA:5:3:3+J:${FINTS_IBAN}:TESTDEFF:0532013000::280:${FINTS_BLZ}'`);
    }

    // Freigabe fortsetzen (Status in der App oder eingegebene TAN).
    if (hktan && (hktan.tanProcess === "S" || hktan.tanProcess === "2")) {
      if (hktan.tanProcess === "S") {
        if (polls++ < (opts.decoupledPending ?? 1)) return body(ok + hirms(3, [3956, "Freigabe noch ausstehend."]) + hitan("REFCAZ", "Bitte freigeben."));
      } else if (sentTan !== FINTS_TAN) {
        return body(ok + hirms(3, [9941, "TAN ungueltig."]));
      }
      if (initPending) {
        initPending = false;
        const bpd =
          hibpa() + hipins() + hitans7() + hicazs() + hispas() + hitabs() + hiupa() +
          hiupd(167, FINTS_IBAN, "0532013000") + hiupd(168, FINTS_IBAN_2, "0000202051");
        return body(ok + hirms(3, [20, "ok"]) + bpd);
      }
      return body(ok + hirms(3, [20, "ok"]) + hicaz(FINTS_IBAN, docsFor(FINTS_IBAN)));
    }

    if (inner.includes("HKCAZ")) {
      const seg = req.findSegment("HKCAZ") as (Segment & HkcazLike) | undefined;
      const iban = seg?.account?.iban ?? FINTS_IBAN;
      server.hkcaz.push({
        iban: seg?.account?.iban ?? null,
        from: seg?.from ? seg.from.toISOString().slice(0, 10) : null,
        to: seg?.to ? seg.to.toISOString().slice(0, 10) : null,
        continuation: seg?.continuationMark ?? null,
      });
      if (opts.orderCode !== undefined) return body(ok + hirms(3, [opts.orderCode, "Auftrag abgelehnt."]));
      if (hktan && hktan.tanProcess === "4" && sca() !== "none" && sca() !== "init-decoupled") {
        polls = 0;
        if (sca() === "camt-decoupled") {
          return body(ok + hirms(3, [3955, "Bitte in der App freigeben."]) + hitan("REFCAZ", "Bitte in der App freigeben."));
        }
        const extra = opts.photo ? photoElement(opts.photo) : "";
        return body(ok + hirms(3, [30, "Sicherheitsfreigabe erforderlich."]) + hitan("REFTAN", "Bitte TAN eingeben.\u0007 Zweite Zeile", extra));
      }
      const docs = docsFor(iban);
      if (opts.endlessContinuation) {
        return body(ok + hirms(3, [3040, "Weitere Daten vorhanden.", "MORE"]) + hicaz(iban, [docs[0] ?? camtDocument(iban, "E1")]));
      }
      const size = opts.pageSize ?? docs.length;
      const start = seg?.continuationMark ? Number(seg.continuationMark) : 0;
      const slice = docs.slice(start, start + size);
      const next = start + size;
      const done = hktan ? hirms(3, [3076, "Keine starke Kundenauthentifizierung erforderlich."]) : hirms(3, [20, "ok"]);
      const answers = next < docs.length ? hirms(3, [3040, "Weitere Daten vorhanden.", String(next)]) : done;
      return body(ok + answers + hicaz(iban, slice));
    }
    return body(hirmg([9050, "Nachricht fehlerhaft."]));
  }

  const http = https.createServer({ key: material.key, cert: material.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const run = (): void => {
        try {
          const wire = Buffer.from(Buffer.concat(chunks).toString("latin1"), "base64").toString("latin1");
          const request = Message.decode(wire);
          const result = respond(request);
          if (typeof result === "object") {
            res.writeHead(result.status, result.status === 302 ? { Location: "https://elsewhere.example.org/" } : {});
            res.end(result.body);
            return;
          }
          const body = Buffer.from(result, "latin1").toString("base64");
          res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(Buffer.byteLength(body)) });
          res.end(body);
        } catch {
          res.writeHead(400);
          res.end();
        }
      };
      if (opts.slow) setTimeout(run, opts.slow);
      else run();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address();
  server.port = typeof addr === "object" && addr ? addr.port : 0;
  return server;
}
