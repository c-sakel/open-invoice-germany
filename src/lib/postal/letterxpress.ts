/**
 * Phase 16d — Client fuer die Briefdienst-API LetterXpress v3 (rein, ohne eigenen Netzzugriff:
 * der Transport wird injiziert, siehe transport.ts).
 *
 * Quelle: API-Dokumentation Stand Juli 2026 (35 S.): Authentifizierung S. 4-6, Letter-Objekt
 * S. 7-9, /balance S. 10, /price S. 10-11, GET /printjobs S. 12-14, POST /printjobs S. 14-15,
 * GET /printjobs/{id} S. 15-16, DELETE S. 19, Statusmeldungen S. 33.
 *
 * Abweichungen Doku vs. Spec (Plan 16d, Abschnitt "Abweichungen" 1-10), soweit hier relevant:
 *  1. Basis-URL fest HTTPS; 2. `auth` in jedem Request, auch GET/DELETE; 3. Testmodus ist keine
 *  Sandbox (Postbox); 4. Auftragsstatus zusaetzlich `draft`; 5. Preisabfrage: `pages` unter
 *  specification, `registered` auf letter-Ebene, shipping nur national|international; 6. DELETE
 *  nur binnen 15 min und nicht bei `done`; 7. nicht genutzte Felder (c4, bank_form, ...);
 *  8. Fehlerkoerper nur fuer 401 dokumentiert, kein 429 -> defensives Parsen, Timeout/5xx =
 *  "unklar"; 9. kein Idempotenzschluessel -> Abgleich ueber filename_original; 10. Antwortformat
 *  {status, message, data}, items[].address ist ein kommagetrennter String.
 *
 * Geheimnisse: Fehlertexte des Anbieters werden geschwaerzt und gekuerzt; protokollierbare
 * Zusammenfassung (PrintJobSummary) enthaelt weder `auth` noch `base64_file`.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { PostalTransportError, type LxpMethod, type LxpTransport } from "./transport";

export type LxpAuthMode = "test" | "live";

export interface LxpCredentials {
  username: string;
  apiKey: string;
  mode: LxpAuthMode;
}

export interface LxpSpec {
  color: "1" | "4";
  mode: "simplex" | "duplex";
  shipping: "national" | "international" | "auto";
}

export interface LxpPrintJob {
  id: number;
  status: "queue" | "hold" | "done" | "canceled" | "draft";
  filenameOriginal: string | null;
  createdAt: string;
  items: {
    address: string | null;
    pages: number;
    amountCents: number;
    vatCents: number;
    status: string;
    trackingCode: string | null;
    trackingStatus: string | null;
  }[];
}

export interface PrintJobSummary {
  specification: LxpSpec;
  registered: string | null;
  filename_original: string;
  notice: string;
  base64Length: number;
  base64Md5: string;
  pdfSha256: string;
}

/** 401: Zugangsdaten abgelehnt. */
export class LxpAuthError extends Error {
  constructor(msg = "Zugangsdaten abgelehnt") {
    super(msg);
    this.name = "LxpAuthError";
  }
}

/** 400/403/404/405: endgueltig abgelehnt. */
export class LxpRequestError extends Error {
  constructor(
    msg: string,
    readonly status: number,
  ) {
    super(msg);
    this.name = "LxpRequestError";
  }
}

/** Timeout, Netz, 429, 5xx, unlesbare Antwort: Ausgang unklar. */
export class LxpUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LxpUnavailableError";
  }
}

const MAX_EUR = 1e9;

/** Euro (JSON-Zahl) -> Cent ueber die Dezimalstring-Darstellung, halb-auf (vom Betrag her), nie `*100`. */
export function eurAmountToCents(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > MAX_EUR) {
    throw new Error("Ungueltiger Betrag.");
  }
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error("Ungueltiger Betrag.");
  const frac = m[3] ?? "";
  let cents = Number(m[2]) * 100 + Number((frac + "00").slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return m[1] === "-" ? -cents : cents;
}

/** MD5 (hex) des Base64-STRINGS (nicht der Rohbytes), wie die Doku verlangt (S. 7). */
export function base64Md5(base64: string): string {
  return createHash("md5").update(base64, "utf8").digest("hex");
}

export function redact(text: string, c: Pick<LxpCredentials, "username" | "apiKey">): string {
  let out = text;
  for (const secret of [c.apiKey, c.username]) {
    if (secret) out = out.split(secret).join("***");
  }
  return out.slice(0, 300);
}

export function buildPrintJobBody(
  c: LxpCredentials,
  p: { pdf: Buffer; spec: LxpSpec; registered: "r1" | "r2" | null; filename: string; notice: string },
): { body: object; summary: PrintJobSummary } {
  const base64 = p.pdf.toString("base64");
  const checksum = base64Md5(base64);
  const notice = p.notice.slice(0, 255);
  const letter: Record<string, unknown> = {
    base64_file: base64,
    base64_file_checksum: checksum,
    specification: { color: p.spec.color, mode: p.spec.mode, shipping: p.spec.shipping },
    filename_original: p.filename,
    notice,
  };
  if (p.registered) letter.registered = p.registered;
  return {
    body: { auth: authOf(c), letter },
    summary: {
      specification: { ...p.spec },
      registered: p.registered,
      filename_original: p.filename,
      notice,
      base64Length: base64.length,
      base64Md5: checksum,
      pdfSha256: createHash("sha256").update(p.pdf).digest("hex"),
    },
  };
}

