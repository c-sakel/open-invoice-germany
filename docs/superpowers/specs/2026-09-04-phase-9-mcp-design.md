# Phase 9 — MCP-Erweiterungen: vollständige Abdeckung, Parität, Tests, Doku-Drift-Check

**Lastenheft:** §55 (MCP-Server erweitern: alle wichtigen Funktionen, gleiche Validierung/Berechtigungen wie UI/API), §58 Phase 9. **Ist-Stand:** `phase-9-ist-stand.md` — 49 Tools; die §55-Beispielkommandos sind abgedeckt; Lücken: kein Archivieren/Update-by-id für Kunden/Produkte, kein allgemeiner E-Mail-Versand, kein Inline-PDF/XML (nur Dateiexport), keine Recurring-Änderung/Status, `upsert_product` mit eigener Zod statt `productSchema` (ohne Differenzbesteuerung), `list_invoices` nur Status-Filter, ~30 Tools ohne MCP-Test, docs/MCP.md fehlen 3 Tools. (Phasen 8a/8b liefern ihre Tools selbst.)

## Entscheidungen
| Thema | Entscheidung |
|---|---|
| Neue Tools | `update_customer {id, ...customerSchema}`, `archive_customer {id}`, `update_product {id, ...productSchema}`, `archive_product {id}`; `send_email {docType, docId, templateId?, to?, cc?, subject?, body?, attachments?}` → `sendDocumentEmail` (gleiche Zod); `get_document_file {kind, id, format: pdf|xrechnung|zugferd}` → Base64 + MIME + Dateiname (nutzt bestehende Render-/Mapper-Funktionen + Theme); `update_recurring {id, ...}`, `set_recurring_state {id, state: ACTIVE|PAUSED|ENDED}` (Domain hinter `/api/recurring/[id]`); `get_quote {id|number}`, `get_delivery_note {id|number}` (Lesen, analog get_invoice); `list_invoices` Filter aus Phase 8b (`invoiceListFilterSchema`) — nach 8b. |
| Parität | `upsert_product` und `upsert_customer` nutzen `productSchema`/`customerSchema` aus `src/schemas` (inkl. `differential`); alle Tools: Zod-Schema aus `src/schemas` oder Domain-Eingabe, nie eigene Kopien. Prüfung per Test: jedes Tool-InputSchema ist per `z.object` aus geteilten Schemas komponiert (Codegestaltung), Reviewer prüft. |
| Fehler | einheitlich `fail()` mit Domain-Fehlertext; unbekannte Fehler → generisch „Unerwarteter Fehler" + Server-Log (keine Interna). |
| Tests | Ein Testfile je Bereich (`mcp-core.test.ts`: status/setup/customers/products/invoices/finalize/cancel/credit/get/list/export; `mcp-documents.test.ts`: create/list/convert/status/duplicate/delivery note/share links; `mcp-payments-recurring.test.ts`; `mcp-email-files.test.ts`) — jedes Tool mindestens Erfolg + ein Fehlerpfad; Testjahre 2069–2072. |
| Doku-Drift | Test `test/unit/mcp-docs.test.ts`: jede registrierte Tool-ID (aus `server.ts` per Regex `registerTool\("...")`) steht in docs/MCP.md und umgekehrt; docs/MCP.md nach Bereichen gruppiert, je Tool ein Beispielkommando. |
| Nicht in 9 | HTTP-Transport/Remote-MCP (Phase 10 API), Multi-Org. |

## Struktur / Tabellen
Keine Schemaänderung. Tabellenzahl unverändert.
