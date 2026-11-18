/**
 * Adapter um `lib-fints` hinter der Schnittstelle `FintsClient`. Die Bibliothek bekommt
 *  - einen eigenen Transport (Haken auf `Dialog.prototype.getHttpClient`, je Konfiguration; nie ihr HTTP-Client, nie fetch),
 *  - einen Sammler fuer CAMT-Dokumente (Haken auf `addCustomerInteraction`): die Rohdokumente werden geprueft und
 *    zurueckgegeben, der CAMT-Parser der Bibliothek laeuft nie auf Bankdaten,
 *  - `debugEnabled = false`.
 * Jeder Fehler wird auf einen festen Code abgebildet; Fehlertexte der Bibliothek und Banktexte verlassen den Adapter nie.
 * Die einzigen Banktexte sind die Challenge (gekuerzt, ohne Steuerzeichen) und das Bild der Freigabe.
 */
import { CustomerMessage, Dialog, FinTSClient, FinTSConfig } from "lib-fints";
import type { BankAccount, BankingInformation, ClientResponse, Message, Segment } from "lib-fints";
import {
  FINTS_MAX_BANKING_INFO_BYTES,
  FINTS_MAX_CHALLENGE_CHARS,
  FINTS_MAX_DOCUMENT_BYTES,
  FINTS_MAX_DOCUMENT_TOTAL_BYTES,
  FINTS_MAX_DOCUMENTS,
  FINTS_MAX_STATUS_POLLS,
  FINTS_MAX_TAN_IMAGE_BYTES,
  FINTS_MIN_WAIT_MS,
} from "@/domain/bank-fetch/limits";
import { assertSafeXml, decodeCamtBytes } from "@/domain/bank/camt-xml";
import { FintsError } from "./client";
import type {
  FintsAccess,
  FintsAccountInfo,
  FintsCamtResult,
  FintsClient,
  FintsSession,
  FintsStep,
  FintsSyncResult,
  ScaChallenge,
} from "./client";
import { FintsTransport } from "./transport";
import type { TestConnector } from "./transport";
import { fintsNetworkBlocked, parseFintsUrl } from "./url-guard";

export type { TestConnector } from "./transport";

interface InteractionLike {
  segId: string;
  handleResponse: (response: Message, clientResponse: { statements?: unknown[] }) => void;
}

interface DialogProto {
  getHttpClient: (this: { config: object }) => unknown;
  addCustomerInteraction: (this: { config: object }, interaction: InteractionLike, afterCurrent?: boolean) => void;
}

interface Registry {
  transports: WeakMap<object, FintsTransport>;
  collectors: WeakMap<object, CamtCollector>;
  installed: boolean;
}

const REGISTRY_KEY = Symbol.for("openinvoice.fints.registry");

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let reg = holder[REGISTRY_KEY];
  if (!reg) {
    reg = { transports: new WeakMap(), collectors: new WeakMap(), installed: false };
    holder[REGISTRY_KEY] = reg;
  }
  return reg;
}

/** Haken einmalig installieren; false, wenn die Bibliothek die erwarteten Stellen nicht (mehr) hat. */
function installHooks(): boolean {
  const reg = registry();
  if (reg.installed) return true;
  const proto = Dialog.prototype as unknown as Partial<DialogProto>;
  const original = proto.addCustomerInteraction;
  if (typeof proto.getHttpClient !== "function" || typeof original !== "function") return false;
  proto.getHttpClient = function (this: { config: object }): unknown {
    const transport = registry().transports.get(this.config);
    // Ohne registrierten Transport nie auf den HTTP-Client der Bibliothek zurueckfallen.
    if (!transport) throw new FintsError("PROTOCOL_ERROR");
    return transport;
  };
  proto.addCustomerInteraction = function (this: { config: object }, interaction: InteractionLike, afterCurrent?: boolean): void {
    if (interaction.segId === "HKCAZ") {
      const collector = registry().collectors.get(this.config);
      if (collector) {
        interaction.handleResponse = (response, clientResponse) => collector.collect(response, clientResponse);
      }
    }
    original.call(this, interaction, afterCurrent);
  };
  reg.installed = true;
  return true;
}

