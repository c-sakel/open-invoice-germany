/**
 * Worker fuer fremde Bytes (Eingangsrechnungen). Reines ESM-JavaScript ohne Projekt-Importe,
 * damit es unveraendert im Standalone-Output laeuft. Je Auftrag ein Worker mit Heap- und
 * Zeitgrenze (siehe src/lib/worker/isolated.ts).
 *
 * Auftrag "pdf-attachments": liest NUR eingebettete Dateien aus einem PDF. Kein PDF-Parser:
 * ein Scanner sucht Stream-Objekte vom Typ /EmbeddedFile und dekomprimiert jede Anlage mit
 * harter Obergrenze. Seiteninhalt, Skripte, Formulare, Schriften und Objektstroeme werden nie
 * ausgewertet (ArrayBuffer-Speicher faellt nicht unter die Heap-Grenze, daher keine
 * Bibliothek, die beliebig viel dekomprimiert).
 */
import { parentPort, workerData } from "node:worker_threads";
import { constants, inflateSync } from "node:zlib";

// Grenzen kommen aus src/domain/incoming/limits.ts (workerData.params); dieses Skript hat keine Projekt-Importe.
const PARAMS = workerData?.params ?? {};
const MAX_ATTACHMENTS = PARAMS.maxAttachments;
const MAX_ATTACHMENT_BYTES = PARAMS.maxAttachmentBytes;
/** Summe aller entpackten Bytes (Gesamtgrenze gegen Summen-Bomben). */
const MAX_TOTAL_BYTES = PARAMS.maxTotalBytes;
/** Vorkommen von /EmbeddedFile, die ueberhaupt geprueft werden. */
const MAX_CANDIDATES = PARAMS.maxCandidates;
const MAX_NAMETEXT = 400;
/** Suchbereiche sind kurz: nie Kopien ueber beliebig grosse Bereiche. */
const LOOKBACK = 1024;
const MAX_DICT_BYTES = 8192;
const TAIL_BYTES = 64 * 1024;
/** Zaehler fuer den Nachweis, dass nur Anlagen (nie Objektstroeme) entpackt werden. */
const stats = { inflateCalls: 0, inflatedBytes: 0 };

class JobError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const isWord = (b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39);

function latin(buf, from, to) {
  return buf.subarray(Math.max(0, from), Math.min(buf.length, to)).toString("latin1");
}

/** Beginn des Objekts "N G obj", das die Position enthaelt; null wenn nicht gefunden. */
function objectStart(buf, pos) {
  const lo = Math.max(0, pos - LOOKBACK);
  const idx = pos > 0 ? buf.lastIndexOf("obj", pos - 1) : -1;
  if (idx < lo || idx < 0) return null;
  if (idx > 0 && buf[idx - 1] === 0x64) return null; // "endobj": Position liegt ausserhalb eines Objekts
  const from = Math.max(0, idx - 30);
  const m = /(\d+)\s+(\d+)\s+$/.exec(latin(buf, from, idx));
  if (!m) return null;
  return { num: Number(m[1]), at: from + m.index, bodyAt: idx + 3 };
}

/** Letztes Vorkommen von "N G obj" (inkrementelle Updates: neuere Fassung gewinnt). */
function findObject(buf, num) {
  const needle = Buffer.from(`${num} 0 obj`);
  let at = buf.lastIndexOf(needle);
  for (let guard = 0; at >= 0 && guard < 64; guard++) {
    const before = at > 0 ? buf[at - 1] : 0x0a;
    if (!isWord(before)) return at + needle.length;
    at = buf.lastIndexOf(needle, at - 1);
  }
  return -1;
}

