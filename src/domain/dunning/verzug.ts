import { berlinCalendarDay } from "@/lib/berlin-time";

/**
 * Verzugsbeginn (§ 286 BGB) als reine Funktion. Alle Daten sind Berliner Kalendertage (UTC-Mitternacht).
 * Zugangsannahmen (konservativ): E-Mail = Versandtag + 1, Post und fehlender Nachweis = Versandtag + 3.
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

/** Berliner Kalendertag des Versands + 1 (E-Mail) bzw. + 3 (Post, ohne Nachweis). */
export function zugangDay(dispatch: Dispatch): Date {
  return addDays(berlinCalendarDay(dispatch.at), dispatch.channel === "EMAIL" ? 1 : 3);
}

/**
 * Fristablauf an Sonn-/Feiertagen: § 193 BGB wird bewusst NICHT angewandt (keine Verschiebung des Verzugsbeginns).
 */
export function verzugStart(i: VerzugInput): { from: Date | null; basis: VerzugBasis } {
  const dueDay = berlinCalendarDay(i.dueDate);
  const today = berlinCalendarDay(i.now);

  // (a) Mahnungsweg: Zugang der ersten Mahnung, die nach dem Fälligkeitstag erstellt wurde.
  const dunningZugang: Date[] = [];
  for (const dun of i.priorDunnings) {
    if (berlinCalendarDay(dun.createdAt).getTime() <= dueDay.getTime()) continue;
    const z =
      earliest(dun.dispatches.map(zugangDay)) ?? zugangDay({ channel: "NONE", at: dun.createdAt });
    dunningZugang.push(z);
  }
  const a = earliest(dunningZugang);

  // (b) 30-Tage-Weg.
  let b: Date | null = null;
  let bBasis: VerzugBasis = "NONE";
  const z = earliest(i.invoiceDispatches.map(zugangDay));
  if (!i.isConsumer) {
    if (z) {
      b = addDays(new Date(Math.max(dueDay.getTime(), z.getTime())), 30);
      bBasis = "ENTGELT_30";
    } else {
      const leistung = berlinCalendarDay(i.serviceDate ?? i.issueDate);
      b = addDays(new Date(Math.max(dueDay.getTime(), leistung.getTime())), 30);
      bBasis = "ENTGELT_30_LEISTUNG";
    }
  } else if (i.consumerNotice === true && z) {
    b = addDays(new Date(Math.max(dueDay.getTime(), z.getTime())), 30);
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
  if (!from || from.getTime() >= today.getTime()) return { from: null, basis: "NONE" };
  return { from, basis };
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
