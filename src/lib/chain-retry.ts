import { Prisma } from "@/generated/prisma/client";

/** P2002 auf dem ChangeLog-Kettenindex (orgId, prevHash)? Andere Unique-Konflikte zaehlen nicht. */
export function isChangeLogChainConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = e.meta?.target;
  const text = Array.isArray(target) ? target.join(",") : typeof target === "string" ? target : "";
  return text.includes("prevHash");
}

export interface ChangeLogRetryOptions<T> {
  /** Gesamtzahl der Versuche (Standard 4). */
  attempts?: number;
  /** Vor jeder Wiederholung: liefert ein Wert, ist die Arbeit bereits erledigt (idempotent) und wird zurueckgegeben. */
  alreadyDone?: () => Promise<T | undefined>;
  /** Wartezeit je Wiederholung in ms (Standard: 5-40 ms zufaellig, wachsend). */
  delayMs?: (attempt: number) => number;
}

/**
 * Wiederholt `fn` begrenzt, wenn die Hash-Kette des ChangeLogs mit einem parallelen Schreiber
 * kollidiert (P2002 auf orgId+prevHash). Alle anderen Fehler werden sofort durchgereicht.
 */
export async function withChangeLogRetry<T>(fn: () => Promise<T>, opts: ChangeLogRetryOptions<T> = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const delay = opts.delayMs ?? ((n: number) => 5 + Math.random() * 35 * (n + 1));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isChangeLogChainConflict(e) || attempt + 1 >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delay(attempt)));
      if (opts.alreadyDone) {
        const done = await opts.alreadyDone();
        if (done !== undefined) return done;
      }
    }
  }
}
