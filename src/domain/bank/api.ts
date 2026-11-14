/**
 * Gemeinsame Lesesicht fuer REST und MCP: Vorschlaege je Umsatz (Zuordnung bei Gutschriften,
 * Rueckgabe-Vorschlaege bei Rueckbuchungen). Es wird nie gebucht.
 */
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { returnSuggestions, type ReturnSuggestion } from "./return";
import { suggestionsFor, type Suggestion } from "./suggest";

export async function bankSuggestionsForApi(orgId: string, txId: string): Promise<{ suggestions: Suggestion[]; returnSuggestions: ReturnSuggestion[] }> {
  const tx = await dbInternal.bankTransaction.findFirst({ where: { id: txId, orgId }, select: { id: true, direction: true, status: true } });
  if (!tx) throw new NotFoundError("Bankumsatz nicht gefunden.");
  if (tx.status === "RETURN") return { suggestions: [], returnSuggestions: await returnSuggestions(orgId, txId) };
  return { suggestions: tx.direction === "CRDT" ? await suggestionsFor(orgId, txId) : [], returnSuggestions: [] };
}
