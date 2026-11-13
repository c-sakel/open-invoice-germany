/**
 * Phase 16d — Versandkanal einer Mahnung (rein, ohne Datenbank).
 *
 * Die Stufe kann den Kanal vorgeben (`EMAIL`, `POST`, `EMAIL_AND_POST`) oder dem Kunden folgen (`CUSTOMER`).
 * Fehlt bei reinem E-Mail-Versand die Empfaengeradresse, geht die Mahnung nur mit `postFallback` per Post;
 * sonst meldet das Ergebnis `NO_RECIPIENT` (die Automatik meldet das, statt still zu ueberspringen).
 */
export type Channel = "EMAIL" | "POST" | "EMAIL_AND_POST";
export type StageChannel = "CUSTOMER" | Channel;

export interface ChannelInput {
  stageChannel: StageChannel;
  customerChannel: Channel;
  hasEmail: boolean;
  postFallback: boolean;
}

export interface ChannelResolution {
  email: boolean;
  post: boolean;
  reason: "OK" | "FALLBACK_POST" | "NO_RECIPIENT";
}

/** Unbekannte Werte aus der Datenbank gelten als E-Mail (Bestandsverhalten). */
export function asChannel(v: string | null | undefined): Channel {
  return v === "POST" || v === "EMAIL_AND_POST" ? v : "EMAIL";
}

export function asStageChannel(v: string | null | undefined): StageChannel {
  return v === "EMAIL" || v === "POST" || v === "EMAIL_AND_POST" ? v : "CUSTOMER";
}

export function resolveChannels(i: ChannelInput): ChannelResolution {
  const channel: Channel = i.stageChannel === "CUSTOMER" ? i.customerChannel : i.stageChannel;
  if (channel === "POST") return { email: false, post: true, reason: "OK" };
  if (channel === "EMAIL_AND_POST") return { email: i.hasEmail, post: true, reason: "OK" };
  if (i.hasEmail) return { email: true, post: false, reason: "OK" };
  if (i.postFallback) return { email: false, post: true, reason: "FALLBACK_POST" };
  return { email: false, post: false, reason: "NO_RECIPIENT" };
}
