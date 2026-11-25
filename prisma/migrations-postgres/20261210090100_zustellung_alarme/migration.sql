-- Zustellung und Alarme: Tabelle fuer den automatischen Versand von Abo-Rechnungen, Alarm-Mail-Einstellung, Benachrichtigungstyp WEBHOOK_DEAD. Nur additiv.

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "alarmMailedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationSettings" ADD COLUMN     "alarmEmail" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastAlarmMailAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InvoiceAutoSend" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "recurringId" TEXT,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "emailLogId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceAutoSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceAutoSend_invoiceId_key" ON "InvoiceAutoSend"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceAutoSend_status_nextAttemptAt_idx" ON "InvoiceAutoSend"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InvoiceAutoSend_orgId_status_idx" ON "InvoiceAutoSend"("orgId", "status");

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
