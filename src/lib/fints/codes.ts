/**
 * Einordnung der Rueckmeldecodes der Bank (nur vierstellige Codes, nie Texte). Grundlage der Banksperre-Vermeidung:
 * Wer eine Ablehnung der Anmeldung falsch als vorruebergehend einstuft, sendet dieselbe PIN erneut und sperrt den Zugang.
 *
 * Belegt (Bibliothek und oeffentliche Hinweise der Banken): 0010/0020/0100/9000 (angenommen/ausgefuehrt/Dialogende),
 * 0030, 3955, 3956, 3957 (Freigabe), 3040 (weitere Daten), 3920 (Verfahren), 9931 und 9942 (Anmeldung abgelehnt),
 * 3938 (Zugang gesperrt), 3076 (starke Kundenauthentifizierung nicht noetig, nur Hinweis ohne Fehlerwirkung).
 * Nicht belegt, daher vor erfolgreicher Anmeldung als unklar behandelt (kein erneuter Versuch mit derselben PIN):
 * 9930, 9340, 9010, 9050, 9800 und jeder andere 9xxx-Code.
 */
export type CodeClass = "OK" | "OK_NO_SCA" | "SCA" | "AUTH" | "LOCKED" | "TRANSIENT" | "OTHER";
export type CodePhase = "INIT" | "ORDER";

const LOCKED_CODES = new Set(["3938"]);
const AUTH_CODES = new Set(["9931", "9942"]);
const SCA_CODES = new Set(["0030", "3955", "3956", "3957"]);
/** Code 9040 (Verfahren nicht unterstuetzt) ist ein Einrichtungsfehler, keine Anmeldeablehnung. */
const KNOWN_OTHER_CODES = new Set(["9040"]);

/** Nur vierstellige Ziffernfolgen uebernehmen. */
export function sanitizeCodes(codes: readonly string[]): string[] {
  return codes.filter((c) => /^\d{4}$/.test(c));
}

export function classifyCodes(
  codes: readonly string[],
  phase: CodePhase,
): { cls: CodeClass; unknownInInit: boolean } {
  const list = sanitizeCodes(codes);
  if (list.some((c) => LOCKED_CODES.has(c))) return { cls: "LOCKED", unknownInInit: false };
  if (list.some((c) => AUTH_CODES.has(c))) return { cls: "AUTH", unknownInInit: false };
  const failures = list.filter((c) => c >= "9000" && c !== "9000");
  if (failures.length > 0) {
    const unclear = phase === "INIT" && failures.some((c) => !KNOWN_OTHER_CODES.has(c));
    return { cls: "OTHER", unknownInInit: unclear };
  }
  if (list.some((c) => SCA_CODES.has(c))) return { cls: "SCA", unknownInInit: false };
  if (list.includes("3076")) return { cls: "OK_NO_SCA", unknownInInit: false };
  return { cls: "OK", unknownInInit: false };
}

/** Ist der Dialog laut Codes beendet (0100 oder 9000)? */
export function dialogEnded(codes: readonly string[]): boolean {
  const list = sanitizeCodes(codes);
  return list.includes("0100") || list.includes("9000");
}