const DOC_SIZE_ERROR = new Set(["TOO_LARGE"]);

/** Sammelt die Rohdokumente (HICAZ) eines Abrufs; die Bibliothek parst sie nie. */
class CamtCollector {
  invoked = false;
  documents: Uint8Array[] = [];
  bytes = 0;
  private iban = "";

  reset(iban: string): void {
    this.invoked = false;
    this.documents = [];
    this.bytes = 0;
    this.iban = iban;
  }

  collect(response: Message, clientResponse: { statements?: unknown[] }): void {
    this.invoked = true;
    clientResponse.statements = [];
    const segments = response.findAllSegments("HICAZ") as unknown as { bookedTransactions?: string[] }[];
    for (const segment of segments) {
      for (const raw of segment.bookedTransactions ?? []) {
        if (typeof raw !== "string") throw new FintsError("CAMT_UNSAFE");
        if (this.documents.length + 1 > FINTS_MAX_DOCUMENTS) throw new FintsError("TOO_LARGE");
        const bytes = Buffer.from(raw, "latin1");
        if (bytes.length > FINTS_MAX_DOCUMENT_BYTES || this.bytes + bytes.length > FINTS_MAX_DOCUMENT_TOTAL_BYTES) {
          throw new FintsError("TOO_LARGE");
        }
        let xml: string;
        try {
          xml = decodeCamtBytes(bytes);
          assertSafeXml(xml);
        } catch (e) {
          const code = (e as { code?: unknown }).code;
          throw new FintsError(typeof code === "string" && DOC_SIZE_ERROR.has(code) ? "TOO_LARGE" : "CAMT_UNSAFE");
        }
        if (!firstIbanMatches(xml, this.iban)) throw new FintsError("ACCOUNT_MISMATCH");
        this.bytes += bytes.length;
        this.documents.push(new Uint8Array(bytes));
      }
    }
  }
}

/** Die erste IBAN im Dokument (Konto des Berichts) muss die abgefragte sein. */
function firstIbanMatches(xml: string, iban: string): boolean {
  const m = /<(?:[A-Za-z0-9_-]+:)?IBAN>\s*([A-Za-z0-9 ]{10,40}?)\s*<\/(?:[A-Za-z0-9_-]+:)?IBAN>/.exec(xml);
  if (!m?.[1]) return false;
  return m[1].replace(/\s+/g, "").toUpperCase() === iban;
}

function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

function toFintsError(e: unknown): FintsError {
  return e instanceof FintsError ? e : new FintsError("PROTOCOL_ERROR");
}

function cleanChallengeText(text: unknown): string {
  if (typeof text !== "string") return "";
  let t = text;
  // Die Bibliothek liest die Leitung als Latin1; Banken mit UTF-8 liefern sonst Zeichensalat.
  if (/[Â-ô][\u0080-¿]/.test(t)) {
    try {
      t = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(t, "latin1"));
    } catch {
      // bleibt Latin1
    }
  }
  return Array.from(t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim())
    .slice(0, FINTS_MAX_CHALLENGE_CHARS)
    .join("");
}

function imageOf(bytes: Uint8Array | undefined): ScaChallenge["image"] {
  if (!bytes || bytes.length === 0 || bytes.length > FINTS_MAX_TAN_IMAGE_BYTES) return null;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > png.length && png.every((b, i) => bytes[i] === b)) return { mime: "image/png", bytes: new Uint8Array(bytes) };
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", bytes: new Uint8Array(bytes) };
  }
  return null;
}

const TAN_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(day: string): Date {
  if (!DAY_PATTERN.test(day)) throw new FintsError("PROTOCOL_ERROR");
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) throw new FintsError("PROTOCOL_ERROR");
  return d;
}

