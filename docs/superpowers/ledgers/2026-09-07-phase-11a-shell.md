# Ledger Phase 11a — App-Shell, Sidebar, globale Suche

Branch `phase-11a/shell` aus Fork-main 53c0d4a, Plan `docs/superpowers/plans/2026-09-07-phase-11a-shell.md`, Spec `docs/superpowers/specs/2026-09-07-phase-11-sevdesk-ux-design.md`.
Modelle: Implementer/Task-Reviews sonnet, Abschluss-Review opus. Ergebnis: 12 Commits, 1687 Tests gruen (TZ=UTC), Build/Lint/Typecheck/validate:erechnung gruen, Playwright-Smoke 11/11.

## Commits
- 402fcb8 feat(shell): Navigationsmodell mit Pfad-Erkennung (Phase 11a, Task 1)
- 2288dfc feat(search): globale Suche als Domain-Funktion mit Org-Scoping (Phase 11a, Task 2)
- 7176d21 feat(search): GET /api/search mit Zod-Validierung (Phase 11a, Task 3)
- 69bd1c7 feat(shell): Sidebar-Navigation mit Drawer ersetzt MainNav (Phase 11a, Task 4)
- 8c4a122 test(search): Datentests fuer Angebote/Lieferscheine und Org-Scoping (Phase 11a, Task 2 Fix 1)
- 53acc71 feat(shell): Befehlspalette mit globaler Suche (⌘K) (Phase 11a, Task 5)
- 3afb714 feat(shell): einheitlicher Seitenkopf, Doku Navigation/Suche (Phase 11a, Task 6)
- e50ef5b fix(shell): Review-Nacharbeiten Task 4 — active-Prop, Badge-Punkt, NotificationBell entfernt
- fddff5e fix(shell): eine Befehlspalette in AppShell, Trigger per Context (Task 5 Fix 1)
- 01ee2ab fix(shell): E-Mails-Menuepunkt entfernt, ARCHITEKTUR-Hinweis, Nummernkreis im Such-Test (Task 6 Nacharbeit)
- 6b86c42 fix(shell): Ungelesen-Badge als Client-Komponente mit Poll (Abschluss-Review Important)
- 49393bf fix(shell): Abschluss-Review Minors — SlimShell, Version, Icons im eingeklappten Zustand, Palette-Ladezeile, Doku

## Verlauf, Befunde, Rulings (SDD-Ledger, unveraendert uebernommen)


## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 -> T4 | NAV_GROUPS, SETTINGS_ITEMS, itemMatches, activeGroupKey, NavIconName | konsistent |
| T2 -> T3 | globalSearch(orgId, SearchQuery), searchQuerySchema; gemeinsame Testdatei search.test.ts (T3 haengt an) | konsistent |
| T3 -> T5 | GET /api/search Antwortform {groups:[{key,label,hits}]} | konsistent |
| T4 -> T5 | AppShell Props: T5 entfernt searchSlot aus Props (Omit) und setzt CommandPalette; Sidebar/Topbar behalten searchSlot | konsistent, T5 muss Props-Interface anpassen |
| T4 intern | SidebarGroup Props enthaelt `active`, wird nicht destrukturiert (Lint-sicher); Sidebar uebergibt active | ok |
| T4 intern | layout.tsx: unauthed-Zweig ohne Sidebar; getActiveOrg() im try/catch | ok |
| T6 | PageHeader auf 9 Seiten; keine Schnittstelle zu T1-T5 | ok |
Scan: keine Konflikte. Modelle: Implementer/Task-Review/Re-Review sonnet, Abschluss opus (CLAUDE.md Token-Sparregeln).

