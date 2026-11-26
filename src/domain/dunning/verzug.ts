import { berlinCalendarDay } from "@/lib/berlin-time";
import { nextBusinessDay } from "@/lib/german-holidays";

/**
 * Verzugsbeginn (§ 286 BGB) als reine Funktion. Alle Daten sind Berliner Kalendertage (UTC-Mitternacht).
 * Zugangsannahmen (konservativ): E-Mail = Versandtag + 1, Post = Versandtag + 3. Eine Mahnung ohne Versandnachweis begründet keinen Verzug.
 * `from` ist der erste Zinstag und liegt immer einen Tag NACH dem Verzugseintritt (§ 187 Abs. 1 BGB analog):
 * Mahnungsweg = Tag nach Zugang, 30-Tage-Weg = Tag nach Fristende (Zugang 15.03. -> Fristende 14.04. -> Zinsen ab 15.04.).
 * Fällt das Fristende der 30-Tage-Regel auf Samstag, Sonntag oder einen bundeseinheitlichen Feiertag, endet die Frist erst am
 * nächsten Werktag (§ 193 BGB); die Zinsen beginnen am Tag danach. Landesfeiertage bleiben unberücksichtigt.
 */
export type Dispatch = { channel: "EMAIL" | "POST" | "NONE"; at: Date };

export interface VerzugInput {
  isConsumer: boolean;
  /** Invoice.consumerDefaultNotice, beim Festschreiben eingefroren. */
  consumerNotice: boolean | null;
  /** Rechnungsfälligkeit (dueDate ?? issueDate). */
  dueDate: Date;
  /** BT-72, Empfang der Gegenleistung. */
  serviceDate: Date | null;
  issueDate: Date;
  /** Erfolgreiche Zustellversuche der Rechnung. */
  invoiceDispatches: Dispatch[];
  priorDunnings: { createdAt: Date; dispatches: Dispatch[] }[];
  now: Date;
}

export type VerzugBasis = "MAHNUNG" | "ENTGELT_30" | "ENTGELT_30_LEISTUNG" | "NONE";

const DAY_MS = 86_400_000;

function addDays(day: Date, n: number): Date {
  return new Date(day.getTime() + n * DAY_MS);
}

function earliest(days: Date[]): Date | null {
  let min: Date | null = null;
  for (const x of days) if (min === null || x.getTime() < min.getTime()) min = x;
  return min;
}

/** Berliner Kalendertag des Versands + 1 (E-Mail) bzw. + 3 (Post). */
export function zugangDay(dispatch: Dispatch): Date {
  return addDays(berlinCalendarDay(dispatch.at), dispatch.channel === "EMAIL" ? 1 : 3);
}

/** Fristende der 30-Tage-Regel (Anker + 30 Tage), nach § 193 BGB auf den nächsten Werktag verschoben; Rückgabe: erster Zinstag. */
function entgeltFrist30(anchor: Date): Date {
  return addDays(nextBusinessDay(addDays(anchor, 30)), 1);
}

/**
 * `from` = erster Zinstag, nur gesetzt, wenn er vor heute liegt. `verzugAt` = Verzugseintritt (Tag vor dem ersten Zinstag), gesetzt,
 * sobald er heute oder früher liegt; auch dann, wenn noch keine Zinstage vorliegen. `basis` ist genau dann nicht `NONE`, wenn der
 * Verzug eingetreten ist (`verzugAt` gesetzt); am ersten Zinstag selbst also `from` null mit Grund. `NONE` heißt: Verzug noch nicht eingetreten.
 */