function parseBankingInfo(json: string | null): BankingInformation | undefined {
  if (json === null) return undefined;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v === "object" && v !== null && typeof (v as { systemId?: unknown }).systemId === "string") {
      return { ...(v as BankingInformation), bankMessages: [] };
    }
  } catch {
    // ungueltig: wie beim ersten Mal anmelden
  }
  return undefined;
}

type Pending = { kind: "sync" | "camt"; reference: string };

class LibFintsSession implements FintsSession {
  private readonly config: FinTSConfig;
  private readonly client: FinTSClient;
  private readonly transport: FintsTransport;
  private readonly collector = new CamtCollector();
  private pending: Pending | null = null;
  /** Tatsaechlich angefragter Beginn des laufenden Kontoabrufs (Tag), nach der Abrufgrenze der Bank. */
  private camtFrom: string | undefined;
  private busy = false;

  constructor(
    access: FintsAccess,
    private readonly allowSca: boolean,
    connector: TestConnector | undefined,
  ) {
    if (!connector && fintsNetworkBlocked()) throw new FintsError("NETWORK_BLOCKED");
    const { host, path } = parseFintsUrl(access.url);
    if (!installHooks()) throw new FintsError("PROTOCOL_ERROR");
    try {
      const info = parseBankingInfo(access.bankingInfo);
      const customerId = access.customerId ?? undefined;
      this.config = info
        ? FinTSConfig.fromBankingInformation(
            access.productId,
            access.productVersion,
            info,
            access.userId,
            access.pin,
            access.tanMethodId ?? undefined,
            access.tanMediaName ?? undefined,
            customerId,
          )
        : FinTSConfig.forFirstTimeUse(access.productId, access.productVersion, `https://${host}${path}`, access.bankCode, access.userId, access.pin, customerId);
      this.config.debugEnabled = false;
    } catch {
      throw new FintsError("PROTOCOL_ERROR");
    }
    this.transport = new FintsTransport({ host, path, connector });
    const reg = registry();
    reg.transports.set(this.config, this.transport);
    reg.collectors.set(this.config, this.collector);
    this.client = new FinTSClient(this.config);
    this.verifyHooks();
  }

  /** Vor jedem Netz: die Bibliothek muss wirklich unseren Transport und Sammler benutzen. */
  private verifyHooks(): void {
    try {
      const probe = new Dialog(this.config);
      const sentinel = (): void => undefined;
      const interaction: InteractionLike = { segId: "HKCAZ", handleResponse: sentinel };
      probe.addCustomerInteraction(interaction as unknown as Parameters<Dialog["addCustomerInteraction"]>[0]);
      if (probe.httpClient !== (this.transport as unknown) || interaction.handleResponse === sentinel) {
        throw new FintsError("PROTOCOL_ERROR");
      }
    } catch {
      throw new FintsError("PROTOCOL_ERROR");
    }
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new FintsError("PROTOCOL_ERROR");
    this.busy = true;
    try {
      return await fn();
    } catch (e) {
      this.pending = null;
      await this.endDialog();
      throw toFintsError(e);
    } finally {
      this.busy = false;
    }
  }

  /** Dialog beenden (HKEND, best effort). Nie nach einer abgelehnten Anmeldung (dann ist der Dialog nicht offen). */
  private async endDialog(): Promise<void> {
    const st = this.transport.state;
    if (!st.open || st.ended) return;
    try {
      const tan = this.config.selectedTanMethod;
      const message = new CustomerMessage(st.dialogId, st.lastMsgNr + 1);
      message.sign(
        this.config.countryCode,
        this.config.bankId,
        this.config.userId ?? "",
        this.config.pin ?? "",
        this.config.bankingInformation.systemId,
        tan !== undefined && tan.version >= 6 ? this.config.tanMethodId : undefined,
      );
      const hkend = { header: { segId: "HKEND", segNr: 0, version: 1 }, dialogId: st.dialogId } as Segment;
      message.addSegment(hkend);
      await this.transport.sendMessage(message);
    } catch {
      // best effort
    }
  }

