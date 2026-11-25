-- Zustellung und Alarme: Tabelle fuer den automatischen Versand von Abo-Rechnungen, Alarm-Mail-Einstellung, Benachrichtigungstyp WEBHOOK_DEAD. Nur additiv.

-- CreateTable
CREATE TABLE "InvoiceAutoSend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "recurringId" TEXT,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "emailLogId" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceAutoSend_invoiceId_key" ON "InvoiceAutoSend"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceAutoSend_status_nextAttemptAt_idx" ON "InvoiceAutoSend"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InvoiceAutoSend_orgId_status_idx" ON "InvoiceAutoSend"("orgId", "status");

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "alarmMailedAt" DATETIME;

-- AlterTable
ALTER TABLE "NotificationSettings" ADD COLUMN "alarmEmail" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "NotificationSettings" ADD COLUMN "lastAlarmMailAt" DATETIME;

-- Bestand: bisherige Benachrichtigungen gelten als bereits gemeldet (sonst verschickt der erste Lauf alle alten Alarme).
UPDATE "Notification" SET "alarmMailedAt" = "createdAt" WHERE "alarmMailedAt" IS NULL;

-- Bestands-Organisationen: Benachrichtigungstyp WEBHOOK_DEAD aktivieren (bleibt abwaehlbar).
-- enabledTypesJson ist ein kompaktes JSON-Array (JSON.stringify); '[]' und Arrays ohne den Typ werden ergaenzt, idempotent.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["WEBHOOK_DEAD"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"WEBHOOK_DEAD"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"WEBHOOK_DEAD"%';