function decodePdfString(raw) {
  let bytes;
  if (raw.startsWith("<")) {
    const hex = raw.slice(1, -1).replace(/\s+/g, "");
    bytes = Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex");
  } else {
    const s = raw.slice(1, -1);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== "\\") {
        out.push(s.charCodeAt(i) & 0xff);
        continue;
      }
      const n = s[++i];
      if (n === undefined) break;
      if (/[0-7]/.test(n)) {
        let o = n;
        while (o.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) o += s[++i];
        out.push(parseInt(o, 8) & 0xff);
      } else if (n === "n") out.push(10);
      else if (n === "r") out.push(13);
      else if (n === "t") out.push(9);
      else if (n === "b") out.push(8);
      else if (n === "f") out.push(12);
      else if (n !== "\n" && n !== "\r") out.push(n.charCodeAt(0) & 0xff);
    }
    bytes = Buffer.from(out);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const be = bytes.subarray(2);
    const le = Buffer.alloc(be.length - (be.length % 2));
    for (let i = 0; i < le.length; i += 2) {
      le[i] = be[i + 1];
      le[i + 1] = be[i];
    }
    return le.toString("utf16le").slice(0, MAX_NAMETEXT);
  }
  return bytes.toString("latin1").slice(0, MAX_NAMETEXT);
}

const STRING_RE = String.raw`(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)`;

/** Name je Objektnummer der eingebetteten Datei aus den /Filespec-Woerterbuechern (soweit unkomprimiert). */
function filespecNames(buf) {
  const names = new Map();
  const key = Buffer.from("/EF");
  let from = 0;
  let guard = 0;
  while (guard++ < 1000) {
    const i = buf.indexOf(key, from);
    if (i < 0) break;
    from = i + key.length;
    const around = latin(buf, i - 600, i + 300);
    const rel = i - Math.max(0, i - 600);
    const ef = new RegExp(String.raw`^/EF\s*<<[^>]*?/(?:UF|F)\s+(\d+)\s+\d+\s+R`).exec(around.slice(rel));
    if (!ef) continue;
    const dictStart = Math.max(around.lastIndexOf("<<", rel - 1), 0);
    const scope = around.slice(dictStart, rel + 300);
    const uf = new RegExp(String.raw`/UF\s*${STRING_RE}`).exec(scope);
    const f = new RegExp(String.raw`/F\s*${STRING_RE}`).exec(scope);
    const raw = (uf ?? f)?.[1];
    if (raw) names.set(Number(ef[1]), decodePdfString(raw));
  }
  return names;
}

function resolveLength(buf, dict) {
  const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  if (direct) return Number(direct[1]);
  const ref = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict);
  if (ref) {
    const at = findObject(buf, Number(ref[1]));
    if (at >= 0) {
      const m = /^\s*(\d+)/.exec(latin(buf, at, at + 40));
      if (m) return Number(m[1]);
    }
  }
  return -1;
}

function looksLikeXml(b) {
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && i < 64 && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09)) i++;
  return b[i] === 0x3c;
}