Task 1: minor (deferred): `exact`-Flag ohne Test (SETTINGS_ITEMS ohne Konsument bis T4)
Task 1: minor (deferred): kind=ANGEBOT-Default hart in itemMatches (plan-mandated)
Task 1: minor (deferred): NavGroup.items nicht readonly (plan-mandated)
Task 1: complete (commits 53c0d4a..402fcb8, review clean)
Task 3: Ruling: kein eigenes Task-Review — Diff 41 Zeilen (2 Dateien), vom Koordinator gegen Brief geprueft (Route + Test identisch zum Brief) — CLAUDE.md Token-Sparregel "kleine Diffs < ~50 Zeilen prueft der Koordinator selbst"; Kosten bei Irrtum: Abschluss-Review (opus) sieht den Diff erneut.
Task 3: complete (commits 2288dfc..7176d21, koordinator-geprueft)
Task 2: review — Important (plan-mandated): Gruppen documents/deliveryNotes ohne Datentest; Ruling: Befund gilt (Lastenheft 54), Fix-Runde 1 nach Abschluss von Task 4 (kein paralleler Implementer). Minor (deferred): Org-Scoping nur fuer customers negativ getestet; SearchGroup als benannter Typ (ok).
Task 2: fix round 1/5 (2 addressed, 0 open — Datentests documents/deliveryNotes + Org-Scoping negativ; commit 8c4a122). Ruling: Re-Review durch Koordinator (66 Zeilen, nur Testdatei, Assertions gegen Befund geprueft) — CLAUDE.md-Regel kleine Fix-Diffs; Kosten bei Irrtum: Abschluss-Review sieht ihn.
Task 2: complete (commits 402fcb8..2288dfc + 8c4a122, review clean nach Fix 1)
Task 4: minor (deferred): SidebarGroup.Props.active ungenutzt (plan-mandated) -> in Task 6 entfernen
Task 4: minor (deferred): Ungelesen-Badge im eingeklappten Zustand unsichtbar -> in Task 6 Punkt-Indikator
Task 4: Ruling: NotificationBell.tsx (verwaist) wird in Task 6 entfernt — Sidebar-Badge ersetzt die Glocke, 11d braucht sie nicht; Kosten bei Irrtum: Datei aus Git wiederherstellen.
Task 4: complete (commits 7176d21..69bd1c7, review clean)
Task 5: implementiert 53acc71 (DONE_WITH_CONCERNS: Doppelinstanz der Palette durch Sidebar+Topbar, Guard via offsetParent; Rest-Fall Drawer+Ctrl/Cmd+K dokumentiert). Review laeuft; Frage an Reviewer: Guard vs. Zustand in AppShell heben.
Task 6: dispatcht (inkl. Nacharbeiten aus T4-Review: active-Prop, Badge-Punkt, NotificationBell entfernen). Keine Aenderungen an CommandPalette/AppShell.
Task 5: review — Important 1: Doppelinstanz durch searchSlot-Muster (plan-mandated Wurzel); Important 2: Hydration-Mismatch navigator.platform (plan-mandated). Ruling: Redesign statt Guard — EINE CommandPalette in AppShell, Zustand in einem Client-`ShellProvider` (React-Context `openSearch`), Sidebar/Topbar rendern nur `SearchTrigger`-Button aus dem Context; `searchSlot`-Prop entfaellt in Sidebar/Topbar (Task-4-Vertrag wird geaendert, weil der Vertrag die Ursache ist). isMac per useEffect. Kosten bei Irrtum: ~100 Zeilen Umbau im Shell-Ordner. Fix-Runde 1 startet NACH Task 6 (beide beruehren Sidebar.tsx).
Task 5: minor (deferred): kein Abort bei Unmount; Escape nur im Input; keine Combobox-ARIA; res.json ohne Zod (intern).
Task 6: implementiert 3afb714 + e50ef5b (DONE_WITH_CONCERNS). Befunde: /emails-Liste existiert nicht (Nav-Item tot); MainNav-Satz in ARCHITEKTUR §8b veraltet; Test-Flake: search.test.ts und mcp-payments-recurring.test.ts teilen Testjahr 2071 -> Invoice.number-Kollision.
Task 6: Ruling: E-Mails-Menuepunkt wird entfernt (kein Listen-Route; E-Mail-Log je Beleg + Einstellungen erreichbar) — Kosten bei Irrtum: Item spaeter wieder aufnehmen, wenn 11d eine Liste bringt. Flake-Fix per eigenem Nummernkreis-Praefix (Muster customer-routes.test.ts).
Task 5: fix round 1/5 dispatcht (Redesign ShellProvider/SearchTrigger + isMac-Effekt + Minors) zusammen mit Task-6-Nacharbeiten (3 Punkte) an den Task-5-Implementer; Task-6-Review folgt als Block im Abschluss-Review (CLAUDE.md: letzter Task ohne eigenes Review).
Task 5: fix round 1/5 (2 Important + 2 Minor addressed, 0 open; commits fddff5e, 01ee2ab). Ruling: kein separates Re-Review — Abschluss-Review (opus) prueft die Fix-Runde und Task 6 als erste Bloecke (CLAUDE.md Token-Sparregeln); Kosten bei Irrtum: eine Fix-Welle nach dem Abschluss-Review.
Task 5: complete (commits 8c4a122..53acc71 + fddff5e, abschluss-review-pflichtig)
Task 6: complete (commits 53acc71..e50ef5b + 01ee2ab, Review im Abschluss-Review)
Abschluss-Review (opus, 53c0d4a..01ee2ab): Needs fixes — Important: Ungelesen-Badge im Root-Layout veraltet (Layout rendert bei Client-Navigation nicht neu; Bell hatte gepollt). Minors M1..M16 (siehe Review-Output).
Ruling Fix-Welle: Badge wird Client-Komponente mit Poll auf GET /api/notifications/unread-count (loest Important + M2); mitgenommen: M1, M6 Version, M7 Header/Footer fuer Login/Setup/Landing, M8 Such-/Logout-Icon im eingeklappten Zustand, M9 Chevron, M11 Lade-Zeile, M13 README/LIMITATIONEN-Wortlaut, M15 userAgentData, T1 exact-Test. Spaeter (11b/11d): M3 SettingsTabs aus SETTINGS_ITEMS ableiten, M4/M5 Gruppen-Aufklappen, M10 Dialog-ARIA/Focus-Trap, M12 Dokument-Detail-Highlight, M14, M16. Kosten bei Irrtum: kosmetisch.

