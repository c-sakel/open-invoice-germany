/**
 * Fehlerabbildung der Eingangsrechnungen fuer REST: nicht lesbare oder unsichere Datei (422 mit
 * fachlichem Code in `reason`), zu grosse Datei (413), bereits angenommene Datei (409
 * ALREADY_RECEIVED mit `incomingInvoiceId`) und ausgelastete Annahme (503). Meldungen enthalten nie
 * Dateiinhalt. Ablauffehler (Status, Zuordnung, Kopfdaten von Hand) tragen den fachlichen Code in `reason`
 * und Felder in `details`; zu grosse Uebergabe 413. Alle anderen Fehler laufen durch das allgemeine Mapping von withApi.
 */
import { NextResponse } from "next/server";
import { IncomingBusyError, IncomingDuplicateError, IncomingFormatError, IncomingWorkflowError } from "@/domain/incoming/errors";
import { IncomingHandoverTooLargeError } from "@/domain/incoming/handover";

export function incomingErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof IncomingFormatError) {
    if (e.code === "TOO_LARGE") return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: e.message, reason: e.code } }, { status: 413 });
    return NextResponse.json({ error: { code: "UNPROCESSABLE", message: e.message, reason: e.code } }, { status: 422 });
  }
  if (e instanceof IncomingDuplicateError) {
    return NextResponse.json(
      { error: { code: "ALREADY_RECEIVED", message: e.message, details: { incomingInvoiceId: e.existingId } } },
      { status: 409 },
    );
  }
  if (e instanceof IncomingBusyError) {
    return NextResponse.json({ error: { code: "INTERNAL", message: e.message, reason: "BUSY" } }, { status: 503, headers: { "Retry-After": "10" } });
  }
  if (e instanceof IncomingWorkflowError) {
    const code = e.status === 409 ? "CONFLICT" : e.status === 400 ? "VALIDATION" : "UNPROCESSABLE";
    return NextResponse.json(
      { error: { code, message: e.message, reason: e.code, ...(e.details !== undefined ? { details: e.details } : {}) } },
      { status: e.status },
    );
  }
  if (e instanceof IncomingHandoverTooLargeError) {
    return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: e.message } }, { status: 413 });
  }
  return null;
}

export async function withIncomingErrors(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await run();
  } catch (e) {
    const mapped = incomingErrorResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}
