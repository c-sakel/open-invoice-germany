# SDD ledger — plan: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-03-phase-3b-angebotsannahme.md
Branch phase-3b/offer-acceptance aus main a70b532. Spec: docs/superpowers/specs/2026-09-03-phase-3-dokumente-design.md (3b-Abschnitte).

## Pre-flight-Scan
| Paar/Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1→T2 | QuoteShareLink/DocumentSettings, Zod, token.ts, rate-limit.ts | konsistent |
| T2 Entscheidung | Automatik convertDocument oeffnet eigene Tx → nach der Entscheidungs-Tx, Fehler als automationError | Ruling im Plan |
| T2 Benachrichtigung | sendInternalNotification soll Log/ChangeLog-Logik aus send.ts wiederverwenden | Brief verlangt Hilfsfunktion, kein Duplikat |
| T3 proxy | PUBLIC_PREFIXES + /angebot/ + /api/public/ | Sicherheitsrelevant → Whole-Branch-Review prueft |
| T3 Tabellenzahl | 28 | in Brief |

Task 1: dispatched (sonnet), BASE a70b532
Task 1: implementer DONE (50679db), 271/271. Task 1: task reviewer dispatched (sonnet), diff a70b532..50679db
Task 1: reviewer APPROVED (Minor: Testzahl im Bericht; Cleanup-Zaehler nur im Erfolgspfad → Einzeiler in Task 2).
Task 1: complete
Task 2: dispatched (sonnet), BASE 50679db, mit task-2-addendum.md
Task 2: implementer DONE (92ccb24, c1e20ac, aa7e834), 290/290. Bedenken: Benachrichtigungstest gegen echten SMTP (kein Provider injizierbar). Task 2: task reviewer dispatched (sonnet), diff 50679db..aa7e834
Task 2: reviewer APPROVED mit Auflage — Mittel: decideOffer ohne Provider-Slot (Test gegen echten SMTP); Low: quote-share.ts nicht re-exportiert. Ruling: Commit 0 von Task 3.
Task 2: complete
Task 3: dispatched (sonnet), BASE aa7e834, mit task-3-addendum.md
Task 3: implementer DONE (2087053, 86fe7f0, c73a266, 5c2175d), 297/297, PG 6/6 (28 Tabellen). Bedenken: {{offer.link}} kann bestehende
  Links nicht zeigen (Token nur als Hash) — Plan-Defekt des Koordinators.
Task 3: Ruling: kein separates Task-Review — Whole-Branch-Review (opus) prueft Task 3 als ersten Block (oeffentliche Flaeche verdient das
  staerkste Modell); Ruling-Vorschlag fuer offer.link: Token zusaetzlich verschluesselt (AES-GCM, AUTH_SECRET-Schluessel wie SMTP-Passwort)
  speichern, damit Betreiber und Mailvorlage den Link wiederverwenden koennen — Reviewer adjudiziert.
Task 3: complete
Final: whole-branch review dispatched (opus), package review-a70b532..5c2175d.diff
Final: review (opus) — Kritisch 0; Wichtig W1 E-Mail Pflicht vs. optional (Hauptpfad kaputt), W2 kein E2E fuer Entscheidung/Proxy,
  W3 prefill mintet Link per GET (Nebenwirkung, leere URL in Standardvorlage), W4 oeffentliche Leserouten ohne IP-Limit + Write je GET,
  W5 keine MCP-Tools; Gering G1 x-oig-public nicht vom Client bereinigt, G2 Link gueltig trotz manuell entschieden, G3 kein no-store,
  G4 prevHash-Kollision ohne Retry, G5 Zod-Pfade an Kunden; Hinweise H1-H7. Adjudikation offer.link: tokenEnc (AES-GCM) — angenommen.
Final: Ruling: EINE Fix-Welle: W1-W5, G1-G5, H1-Doku, tokenEnc-Umbau (Migration phase3b noch nicht deployed → aenderbar). H3 (Origin-Firewall
  nur CF) mache ich selbst in BETRIEB.md (Server). Kosten: eine Re-Review-Runde.
Final: fix dispatched (sonnet, frisch), BASE 5c2175d
Final: fix commits c0200da, 3ba5eeb, 33e44ef, 3807287 (Agent parkte auf Monitor; Koordinator faehrt Pruefkette selbst). Final: scoped re-review dispatched (sonnet), diff 5c2175d..3807287
Final: re-review APPROVED (12/12); Pruefkette + PG 6/6 durch Koordinator. Hinweis: HKDF-Info fuer tokenEnc = SMTP-Info (Domain-Separation) → Backlog. Merge phase-3b/offer-acceptance -> main (ff).
