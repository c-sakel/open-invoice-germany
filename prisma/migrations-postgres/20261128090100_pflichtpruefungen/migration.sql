-- Umsatzgrenzen der Kleinunternehmerregelung (§ 19 UStG) und Verzugshinweis (§ 286 Abs. 3 BGB) — nur additiv.
-- Bestand: Warnschwelle 80 %, kein Gruendungsjahr, keine externen Umsaetze, Verzugshinweis aus, Belege NULL (= automatisch).
ALTER TABLE "DocumentSettings" ADD COLUMN "kuWarnPercent" INTEGER NOT NULL DEFAULT 80;
ALTER TABLE "DocumentSettings" ADD COLUMN "kuBusinessStartYear" INTEGER;
ALTER TABLE "DocumentSettings" ADD COLUMN "kuExternalRevenueJson" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "DocumentSettings" ADD COLUMN "consumerDefaultNotice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Invoice" ADD COLUMN "consumerDefaultNotice" BOOLEAN;
-- Bestands-Organisationen: Benachrichtigungstyp KU_THRESHOLD aktivieren (bleibt abwaehlbar, kein Pflicht-Alarm).
-- enabledTypesJson ist ein kompaktes JSON-Array (JSON.stringify); '[]' und Arrays ohne den Typ werden ergaenzt.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["KU_THRESHOLD"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"KU_THRESHOLD"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%KU_THRESHOLD%';