  private beginOperation(): void {
    this.transport.state.scaSeen = false;
  }

  private challengeOf(resp: ClientResponse): ScaChallenge {
    const tan = this.config.selectedTanMethod;
    const params = tan?.decoupled;
    const decoupled = tan?.isDecoupled === true;
    const seconds = (v: number | undefined): number => Math.max(FINTS_MIN_WAIT_MS, Math.min(Math.max(v ?? 0, 0), 600) * 1000);
    const bankMax = params?.maxStatusRequests ?? 0;
    return {
      decoupled,
      text: cleanChallengeText(resp.tanChallenge),
      image: imageOf(resp.tanPhoto?.image),
      waitFirstMs: seconds(params?.waitingSecondsBeforeFirstStatusRequest),
      waitNextMs: seconds(params?.waitingSecondsBetweenStatusRequests),
      maxPolls: Math.min(bankMax > 0 ? bankMax : FINTS_MAX_STATUS_POLLS, FINTS_MAX_STATUS_POLLS),
    };
  }

  private syncResult(): FintsSyncResult {
    const config = this.config;
    const params = config.getTransactionParameters<{ maxDays?: number; supportedCamtFormats?: string[] }>("HKCAZ");
    const camtFormats = (params?.supportedCamtFormats ?? []).filter((f) => f.startsWith("urn:iso:std:iso:20022:tech:xsd:camt.052.001."));
    const accounts: FintsAccountInfo[] = [];
    for (const a of config.bankingInformation.upd?.bankAccounts ?? []) {
      if (typeof a.iban !== "string" || a.iban.length === 0) continue;
      let camt = false;
      try {
        camt = camtFormats.length > 0 && config.getMaxSupportedTransactionVersion("HKCAZ") !== undefined && config.isAccountTransactionSupported(a, "HKCAZ");
      } catch {
        camt = false;
      }
      accounts.push({
        iban: normalizeIban(a.iban),
        accountNumber: a.accountNumber ?? null,
        subAccount: a.subAccountId ?? null,
        currency: a.currency ?? null,
        productName: a.product ?? null,
        camtSupported: camt,
      });
    }
    return {
      tanMethods: config.availableTanMethods.map((m) => ({
        id: m.id,
        name: m.name,
        decoupled: m.isDecoupled,
        media: m.activeTanMedia,
        mediaRequired: (m.tanMediaRequirement as number) === 2,
      })),
      accounts,
      camtFormats,
      maxHistoryDays: typeof params?.maxDays === "number" ? params.maxDays : null,
    };
  }

  private async toStep(
    resp: ClientResponse | undefined,
    kind: Pending["kind"],
  ): Promise<FintsStep<FintsSyncResult | FintsCamtResult>> {
    if (!resp) throw new FintsError("PROTOCOL_ERROR");
    if (resp.requiresTan) {
      if (typeof resp.tanReference !== "string" || resp.tanReference === "") throw new FintsError("PROTOCOL_ERROR");
      const challenge = this.challengeOf(resp);
      if (!this.allowSca) {
        this.pending = null;
        await this.endDialog();
        return { kind: "sca", challenge };
      }
      this.pending = { kind, reference: resp.tanReference };
      return { kind: "sca", challenge };
    }
    if (!resp.success) throw new FintsError("BANK_ERROR", this.transport.state.lastCodes);
    this.pending = null;
    const base = { scaUsed: this.transport.state.scaSeen, bankCodes: this.transport.state.lastCodes };
    if (kind === "sync") return { kind: "done", value: this.syncResult(), ...base };
    if (!this.collector.invoked) throw new FintsError("PROTOCOL_ERROR");
    return { kind: "done", value: { documents: this.collector.documents, bytes: this.collector.bytes, ...(this.camtFrom !== undefined ? { from: this.camtFrom } : {}) }, ...base };
  }

