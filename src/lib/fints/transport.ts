/**
 * Transport fuer die FinTS-Bibliothek: ersetzt deren HTTP-Client (nie `fetch`), prueft vor dem Senden die
 * Segmentliste (nur lesende Auftraege), verbindet per `node:https` auf eine einmal geprueft aufgeloeste Adresse
 * (TLS >= 1.2, Zertifikat immer geprueft, keine Weiterleitung) und prueft jede Antwort, bevor etwas sie liest:
 * Groesse, striktes Base64, Segmentenden, Probe-Dekodierung im Worker. Es protokolliert nichts; Fehler tragen nur
 * feste Codes. PIN und Banktexte verlassen diese Datei nie.
 */
import https from "node:https";
import net from "node:net";
import { CustomerMessage, Message } from "lib-fints";
import type { Segment } from "lib-fints";
import {
  FINTS_CONNECT_TIMEOUT_MS,
  FINTS_END_TIMEOUT_MS,
  FINTS_MAX_BYTES_PER_DIALOG,
  FINTS_MAX_MESSAGES_PER_DIALOG,
  FINTS_MAX_RESPONSE_BYTES,
  FINTS_MAX_SEGMENTS,
  FINTS_PROBE_HEAP_MB,
  FINTS_PROBE_TIMEOUT_MS,
  FINTS_REQUEST_TIMEOUT_MS,
} from "@/domain/bank-fetch/limits";
import { runIsolated } from "@/lib/worker/isolated";
import { FintsError } from "./client";
import type { FintsErrorCode } from "./client";
import { classifyCodes, dialogEnded, sanitizeCodes } from "./codes";
import { countSegmentEnds } from "./segment-ends";
import { fintsNetworkBlocked, resolveFintsHost } from "./url-guard";
import type { LookupFn } from "./url-guard";

type Env = Readonly<Record<string, string | undefined>>;

/** Kundensegmente, die gesendet werden duerfen (nur lesend), dazu die Huellen. */
export const ALLOWED_SEGMENTS: ReadonlySet<string> = new Set([
  "HKIDN", "HKVVB", "HKSYN", "HKTAN", "HKTAB", "HKSPA", "HKCAZ", "HKEND",
  "HNHBK", "HNVSK", "HNVSD", "HNSHK", "HNSHA", "HNHBS",
]);

/** Nur fuer Tests: feste Zieladresse, Port, eigene CA und kleinere Grenzen. Nie aus Konfiguration oder Umgebung. */
export interface TestConnector {
  address: string;
  port: number;
  ca: string;
  requestTimeoutMs?: number;
  maxMessages?: number;
}

export interface TransportOptions {
  host: string;
  path: string;
  connector?: TestConnector;
  env?: Env;
  lookup?: LookupFn;
}

export interface DialogState {
  messages: number;
  bytes: number;
  dialogId: string;
  lastMsgNr: number;
  initAccepted: boolean;
  open: boolean;
  ended: boolean;
  /** Codes der letzten Antwort (vierstellig). */
  lastCodes: string[];
  /** Hat die Bank in diesem Vorgang eine Freigabe verlangt? */
  scaSeen: boolean;
}

interface Answerish {
  code: number;
}

interface HirmgLike {
  answers: Answerish[];
}

interface HnhbkLike {
  dialogId: string;
  msgNr: number;
}

function freshState(): DialogState {
  return { messages: 0, bytes: 0, dialogId: "0", lastMsgNr: 0, initAccepted: false, open: false, ended: false, lastCodes: [], scaSeen: false };
}

/** Obergrenzen der Probe: auch eine grosse, rechtmaessige Antwort darf sie nie ueberschreiten. */
const PROBE_MAX_TIMEOUT_MS = 20_000;
const PROBE_MAX_HEAP_MB = 768;

/**
 * Zeit- und Speichergrenze der Probe-Dekodierung, linear mit der Antwortgroesse: Grundwert fuer kleine Antworten,
 * bis zur Groessengrenze der Antwort wachsend, aber mit fester Obergrenze (eine Endlosschleife scheitert weiter).
 */
export function probeLimits(bytes: number): { timeoutMs: number; maxHeapMb: number } {
  const share = Math.min(1, Math.max(0, bytes / FINTS_MAX_RESPONSE_BYTES));
  return {
    timeoutMs: Math.round(FINTS_PROBE_TIMEOUT_MS + share * (PROBE_MAX_TIMEOUT_MS - FINTS_PROBE_TIMEOUT_MS)),
    maxHeapMb: Math.round(FINTS_PROBE_HEAP_MB + share * (PROBE_MAX_HEAP_MB - FINTS_PROBE_HEAP_MB)),
  };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function segIdsOf(message: { segments: Segment[] }): string[] {
  return message.segments.map((s) => s.header.segId);
}

function errorCodeFromNode(err: NodeJS.ErrnoException): FintsErrorCode {
  const code = err.code ?? "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "TIMEOUT";
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.startsWith("CERT_") ||
    code.startsWith("DEPTH_ZERO") ||
    code.startsWith("SELF_SIGNED") ||
    code.startsWith("UNABLE_TO_") ||
    code === "EPROTO"
  ) {
    return "TLS_FAILED";
  }
  return "CONNECT_FAILED";
}

