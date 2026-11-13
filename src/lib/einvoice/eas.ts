/**
 * Phase 17a — elektronische Adressen (BT-34 Verkaeufer, BT-49 Erwerber) mit EAS-Schemacode.
 * Reine Funktionen: Codeliste, Leitweg-ID-Pruefziffer, Formatpruefung, Aufloesung.
 */
import { splitVatId, vatIdFormatProblem } from "@/lib/vat-id";

/**
 * Codeliste BR-CL-25 (Electronic Address Scheme), Quelle: EN16931-UBL validation-1.3.13
 * (validation/.cache/EN16931-UBL-validation.xslt, Regel BR-CL-25).
 */
export const EAS_CODES: readonly string[] = (
  "0002 0007 0009 0037 0060 0088 0096 0097 0106 0130 0135 0142 0147 0151 0170 0177 0183 0184 0188 0190 " +
  "0191 0192 0193 0194 0195 0196 0198 0199 0200 0201 0202 0203 0204 0205 0208 0209 0210 0211 0212 0213 " +
  "0215 0216 0217 0218 0219 0220 0221 0225 0230 0235 9901 9910 9913 9914 9915 9918 9919 9920 9922 9923 " +
  "9924 9925 9926 9927 9928 9929 9930 9931 9932 9933 9934 9935 9936 9937 9938 9939 9940 9941 9942 9943 " +
  "9944 9945 9946 9947 9948 9949 9950 9951 9952 9953 9957 9959 AN AQ AS AU EM"
).split(" ");

/** Haeufige Schemata fuer die Auswahl in der Oberflaeche. */
export const EAS_COMMON: readonly { code: string; label: string }[] = [
  { code: "EM", label: "E-Mail-Adresse" },
  { code: "0204", label: "Leitweg-ID (Behoerden)" },
  { code: "9930", label: "USt-IdNr. (Deutschland)" },
  { code: "0088", label: "GLN (GS1)" },
  { code: "0060", label: "DUNS-Nummer" },
  { code: "0208", label: "Unternehmensnummer Belgien" },
  { code: "0106", label: "KvK-Nummer Niederlande" },
  { code: "0192", label: "Organisationsnummer Norwegen" },
  { code: "0184", label: "CVR-Nummer Daenemark" },
  { code: "0007", label: "Organisationsnummer Schweden" },
];

export interface Endpoint {
  scheme: string;
  id: string;
}

/** Pruefziffer wie IBAN: Buchstaben A=10..Z=35, "00" anhaengen, 98 - (n mod 97), zweistellig. */
function mod97CheckDigits(body: string): string {
  let rem = 0;
  for (const ch of body + "00") {
    const digits = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return String(98 - rem).padStart(2, "0");
}

/** Leitweg-ID: Grobadressierung (2-12 Ziffern) [- Feinadressierung (1-30 alphanum.)] - Pruefziffer. */
export function isValidLeitwegId(s: string): boolean {
  const m = /^([0-9]{2,12})(?:-([0-9A-Za-z]{1,30}))?-([0-9]{2})$/.exec(s);
  if (!m) return false;
  const body = `${m[1]}${(m[2] ?? "").toUpperCase()}`;
  return mod97CheckDigits(body) === m[3];
}

/** GS1-Pruefziffer (modulo 10, Gewichte 3/1 von rechts) fuer GLN/GTIN. */
function isValidGs1(digits: string): boolean {
  if (!/^[0-9]{8,18}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length - 1; i++) {
    const d = Number(digits[digits.length - 2 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** null = ok, sonst deutsche Meldung. Unbekannte Schemata (nicht in der Liste) sind ein Fehler. */
export function validateEndpoint(scheme: string, id: string): string | null {
  if (!EAS_CODES.includes(scheme)) return `Unbekannter Schemacode ${scheme}.`;
  if (id.trim() === "" || id !== id.trim()) return "Adresse darf nicht leer sein und keine Leerzeichen am Rand haben.";
  switch (scheme) {
    case "EM":
      return EMAIL_RE.test(id) ? null : "Ungueltige E-Mail-Adresse.";
    case "0204":
      return isValidLeitwegId(id) ? null : "Ungueltige Leitweg-ID (Format oder Pruefziffer).";
    case "9930": {
      const problem = vatIdFormatProblem(id);
      if (problem) return problem;
      return splitVatId(id).countryCode === "DE" ? null : "Schema 9930 erwartet eine deutsche USt-IdNr.";
    }
    case "0088":
      return isValidGs1(id) ? null : "Ungueltige GLN (13 Ziffern mit GS1-Pruefziffer).";
    case "0060":
      return /^[0-9]{9}$/.test(id) ? null : "DUNS-Nummer besteht aus 9 Ziffern.";
    case "0208":
      return /^[0-9]{10}$/.test(id) ? null : "Unternehmensnummer besteht aus 10 Ziffern.";
    case "0106":
      return /^[0-9]{8}$/.test(id) ? null : "KvK-Nummer besteht aus 8 Ziffern.";
    case "0192":
      return /^[0-9]{9}$/.test(id) ? null : "Organisationsnummer besteht aus 9 Ziffern.";
    case "0184":
      return /^DK[0-9]{8}$/.test(id) ? null : "CVR-Nummer besteht aus DK und 8 Ziffern.";
    case "0007":
      return /^[0-9]{10}$/.test(id) ? null : "Organisationsnummer besteht aus 10 Ziffern.";
    default:
      return null;
  }
}

function nonEmpty(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** BT-49: Peppol-ID (mit Schema) vor Leitweg-ID (0204) vor E-Mail (EM). */
export function resolveBuyerEndpoint(c: {
  peppolId?: string | null;
  peppolScheme?: string | null;
  leitwegId?: string | null;
  email?: string | null;
}): Endpoint | null {
  const peppol = nonEmpty(c.peppolId);
  const scheme = nonEmpty(c.peppolScheme);
  if (peppol && scheme) return { scheme, id: peppol };
  const leitweg = nonEmpty(c.leitwegId);
  if (leitweg) return { scheme: "0204", id: leitweg };
  const email = nonEmpty(c.email);
  if (email) return { scheme: "EM", id: email };
  return null;
}

/** BT-34: electronicAddress mit Schema (NULL = EM), sonst die Firmen-E-Mail als EM. */
export function resolveSellerEndpoint(o: {
  electronicAddress?: string | null;
  electronicAddressScheme?: string | null;
  email?: string | null;
}): Endpoint | null {
  const addr = nonEmpty(o.electronicAddress);
  if (addr) return { scheme: nonEmpty(o.electronicAddressScheme) ?? "EM", id: addr };
  const email = nonEmpty(o.email);
  return email ? { scheme: "EM", id: email } : null;
}
