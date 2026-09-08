# Ledger Phase 12d — API-Protokoll

Branch `phase-12d/api-protokoll` aus Fork-main c9029ce, Plan `docs/superpowers/plans/2026-09-08-phase-12d-api-protokoll.md`, Spec Paket E. Modelle: sonnet/opus. Ergebnis: 1988 Tests gruen, Postgres 20 Faelle (45 Tabellen), Gate komplett gruen, Smoke 18/18 + Fix-Smoke 13/13.

## Commits
- 10c617a feat(api-log): ApiRequestLog und ApiSettings mit Zod und Einstellungs-Domain (Phase 12d, Task 1)
- b3f1f7b feat(api-log): Redaktion, Kuerzung, Schreib-/Lese-/Aufraeumfunktionen (Phase 12d, Task 2)
- f50940b feat(api-log): Request-Id auf jeder Antwort und nicht blockierender Log-Hook in withApi (Phase 12d, Task 3)
- fbc8f83 fix(api-log): 500-Testfall, Dauer vor Body-Extraktion, Clone nur bei JSON und logBodies (12d Task 3 Fix 1)
- 0081d5a feat(api-log): Retention im Cleanup-Job, Session-Routen und Oberflaeche in Einstellungen -> API (Phase 12d, Task 4)
- 9e2ccf0 fix(api-log): Liste ohne Bodies, defensiver Status-Check, errorCode ohne Body-Logging, Einzelabfrage der Einstellungen
- 889409c feat(api-log): lesende REST-Ressource, MCP-Tool list_api_requests und Doku (Phase 12d, Task 5)
- 9a69464 fix(api-log): Abschluss-Review Fix-Welle — C1/I1/I2/I3
- eac3d21 fix(api-log): Abschluss-Review Fix-Welle — Panel-Split + Minor-Befunde (m1-m13)
- 352f494 fix(api-log): Datenschutzhinweis unterscheidet Query- und Body-Schwaerzung (12d Fix 2)

## Verlauf, Befunde, Rulings (SDD-Ledger)


## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 (ApiRequestLog/ApiSettings prisma beide Schemata, Migration, PG-Fall 20, Tabellenzusicherung 43->45 an 4 Stellen + Faelle 18/19) -> T2 (domain api-log redact/write/list/purge) | T2 braucht Prisma-Client von T1 | sequentiell |
| T3 (src/api/auth.ts Hook + Request-Id) vs T4 (scheduler cleanup, settings/api-log Routen, UI-Panel) | disjunkt, beide konsumieren T2 | parallel nach T2 |
| T5 (REST ApiRequestLog, MCP list_api_requests, Doku, Smoke) | letzter, kein eigenes Review | nach T3+T4 |
| Planer-Rulings: PUT auf /api/settings/api-log ergaenzt; orgId ohne Relation (Muster ApiIdempotency); Bodies nur >=400 (Spec-Ruling) | — | ok |
Reihenfolge: T1 -> T2 -> (T3 ∥ T4) -> T5. Modelle: sonnet/opus.
T1 dispatcht. BASE c9029ce.
CI main c9029ce (12c): alle 4 Jobs gruen.
Task 1: implementiert 10c617a (1948 Tests, PG 20/20, 45 Tabellen). Review dispatcht. Task 2 dispatcht (BASE 10c617a).
Task 1: complete (Approved, 10c617a).
Task 2: implementiert b3f1f7b (1954 Tests). Review dispatcht. T3 + T4 parallel dispatcht (BASE b3f1f7b).
Task 2: complete (Approved, b3f1f7b). Fuer Task 5: list.ts select ohne Bodies; write.ts responseBody nur wenn status>=400 (defensiv); console.error bei Schreibfehler; Retention-deleteMany batchen.
Task 3: implementiert f50940b. Review dispatcht.
Task 3: review — Important: 500-Testfall fehlt; Minor: Clone nur bei logBodies, Content-Type-Check vor Clone, durationMs vor Body-Extraktion. Fix-Runde 1/5 an Task-3-Implementer (auth.ts + Hook-Test, disjunkt zu Task 4).
Task 3: fix round 1/5 (fbc8f83, Koordinator-geprueft). Task 3: complete. Fuer Task 5: errorCode aus JSON-Fehlerantwort unabhaengig von logBodies extrahieren (nur der Body selbst ist gated); doppelten loadApiSettings-Aufruf (auth.ts + write.ts) auf einen reduzieren (Settings an logApiRequest uebergeben).
Task 4: implementiert 0081d5a (1965 Tests; Panel ~320 Zeilen). Review dispatcht. Task 5 dispatcht (letzter Task, kein eigenes Review; inkl. Nachtraege aus T2/T3).
Task 4: complete (Approved, 0081d5a). Fuer Fix-Welle: ApiRequestLogPanel (345 Z.) in Table + Drawer splitten; per-Org try/catch im Purge; inputCls statt Duplikat; Drawer-Fokus.
Task 5: complete (9e2ccf0 Nachtraege, 889409c; Gate gruen 1973 Tests, PG 20/20, Smoke 18/18). Abschluss-Review (opus) dispatcht.
Abschluss-Review (opus): Needs fix wave — C1 truncate O(n²) blockiert Event-Loop; I1 Query-String unredigiert gespeichert; I2 Redaktionsfehler -> Roh-Body; I3 z.coerce.boolean errorsOnly=false -> true; 13 Minor. Fix-Welle dispatcht.
Fix-Welle: 9a69464 (C1,I1–I3), eac3d21 (Panel-Split, Minors, Doku); 1988 Tests, Smoke 13/13. Scoped Re-Review dispatcht.
Fix-Welle Re-Review: alle Befunde adressiert; NEU Important: PRIVACY_NOTE nannte email als Body-Schwaerzung — Koordinator-Fix 2 (Text getrennt). Merge nach main.

## Offen / Backlog
- E-Mail-Adressen in Bodies werden nicht geschwaerzt (nur Query-Parameter); bei Bedarf SECRET_KEY_PATTERN erweitern.
- IP/User-Agent werden auch im Kopfdaten-Modus gespeichert (dokumentiert).
