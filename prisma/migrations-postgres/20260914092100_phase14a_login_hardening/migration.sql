-- Phase 14a, Task 8 (R12) — Anmeldung haerten: Kontosperre nach Fehlversuchen (ueberlebt
-- einen Neustart, anders als die In-Memory-IP-Bremse in src/lib/rate-limit.ts) und
-- Vorbereitung fuer Task 9 (Sitzungsentwertung nach Passwortaenderung). Vier additive
-- Spalten auf "User": failedLoginCount startet bei 0 (kein Bestands-Konto ist gesperrt),
-- die drei Zeitstempel bleiben bei Bestandszeilen NULL (kein Backfill noetig, kein
-- bisheriger Fehlversuch/Login/Passwortwechsel ist rekonstruierbar). Nichts Destruktives,
-- keine neue Tabelle.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