  synchronize(): Promise<FintsStep<FintsSyncResult>> {
    return this.run(async () => {
      await this.endDialog();
      this.beginOperation();
      const resp = await this.client.synchronize();
      return (await this.toStep(resp, "sync")) as FintsStep<FintsSyncResult>;
    });
  }

  fetchCamt(iban: string, from: string, to: string): Promise<FintsStep<FintsCamtResult>> {
    return this.run(async () => {
      await this.endDialog();
      const wanted = normalizeIban(iban);
      const account = this.findAccount(wanted);
      const fromDay = parseDay(from);
      const toDay = parseDay(to);
      if (fromDay.getTime() > toDay.getTime()) throw new FintsError("PROTOCOL_ERROR");
      const params = this.config.getTransactionParameters<{ maxDays?: number; supportedCamtFormats?: string[] }>("HKCAZ");
      const formats = (params?.supportedCamtFormats ?? []).filter((f) => f.startsWith("urn:iso:std:iso:20022:tech:xsd:camt.052.001."));
      let supported = false;
      try {
        supported =
          formats.length > 0 &&
          this.config.getMaxSupportedTransactionVersion("HKCAZ") !== undefined &&
          this.config.isAccountTransactionSupported(account, "HKCAZ");
      } catch {
        supported = false;
      }
      if (!supported) throw new FintsError("NO_CAMT");
      // Die Bank begrenzt, wie weit zurueck Umsaetze abrufbar sind.
      const maxDays = typeof params?.maxDays === "number" && params.maxDays > 0 ? params.maxDays : null;
      const earliest = maxDays === null ? fromDay.getTime() : toDay.getTime() - maxDays * 86_400_000;
      const effectiveFrom = new Date(Math.max(fromDay.getTime(), earliest));
      this.camtFrom = effectiveFrom.toISOString().slice(0, 10);
      this.beginOperation();
      this.collector.reset(wanted);
      const resp = await this.client.getAccountStatements(account, effectiveFrom, toDay, true);
      return (await this.toStep(resp, "camt")) as FintsStep<FintsCamtResult>;
    });
  }

  private findAccount(iban: string): BankAccount {
    const list = this.config.bankingInformation.upd?.bankAccounts ?? [];
    const hit = list.find((a) => typeof a.iban === "string" && normalizeIban(a.iban) === iban);
    if (!hit) throw new FintsError("PROTOCOL_ERROR");
    return hit;
  }

  continueSca(tan?: string): Promise<FintsStep<FintsSyncResult | FintsCamtResult>> {
    const pending = this.pending;
    if (!pending) return Promise.reject(new FintsError("PROTOCOL_ERROR"));
    const decoupled = this.config.selectedTanMethod?.isDecoupled === true;
    if (!decoupled && (typeof tan !== "string" || !TAN_PATTERN.test(tan))) return Promise.reject(new FintsError("TAN_FORMAT"));
    return this.run(async () => {
      // Bei der Freigabe in der App wird keine TAN gesendet (die Bibliothek fragt nur den Status ab).
      const resp =
        pending.kind === "sync"
          ? await this.client.synchronizeWithTan(pending.reference, decoupled ? undefined : tan)
          : await this.client.getAccountStatementsWithTan(pending.reference, decoupled ? undefined : tan);
      return this.toStep(resp, pending.kind);
    });
  }

  bankingInfo(): string | null {
    const info: BankingInformation = { ...this.config.bankingInformation, bankMessages: [] };
    if (!info.bpd && !info.upd && info.systemId === "0") return null;
    const json = JSON.stringify(info);
    if (Buffer.byteLength(json, "utf8") > FINTS_MAX_BANKING_INFO_BYTES) throw new FintsError("TOO_LARGE");
    return json;
  }

  async close(): Promise<void> {
    this.pending = null;
    try {
      await this.endDialog();
    } catch {
      // wirft nie
    }
  }
}

export function createFintsClient(opts: { connector?: TestConnector } = {}): FintsClient {
  return {
    open(access, options) {
      return new LibFintsSession(access, options?.allowSca !== false, opts.connector);
    },
  };
}