export class FintsTransport {
  readonly state: DialogState = freshState();
  private target: Promise<{ host: string; address: string; family: 4 | 6 }> | null = null;
  private readonly env: Env;

  constructor(private readonly opts: TransportOptions) {
    this.env = opts.env ?? process.env;
  }

  private maxMessages(): number {
    return this.opts.connector?.maxMessages ?? FINTS_MAX_MESSAGES_PER_DIALOG;
  }

  /** Einmal aufloesen und merken; jede weitere Nachricht geht auf dieselbe geprueften Adresse. */
  private resolveTarget(): Promise<{ host: string; address: string; family: 4 | 6 }> {
    if (this.target) return this.target;
    const connector = this.opts.connector;
    this.target = connector
      ? Promise.resolve({ host: this.opts.host, address: connector.address, family: net.isIPv6(connector.address) ? 6 : 4 })
      : resolveFintsHost(this.opts.host, { lookup: this.opts.lookup, env: this.env });
    // Fehlschlag nicht merken: ein spaeterer Versuch darf neu aufloesen.
    this.target.catch(() => {
      this.target = null;
    });
    return this.target;
  }

  /** Eine Nachricht an die Bank (Schnittstelle des HTTP-Clients der Bibliothek). */
  async sendMessage(message: CustomerMessage): Promise<Message> {
    // 1. Nichts geht ins Netz, bevor diese Pruefungen bestanden sind.
    if (!this.opts.connector && fintsNetworkBlocked(this.env)) throw new FintsError("NETWORK_BLOCKED");
    const ids = segIdsOf(message);
    if (ids.some((id) => !ALLOWED_SEGMENTS.has(id))) throw new FintsError("SEGMENT_NOT_ALLOWED");
    const isEnd = ids.includes("HKEND");
    const isInit = ids.includes("HKIDN");
    const state = this.state;
    if (isInit) {
      if (state.open && !state.ended) throw new FintsError("PROTOCOL_ERROR"); // nie zwei Dialoge je Zugang
      Object.assign(state, freshState());
    }
    if (!isEnd && state.messages + 1 > this.maxMessages()) throw new FintsError("TOO_LARGE");
    if (!isEnd) state.messages++;

    const hnhbk = message.segments.find((s) => s.header.segId === "HNHBK") as (Segment & Partial<HnhbkLike>) | undefined;
    if (hnhbk && typeof hnhbk.msgNr === "number") state.lastMsgNr = hnhbk.msgNr;

    const exchange = async (): Promise<Message> => {
      const wire = message.encode();
      const body = Buffer.from(wire, "latin1");
      const text = await this.post(body, isEnd ? FINTS_END_TIMEOUT_MS : this.opts.connector?.requestTimeoutMs ?? FINTS_REQUEST_TIMEOUT_MS);
      return this.receive(text, message, { isInit, isEnd });
    };

    if (!isEnd) return exchange();
    // Abmelden ist best effort: scheitert es, gilt der Dialog als beendet (die Bank beendet ihn per Zeitablauf).
    try {
      return await exchange();
    } catch {
      state.ended = true;
      state.open = false;
      return new Message([
        { header: { segId: "HNHBK", segNr: 1, version: 3 }, messageLength: 0, hbciVersion: 300, dialogId: state.dialogId, msgNr: state.lastMsgNr } as Segment,
        { header: { segId: "HIRMG", segNr: 2, version: 2 }, answers: [{ code: 100, text: "" }] } as Segment,
      ]);
    }
  }

