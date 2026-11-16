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
import { inflateSync } from "node:zlib";

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Summe der zurueckgegebenen XML-Kandidaten. */
const MAX_RETURNED_BYTES = 30 * 1024 * 1024;
const MAX_NAMETEXT = 400;

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
  const from = Math.max(0, pos - 4000);
  const text = latin(buf, from, pos);
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = { num: Number(m[1]), at: from + m.index, bodyAt: from + m.index + m[0].length };
  return last;
}

/** Letztes Vorkommen von "N G obj" (inkrementelle Updates: neuere Fassung gewinnt). */
function findObject(buf, num) {
  const needle = Buffer.from(`${num} 0 obj`);
  let at = buf.lastIndexOf(needle);
  while (at >= 0) {
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
  while (guard++ < 5000) {
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

function extract(input) {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.indexOf("%PDF-") < 0 || buf.indexOf("%PDF-") > 1024) throw new JobError("BROKEN");
  if (buf.subarray(Math.max(0, buf.length - 2048)).indexOf("%%EOF") < 0) throw new JobError("BROKEN");
  if (/\/Encrypt\b/.test(buf.toString("latin1"))) throw new JobError("ENCRYPTED");

  // Kandidaten sammeln, je Objektnummer nur die letzte (neueste) Fassung.
  const found = new Map();
  const key = Buffer.from("/EmbeddedFile");
  let from = 0;
  for (;;) {
    const i = buf.indexOf(key, from);
    if (i < 0) break;
    from = i + key.length;
    if (isWord(buf[from] ?? 0)) continue; // /EmbeddedFiles (Namensbaum)
    const start = objectStart(buf, i);
    if (!start) continue;
    const s = buf.indexOf("stream", i);
    if (s < 0) continue;
    if (s >= 3 && buf.subarray(s - 3, s).toString("latin1") === "end") continue;
    const dict = latin(buf, start.bodyAt, s);
    if (!/\/Type\s*\/EmbeddedFile\b/.test(dict)) continue;
    found.set(start.num, { num: start.num, at: start.at, dict, streamAt: s });
    if (found.size > MAX_ATTACHMENTS) throw new JobError("TOO_MANY");
  }
  const entries = [...found.values()].sort((a, b) => a.at - b.at);
  const names = filespecNames(buf);

  const attachments = [];
  let returned = 0;
  for (const e of entries) {
    let p = e.streamAt + 6;
    if (buf[p] === 0x0d) p++;
    if (buf[p] === 0x0a) p++;
    const len = resolveLength(buf, e.dict);
    let end;
    if (len >= 0) {
      end = p + len;
      if (end > buf.length) throw new JobError("BROKEN");
    } else {
      end = buf.indexOf("endstream", p);
      if (end < 0) throw new JobError("BROKEN");
    }
    const raw = buf.subarray(p, end);
    const filters = [...e.dict.matchAll(/\/([A-Za-z0-9]+Decode|Crypt)\b/g)].map((m) => m[1]);
    const name = names.get(e.num) ?? null;
    if (filters.some((f) => f !== "FlateDecode")) {
      attachments.push({ name, size: 0, xml: false, bytes: null });
      continue;
    }
    let data = raw;
    if (filters.length > 0) {
      try {
        data = inflateSync(raw, { maxOutputLength: MAX_ATTACHMENT_BYTES });
      } catch (err) {
        if (err && err.code === "ERR_BUFFER_TOO_LARGE") throw new JobError("TOO_LARGE");
        throw new JobError("BROKEN");
      }
    } else if (raw.length > MAX_ATTACHMENT_BYTES) {
      throw new JobError("TOO_LARGE");
    }
    const xml = looksLikeXml(data);
    if (xml) {
      returned += data.length;
      if (returned > MAX_RETURNED_BYTES) throw new JobError("TOO_LARGE");
    }
    attachments.push({ name, size: data.length, xml, bytes: xml ? new Uint8Array(data) : null });
  }
  return { attachments };
}

try {
  if (workerData?.job !== "pdf-attachments") throw new JobError("UNKNOWN_JOB");
  parentPort.postMessage({ ok: true, value: extract(workerData.input) });
} catch (err) {
  // Nie Meldung oder Eingabeinhalt weitergeben, nur einen festen Code.
  parentPort.postMessage({ ok: false, code: err instanceof JobError ? err.code : "FAILED" });
}