## Abschluss-Review (opus) und Fix-Welle
- Important: Ungelesen-Badge im Root-Layout veraltete (Layout rendert bei Client-Navigation nicht neu) -> UnreadBadge (Client, Poll 60 s + focus + Event oig:notifications-changed), Commit 6b86c42.
- Minors umgesetzt (49393bf): M1 ARCHITEKTUR, M2 Route-Kommentar, M6 Version in Sidebar, M7 SlimShell fuer Login/Setup/Landing (Fussnote: oeffentliche Angebotsseite traegt jetzt den Hinweis 'Keine Steuer-/Rechtsberatung'), M8 Icon-Trigger eingeklappt, M9 Chevrons, M11 Ladezeile/Abort-Race, M13 README/LIMITATIONEN, M15 userAgentData, T1 exact-Test.
- Re-Review (sonnet): alle Befunde ADDRESSED, keine neue Breakage.

## Offen / spaeter (mit Zielphase)
- 11b: SettingsTabs aus SETTINGS_ITEMS ableiten (M3); /einstellungen/dokumente fehlt in beiden Listen (vorbestehend).
- 11d: Gruppen-Aufklappen fuer alle Gruppen + activeGroupKey nutzen oder entfernen (M4/M5); Dialog-ARIA/Focus-Trap/Scroll-Lock fuer Palette und Drawer (M10); /dokumente/<id> markiert bei AB/Proforma 'Angebote' (M12); PageHeader backHref fuer Detailseiten (M14); ggf. E-Mail-Liste und Menuepunkt.
- Beobachtung: bei offenem Drawer laufen zwei UnreadBadge-Polls (zwei Sidebar-Instanzen) — kosmetisch.
- Suche skaliert ueber fuenf contains-Abfragen ohne Index (M16) — fuer Self-Hosting unkritisch.