export function verzugStart(i: VerzugInput): { from: Date | null; basis: VerzugBasis; verzugAt: Date | null } {
  // § 193 BGB auch für die Fälligkeit: fällt sie auf Sa/So/Feiertag, ist erst am nächsten Werktag zu leisten.
  const dueDay = nextBusinessDay(berlinCalendarDay(i.dueDate));
  const today = berlinCalendarDay(i.now);

  // (a) Mahnungsweg: Zugang der ersten Mahnung, die nach dem Fälligkeitstag erstellt wurde.
  const dunningZugang: Date[] = [];
  for (const dun of i.priorDunnings) {
    if (berlinCalendarDay(dun.createdAt).getTime() <= dueDay.getTime()) continue;
    // Nur nachweislich versendete Mahnungen begruenden Verzug; ohne Versandnachweis
    // (nie versendet, Mail BOUNCED/FAILED, Post nicht eingereicht) zaehlt die Mahnung nicht.
    const z = earliest(dun.dispatches.map(zugangDay));
    if (z) dunningZugang.push(z);
  }
  const aZugang = earliest(dunningZugang);
  const a = aZugang ? addDays(aZugang, 1) : null;

  // (b) 30-Tage-Weg: Fristende = Ausgangstag + 30 (§ 193 BGB), erster Zinstag = Tag danach.
  let b: Date | null = null;
  let bBasis: VerzugBasis = "NONE";
  const z = earliest(i.invoiceDispatches.map(zugangDay));
  if (!i.isConsumer) {
    if (z) {
      b = entgeltFrist30(new Date(Math.max(dueDay.getTime(), z.getTime())));
      bBasis = "ENTGELT_30";
    } else {
      const leistung = berlinCalendarDay(i.serviceDate ?? i.issueDate);
      b = entgeltFrist30(new Date(Math.max(dueDay.getTime(), leistung.getTime())));
      bBasis = "ENTGELT_30_LEISTUNG";
    }
  } else if (i.consumerNotice === true && z) {
    b = entgeltFrist30(new Date(Math.max(dueDay.getTime(), z.getTime())));
    bBasis = "ENTGELT_30";
  }

  let from: Date | null = null;
  let basis: VerzugBasis = "NONE";
  if (a && (!b || a.getTime() <= b.getTime())) {
    from = a;
    basis = "MAHNUNG";
  } else if (b) {
    from = b;
    basis = bBasis;
  }
  if (!from) return { from: null, basis: "NONE", verzugAt: null };
  const verzugAt = addDays(from, -1);
  if (verzugAt.getTime() > today.getTime()) return { from: null, basis: "NONE", verzugAt: null };
  // Verzug ist eingetreten, aber der erste Zinstag ist heute oder spaeter: Grund bleibt erhalten, noch keine Zinstage.
  if (from.getTime() >= today.getTime()) return { from: null, basis, verzugAt };
  return { from, basis, verzugAt };
}

/**
 * Anzeigetext zu Zinsbeginn/Grund einer gespeicherten Mahnung (UI, MCP). Leer, wenn die Stufe nicht verzinst (Basis null)
 * oder bei Altbestand ohne Angaben. Zinsdatum nur, wenn tatsächlich Zinsen > 0 berechnet wurden.
 */
export function dunningInterestNote(
  d: { interestAmountCents: number; interestFrom: Date | null; interestBasis: string | null },
  fmtDate: (x: Date) => string,
): string {
  if (d.interestAmountCents > 0 && d.interestFrom) return ` (ab ${fmtDate(d.interestFrom)}, ${verzugBasisLabel(d.interestBasis)})`;
  if (d.interestBasis === "NONE") return " · keine Zinsen: Verzug noch nicht eingetreten";
  if (d.interestBasis && !d.interestFrom) return ` · Verzug eingetreten (${verzugBasisLabel(d.interestBasis)}), noch keine Zinstage`;
  return "";
}

/** Lesbarer Grund des Verzugsbeginns (UI, MCP). */
export function verzugBasisLabel(basis: string | null): string {
  switch (basis) {
    case "MAHNUNG":
      return "Verzug durch Mahnung";
    case "ENTGELT_30":
      return "30 Tage nach Fälligkeit und Zugang";
    case "ENTGELT_30_LEISTUNG":
      return "30 Tage nach Fälligkeit und Leistung";
    default:
      return "Verzug noch nicht eingetreten";
  }
}
