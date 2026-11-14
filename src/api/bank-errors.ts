/**
 * Fehlerabbildung des Bankabgleichs fuer REST: Format-Fehler der Datei (422 mit fachlichem Code in `reason`)
 * und bereits importierte Datei (409 ALREADY_IMPORTED mit `importId`). Alle anderen Fehler laufen unveraendert
 * durch das allgemeine Mapping von withApi (Zuordnungsfehler 422, Konflikte 409, unbekannt 404).
 */
import { NextResponse } from "next/server";
import { CamtFormatError } from "@/domain/bank/errors";
import { BankImportDuplicateError } from "@/domain/bank/import";

export async function withBankImportErrors(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof CamtFormatError) {
      return NextResponse.json({ error: { code: "UNPROCESSABLE", message: e.message, reason: e.code } }, { status: 422 });
    }
    if (e instanceof BankImportDuplicateError) {
      return NextResponse.json(
        { error: { code: "ALREADY_IMPORTED", message: e.message, details: { importId: e.importId, importedAt: e.importedAt.toISOString() } } },
        { status: 409 },
      );
    }
    throw e;
  }
}