  /** POST mit Base64-Koerper; liefert den Antwort-Text (Base64) bei Status 200. */
  private async post(body: Buffer, timeoutMs: number): Promise<string> {
    const target = await this.resolveTarget();
    const connector = this.opts.connector;
    const maxBase64 = Math.ceil((FINTS_MAX_RESPONSE_BYTES * 4) / 3) + 8;
    const payload = Buffer.from(body.toString("base64"), "latin1");
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let req: ReturnType<typeof https.request> | null = null;
      const finish = (err: FintsError | null, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimer);
        if (err) {
          req?.destroy();
          reject(err);
        } else {
          resolve(value ?? "");
        }
      };
      const timer = setTimeout(() => finish(new FintsError("TIMEOUT")), timeoutMs);
      const connectTimer = setTimeout(() => finish(new FintsError("TIMEOUT")), FINTS_CONNECT_TIMEOUT_MS);
      try {
        req = https.request(
          {
            host: target.host,
            port: connector?.port ?? 443,
            path: this.opts.path,
            method: "POST",
            headers: { "Content-Type": "text/plain", "Content-Length": String(payload.length) },
            // Feste, vorher geprueften Adresse; kein erneutes DNS.
            lookup: (_host, options, callback) => {
              if (options.all) callback(null, [{ address: target.address, family: target.family }]);
              else callback(null, target.address, target.family);
            },
            servername: target.host,
            ca: connector?.ca,
            minVersion: "TLSv1.2",
            rejectUnauthorized: true,
            agent: false,
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.destroy();
              return finish(new FintsError("HTTP_STATUS"));
            }
            const declared = Number(res.headers["content-length"]);
            if (Number.isFinite(declared) && declared > maxBase64) {
              res.destroy();
              return finish(new FintsError("TOO_LARGE"));
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxBase64) {
                res.destroy();
                return finish(new FintsError("TOO_LARGE"));
              }
              chunks.push(chunk);
            });
            res.on("end", () => finish(null, Buffer.concat(chunks).toString("latin1")));
            res.on("error", () => finish(new FintsError("CONNECT_FAILED")));
            res.on("aborted", () => finish(new FintsError("CONNECT_FAILED")));
          },
        );
      } catch {
        return finish(new FintsError("CONNECT_FAILED"));
      }
      req.on("socket", (socket) => {
        socket.once("secureConnect", () => clearTimeout(connectTimer));
      });
      req.on("error", (err: NodeJS.ErrnoException) => finish(new FintsError(errorCodeFromNode(err))));
      req.end(payload);
    });
  }

  /** Prueft die Antwort vor dem Lesen und dekodiert sie; wirft nur FintsError. */
  private async receive(base64: string, sent: CustomerMessage, kind: { isInit: boolean; isEnd: boolean }): Promise<Message> {
    const state = this.state;
    const trimmed = base64.replace(/[\r\n\t ]+$/, "");
    if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !BASE64.test(trimmed)) throw new FintsError("DECODE_FAILED");
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.length > FINTS_MAX_RESPONSE_BYTES) throw new FintsError("TOO_LARGE");
    state.bytes += bytes.length;
    if (state.bytes > FINTS_MAX_BYTES_PER_DIALOG) throw new FintsError("TOO_LARGE");
    const text = bytes.toString("latin1");
    const ends = countSegmentEnds(text, FINTS_MAX_SEGMENTS);
    if (ends < 0) throw new FintsError("DECODE_FAILED");
    if (ends > FINTS_MAX_SEGMENTS) throw new FintsError("TOO_LARGE");
    const parted = (sent as { supportsPartedResponseSegments?: boolean; orderResponseSegId?: string }).supportsPartedResponseSegments
      ? ((sent as { orderResponseSegId?: string }).orderResponseSegId ?? null)
      : null;

    // Probe im Worker (Zeit- und Heap-Grenze): nur wenn sie gelingt, dekodiert der Hauptprozess.
    const limits = probeLimits(bytes.length);
    const probe = await runIsolated<{ text: string; parted: string | null }, boolean>({
      job: "probe-decode",
      script: "fints",
      input: { text, parted },
      timeoutMs: limits.timeoutMs,
      maxHeapMb: limits.maxHeapMb,
    });
    if (!probe.ok) throw new FintsError("DECODE_FAILED");
    let response: Message;
    try {
      response = Message.decode(text, parted ?? undefined);
    } catch {
      throw new FintsError("DECODE_FAILED");
    }

    // Eine Antwort ohne Rueckmeldung zur Nachricht (HIRMG 0010/0100 oder ein Fehlercode) ist kein Erfolg.
    const hirmg = response.findAllSegments("HIRMG") as unknown as HirmgLike[];
    const hirmgCodes = hirmg.flatMap((s) => s.answers.map((a) => a.code));
    if (!hirmgCodes.some((c) => c === 10 || c === 100 || c >= 9000)) throw new FintsError("PROTOCOL_ERROR");

    const codes = sanitizeCodes(response.getBankAnswers().map((a) => String(a.code).padStart(4, "0")));
    if (!kind.isEnd) state.lastCodes = codes.slice(0, 10);
    const answerHnhbk = response.findSegment("HNHBK") as (Segment & Partial<HnhbkLike>) | undefined;
    if (answerHnhbk && typeof answerHnhbk.dialogId === "string" && /^[A-Za-z0-9]{1,30}$/.test(answerHnhbk.dialogId)) {
      state.dialogId = answerHnhbk.dialogId;
    }

    if (!kind.isEnd) {
      const { cls, unknownInInit } = classifyCodes(codes, state.initAccepted ? "ORDER" : "INIT");
      // Nach einer Ablehnung der Anmeldung nie mehr mit der PIN senden, auch kein Abmelden.
      if (cls === "LOCKED" || cls === "AUTH" || unknownInInit) state.open = false;
      if (cls === "LOCKED") throw new FintsError("ACCESS_LOCKED", codes);
      if (cls === "AUTH") throw new FintsError("PIN_REJECTED", codes);
      if (cls === "TAN_REJECTED") throw new FintsError("SCA_REJECTED", codes);
      if (cls === "OTHER") throw new FintsError(unknownInInit ? "AUTH_UNCLEAR" : "BANK_ERROR", codes);
      if (cls === "SCA") state.scaSeen = true;
      if (kind.isInit) {
        state.initAccepted = true;
        state.open = state.dialogId !== "0";
      }
    }
    if (dialogEnded(codes)) {
      state.ended = true;
      state.open = false;
    }
    return response;
  }
}
