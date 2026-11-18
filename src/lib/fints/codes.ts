/**
 * Einordnung der Rueckmeldecodes der Bank (nur vierstellige Codes, nie Texte). Grundlage der Banksperre-Vermeidung:
 * Wer eine Ablehnung der Anmeldung falsch als vorruebergehend einstuft, sendet dieselbe PIN erneut und sperrt den Zugang.
 *
 * Belegt (Bibliothek und oeffentliche Hinweise der Banken): 0010/0020/0100/9000 (angenommen/ausgefuehrt/Dialogende),
 * 0030, 3955, 3956, 3957 (Freigabe), 3040 (weitere Daten), 3920 (Verfahren), 9931 und 9942 (Anmeldung abgelehnt),
 * 3938 (Zugang gesperrt), 3076 (starke Kundenauthentifizierung nicht noetig, nur Hinweis ohne Fehlerwirkung).
 * Gegengeprueft gegen oeffentliche Quellen (Bibliothek fints-rs docs.rs ResponseCodeKind, Hilfeseiten von Banking-Software
 * und Buchhaltungssoftware, Fehlermeldungen in Foren; keine amtliche Gesamtliste verfuegbar):
 *   9010  "Allgemeiner Fehler" (fints-rs GeneralError), tritt mit Unterkennungen auf (Token-Hilfeseite, Lexware)
 *   9050  "Teilweise fehlerhaft" (fints-rs PartialErrors; Giga: Nachricht enthaelt einen Fehler)
 *   9800  "Dialog abgebrochen" (fints-rs DialogAborted; Lexware/Giga), Ursache oft ein Zusatzcode (9340, 9210)
 *   9340  uneinheitlich: "PIN falsch" (fints-rs PinWrong) gegen "ungueltige/unbekannte Signatur" (Lexware, Outbank-Hilfe)
 *   9930  keine Quelle gefunden
 * Weil die Bedeutung von 9340 bankabhaengig ist, 9930 unbelegt ist und die anderen nur Sammelcodes sind, bleibt es dabei:
 * 9930, 9340, 9010, 9050, 9800 und jeder andere 9xxx-Code vor erfolgreicher Anmeldung sind unklar (kein erneuter Versuch).
 */
export type CodeClass = "OK" | "OK_NO_SCA" | "SCA" | "AUTH" | "TAN_REJECTED" | "LOCKED" | "TRANSIENT" | "OTHER";
export type CodePhase = "INIT" | "ORDER";

const LOCKED_CODES = new Set(["3938"]);
const AUTH_CODES = new Set(["9931", "9942"]);
/** Code 9941 (TAN falsch): im Auftrag eine Ablehnung der Freigabe; in der Anmeldephase bleibt er ein unklarer Fehler. */
const TAN_REJECTED_CODES = new Set(["9941"]);
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
  if (phase === "ORDER" && list.some((c) => TAN_REJECTED_CODES.has(c))) return { cls: "TAN_REJECTED", unknownInInit: false };
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
