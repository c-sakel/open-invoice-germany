-- Phase 14a, Task 3 — Verzugszinsen taggenau je Basiszins-Halbjahr stueckeln
-- (§ 288 Abs. 1 Satz 2 BGB, R7/R8). Neue, additive Spalte auf "Dunning": Snapshot der
-- Verzugszins-Abschnitte einer Mahnung, JSON-Array [{from,to,days,baseRateBp,pointsBp,
-- interestCents}] — geschrieben beim Erstellen der Mahnung (src/domain/dunning/create.ts),
-- danach unveraendert (GoBD, Bestandsmahnungen werden nicht neu berechnet). Bestandszeilen
-- bleiben NULL, das Mahn-PDF zeigt fuer sie weiterhin die bisherige Einzelzeile. Nichts
-- Destruktives, keine neue Tabelle (Tabellenzahl bleibt 49).
-- AlterTable
ALTER TABLE "Dunning" ADD COLUMN "interestSegmentsJson" TEXT;