function authOf(c: LxpCredentials): { username: string; apikey: string; mode: LxpAuthMode } {
  return { username: c.username, apikey: c.apiKey, mode: c.mode };
}

const envelope = z.object({ status: z.number(), message: z.string().optional(), data: z.unknown() }).loose();

const amount = z.number().refine((n) => Number.isFinite(n));
const jobSchema = z
  .object({
    id: z.number().int(),
    status: z.enum(["queue", "hold", "done", "canceled", "draft"]),
    filename_original: z.string().nullable().optional(),
    created_at: z.string(),
    items: z.array(
      z
        .object({
          address: z.string().nullable().optional(),
          pages: z.number().int(),
          amount,
          vat: amount,
          status: z.string(),
          tracking_code: z.string().nullable().optional(),
          tracking_status: z.string().nullable().optional(),
        })
        .loose(),
    ),
  })
  .loose();

const balanceSchema = z.object({ balance: amount, currency: z.string() }).loose();
const priceSchema = z.object({ price: amount }).loose();
const listSchema = z
  .object({
    printjobs: z.array(jobSchema),
    pagination: z.object({ last_page: z.number().int() }).loose(),
  })
  .loose();

function toJob(j: z.infer<typeof jobSchema>): LxpPrintJob {
  return {
    id: j.id,
    status: j.status,
    filenameOriginal: j.filename_original ?? null,
    createdAt: j.created_at,
    items: j.items.map((i) => ({
      address: i.address ?? null,
      pages: i.pages,
      amountCents: eurAmountToCents(i.amount),
      vatCents: eurAmountToCents(i.vat),
      status: i.status,
      trackingCode: i.tracking_code ?? null,
      trackingStatus: i.tracking_status ?? null,
    })),
  };
}

const POST_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export function createLetterXpressClient(c: LxpCredentials, transport: LxpTransport) {
  async function call(
    method: LxpMethod,
    path: string,
    body: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<unknown> {
    let res;
    try {
      res = await transport({
        method,
        path,
        query,
        body: { ...body, auth: authOf(c) },
        timeoutMs: method === "POST" ? POST_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      });
    } catch (e) {
      if (e instanceof PostalTransportError) throw new LxpUnavailableError(redact(e.message, c));
      throw e;
    }
    if (res.status === 401) throw new LxpAuthError();
    if ([400, 403, 404, 405].includes(res.status)) {
      const msg = z.object({ message: z.string() }).loose().safeParse(res.json);
      throw new LxpRequestError(redact(msg.success ? msg.data.message : `Anfrage abgelehnt (${res.status}).`, c), res.status);
    }
    if (res.status !== 200) throw new LxpUnavailableError(`Briefdienst nicht verfuegbar (${res.status}).`);
    const env = envelope.safeParse(res.json);
    if (!env.success || env.data.status !== 200) throw new LxpUnavailableError("Unlesbare Antwort des Briefdienstes.");
    return env.data.data;
  }

  function parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const r = schema.safeParse(data);
    if (!r.success) throw new LxpUnavailableError("Unlesbare Antwort des Briefdienstes.");
    return r.data;
  }

  function safeCents(n: number): number {
    try {
      return eurAmountToCents(n);
    } catch {
      throw new LxpUnavailableError("Unlesbarer Betrag in der Antwort.");
    }
  }

  function job(data: unknown): LxpPrintJob {
    const j = parse(jobSchema, data);
    for (const i of j.items) {
      safeCents(i.amount);
      safeCents(i.vat);
    }
    return toJob(j);
  }

  return {
    async balance(): Promise<{ balanceCents: number; currency: string }> {
      const d = parse(balanceSchema, await call("GET", "/balance", {}));
      return { balanceCents: safeCents(d.balance), currency: d.currency };
    },
    async price(p: {
      pages: number;
      color: "1" | "4";
      duplex: boolean;
      shipping: "national" | "international";
      registered: "r1" | "r2" | null;
    }): Promise<{ priceCents: number }> {
      const letter: Record<string, unknown> = {
        specification: { pages: p.pages, color: p.color, mode: p.duplex ? "duplex" : "simplex", shipping: p.shipping },
      };
      if (p.registered) letter.registered = p.registered;
      const d = parse(priceSchema, await call("GET", "/price", { letter }));
      return { priceCents: safeCents(d.price) };
    },
    async submit(body: object): Promise<LxpPrintJob> {
      return job(await call("POST", "/printjobs", { ...body }));
    },
    async get(id: number): Promise<LxpPrintJob> {
      return job(await call("GET", `/printjobs/${encodeURIComponent(String(id))}`, {}));
    },
    async list(
      filter: "queue" | "hold" | "done" | "canceled" | "draft",
      page: number,
    ): Promise<{ jobs: LxpPrintJob[]; lastPage: number }> {
      const d = parse(listSchema, await call("GET", "/printjobs", {}, { filter, page: String(page) }));
      d.printjobs.forEach((j) => job(j));
      return { jobs: d.printjobs.map(toJob), lastPage: d.pagination.last_page };
    },
    async remove(id: number): Promise<void> {
      await call("DELETE", `/printjobs/${encodeURIComponent(String(id))}`, {});
    },
  };
}
