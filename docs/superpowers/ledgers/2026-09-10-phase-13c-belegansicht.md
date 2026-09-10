# Ledger Phase 13c — Belegansicht (2026-09-11)

Branch phase-13c/belegansicht aus main be31941 (+ Merge main f8beffe Hotfix), gemerged in Fork-main a19e12e. 2187 Tests, Smoke 33/33.
Plan: docs/superpowers/plans/2026-09-10-phase-13c-belegansicht.md.

## Ergebnis
- PDF-Vorschau ohne #toolbar=0 (Browser-Werkzeugleiste: Seiten, Zoom), Rueckfall-Link; Breit/Schmal-Umschalter ENTFERNT (haette nichts verbreitert — keine Attrappe).
- Rechte Spalte als Karten: Beleg (Nachbarn), Kunde & Betrag (Status-Chip, Brutto gross), Details (Faelligkeit relativ, versendet am + Kanal aus EmailLog, festgeschrieben am), Anhaenge, Dokumentenkette. Gleiches Muster fuer Angebot/AB und Lieferschein.
- Zahlung als Dialog (RowPaymentDialog aus 13a, PaymentForm eingebettet, #zahlung Deep-Link, Esc setzt Hash zurueck); Primaeraktion je Status ("Als bezahlt markieren" oeffnet vorbelegten Dialog, bucht nie still); "Neue Rechnung" im Kopf aller drei Belegseiten (/rechnungen/neu?customerId=).
- Angebots-Menue ueber availableActions/convertTargets (13a); canBillQuote-Gate fuer stornierte/abgelehnte Angebote (Smoke-Fund).
- Mahnwesen als eigene Karte unter der Vorschau (volle Breite).

## Hotfix (separat, main f8beffe): E-Rechnung XSD — UBL-Gutschrift BT-9 als PaymentMeans/PaymentDueDate; CII nur ein InvoiceReferencedDocument (letzter Abschlag, Rest in BT-22). KoSIT-CI-Job prueft jetzt alle Fixtures mit XSD (aus 13b).

## Backlog (Nits N3, N7–N9 aus final-review.md, lokal)
- rechnungen/[id]/page.tsx 275 Zeilen -> Split; Zod-Schema fuer customerId-Param; PaymentForm-Fallback; Sidebar-Fuss ueberlappt bei kleiner Hoehe (seit 11a).

## Hinweise 13d
- Tags/Vorlagen haengen sich an die Detailkarten (13c) und Listen (13a) an; TEMPLATE_SAVE als ActionKey erst jetzt einfuehren.
