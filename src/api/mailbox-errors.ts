/**
 * Fehlerabbildung der Postfach-Sichtung fuer REST: gescheiterte Entscheidungen (409 mit Code in `reason`,
 * bei bereits angenommener Datei mit `details.incomingInvoiceId`), fehlende Zwischenablage-Datei (409) sowie die
 * Annahmefehler der Eingangsrechnungen (422/413/503). Meldungen enthalten nie Dateiinhalt oder Zugangsdaten.
 */
import { NextResponse } from "next/server";
import { InboundMailError } from "@/domain/mailbox/errors";
import { incomingErrorResponse } from "./incoming-errors";

export function mailboxErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof InboundMailError) {
    if (e.code === "ALREADY_RECEIVED") {
      return NextResponse.json(
        { error: { code: "ALREADY_RECEIVED", message: e.message, reason: e.code, ...(e.details ? { details: e.details } : {}) } },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: { code: "CONFLICT", message: e.message, reason: e.code } }, { status: 409 });
  }
  return incomingErrorResponse(e);
}

export async function withMailboxErrors(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await run();
  } catch (e) {
    const mapped = mailboxErrorResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}