/** Anfang eines Flate-Stroms: aus 2 KB Eingabe hoechstens ~2,1 MB Ausgabe (Flate: max. 1032:1); null bei Fehler. */
function inflateHead(raw) {
  try {
    return inflateSync(raw.subarray(0, 2048), { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: 3 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Ende des Stroms: /Length nur, wenn danach wirklich "endstream" folgt, sonst Suche. */
function streamEnd(buf, p, len) {
  if (len >= 0 && p + len <= buf.length) {
    const tail = latin(buf, p + len, p + len + 16);
    if (/^\s*endstream/.test(tail)) return p + len;
  }
  let e = buf.indexOf("endstream", p);
  // Suche als Rueckfall: den Zeilenumbruch vor "endstream" nicht zur Anlage zaehlen.
  if (e > p && buf[e - 1] === 0x0a) e--;
  if (e > p && buf[e - 1] === 0x0d) e--;
  return e;
}

function extract(input) {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const headAt = buf.subarray(0, 1024).indexOf("%PDF-");
  if (headAt < 0) throw new JobError("BROKEN");
  const tailStart = Math.max(0, buf.length - TAIL_BYTES);
  const tailText = latin(buf, tailStart, buf.length);
  if (tailText.indexOf("%%EOF") < 0) throw new JobError("BROKEN");
  // Verschluesselung steht im Trailer bzw. Xref-Strom-Woerterbuch am Dateiende.
  if (/\/Encrypt\b/.test(tailText)) throw new JobError("ENCRYPTED");

  // Kandidaten sammeln, je Objektnummer nur die letzte (neueste) Fassung.
  const found = new Map();
  const key = Buffer.from("/EmbeddedFile");
  let from = 0;
  let seen = 0;
  for (;;) {
    const i = buf.indexOf(key, from);
    if (i < 0) break;
    from = i + key.length;
    if (isWord(buf[from] ?? 0)) continue; // /EmbeddedFiles (Namensbaum)
    if (++seen > MAX_CANDIDATES) throw new JobError("TOO_MANY");
    const start = objectStart(buf, i);
    if (!start) continue;
    const rel = buf.subarray(i, Math.min(buf.length, i + MAX_DICT_BYTES)).indexOf("stream");
    if (rel < 0) continue;
    const s = i + rel;
    if (s >= 3 && buf.subarray(s - 3, s).toString("latin1") === "end") continue;
    if (s - start.bodyAt > MAX_DICT_BYTES) continue;
    const dict = latin(buf, start.bodyAt, s);
    if (!/\/Type\s*\/EmbeddedFile\b/.test(dict)) continue;
    found.set(start.num, { num: start.num, at: start.at, dict, streamAt: s });
    if (found.size > MAX_ATTACHMENTS) throw new JobError("TOO_MANY");
  }
  const entries = [...found.values()].sort((a, b) => a.at - b.at);
  const names = filespecNames(buf);

  const attachments = [];
  let total = 0;
  for (const e of entries) {
    const name = names.get(e.num) ?? null;
    const skip = (issue) => attachments.push({ name, size: 0, xml: false, bytes: null, issue });
    let p = e.streamAt + 6;
    if (buf[p] === 0x0d) p++;
    if (buf[p] === 0x0a) p++;
    const end = streamEnd(buf, p, resolveLength(buf, e.dict));
    if (end < 0) {
      skip("BROKEN");
      continue;
    }
    const raw = buf.subarray(p, end);
    const filters = [...e.dict.matchAll(/\/([A-Za-z0-9]+Decode|Crypt)\b/g)].map((m) => m[1]);
    if (filters.some((f) => f !== "FlateDecode") || filters.length > 1) {
      skip("UNSUPPORTED");
      continue;
    }
    let data = raw;
    if (filters.length === 1) {
      // Nur die ersten Bytes entpacken; nur XML-artige Anlagen werden ganz entpackt.
      const head = inflateHead(raw);
      if (head === null) {
        skip("BROKEN");
        continue;
      }
      if (!looksLikeXml(head)) {
        skip("NOT_XML");
        continue;
      }
      try {
        stats.inflateCalls++;
        data = inflateSync(raw, { maxOutputLength: Math.min(MAX_ATTACHMENT_BYTES, Math.max(1, MAX_TOTAL_BYTES - total)) });
      } catch (err) {
        if (err && err.code === "ERR_BUFFER_TOO_LARGE") throw new JobError("TOO_LARGE");
        skip("BROKEN");
        continue;
      }
      stats.inflatedBytes += data.length;
    } else if (!looksLikeXml(raw)) {
      skip("NOT_XML");
      continue;
    } else if (raw.length > MAX_ATTACHMENT_BYTES) {
      throw new JobError("TOO_LARGE");
    }
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new JobError("TOO_LARGE");
    attachments.push({ name, size: data.length, xml: true, bytes: new Uint8Array(data) });
  }
  return { attachments, stats };
}

try {
  if (workerData?.job !== "pdf-attachments") throw new JobError("UNKNOWN_JOB");
  for (const v of [MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_BYTES, MAX_CANDIDATES]) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new JobError("BAD_PARAMS");
  }
  parentPort.postMessage({ ok: true, value: extract(workerData.input) });
} catch (err) {
  // Nie Meldung oder Eingabeinhalt weitergeben, nur einen festen Code.
  parentPort.postMessage({ ok: false, code: err instanceof JobError ? err.code : "FAILED" });
}
