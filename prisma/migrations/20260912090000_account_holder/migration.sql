-- Kontoinhaber/-in (fix/einheiten-kontoinhaber) — GiroCode-Name/Fusszeile/E-Rechnung
-- (BT-85) fallen ohne Angabe auf legalName zurueck (siehe mapper.ts/footer.ts).
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "accountHolder" TEXT;
