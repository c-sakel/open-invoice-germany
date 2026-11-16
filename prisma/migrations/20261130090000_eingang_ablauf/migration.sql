-- Eingangsrechnungen: Arbeitsablauf, Lieferantenzuordnung und wirksame Faelligkeit — nur additiv.
-- Bestand: Faelligkeit = Faelligkeit aus der Datei, alle weiteren Felder NULL, Status unveraendert.
ALTER TABLE "IncomingInvoice" ADD COLUMN "supplierContactId" TEXT;
ALTER TABLE "IncomingInvoice" ADD COLUMN "internalNote" TEXT;
ALTER TABLE "IncomingInvoice" ADD COLUMN "manualJson" TEXT;
ALTER TABLE "IncomingInvoice" ADD COLUMN "dueAt" DATETIME;
ALTER TABLE "IncomingInvoice" ADD COLUMN "checkedAt" DATETIME;
ALTER TABLE "IncomingInvoice" ADD COLUMN "checkedBy" TEXT;
ALTER TABLE "IncomingInvoice" ADD COLUMN "approvedAt" DATETIME;
ALTER TABLE "IncomingInvoice" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "IncomingInvoice" ADD COLUMN "rejectedAt" DATETIME;
ALTER TABLE "IncomingInvoice" ADD COLUMN "rejectedBy" TEXT;
ALTER TABLE "IncomingInvoice" ADD COLUMN "rejectReason" TEXT;
ALTER TABLE "IncomingInvoice" ADD COLUMN "paidMarkedAt" DATETIME;
ALTER TABLE "IncomingInvoice" ADD COLUMN "paidNote" TEXT;
CREATE INDEX "IncomingInvoice_orgId_status_dueAt_idx" ON "IncomingInvoice"("orgId", "status", "dueAt");
CREATE INDEX "IncomingInvoice_orgId_supplierContactId_idx" ON "IncomingInvoice"("orgId", "supplierContactId");
UPDATE "IncomingInvoice" SET "dueAt" = "dueDate" WHERE "dueDate" IS NOT NULL AND "dueAt" IS NULL;
-- Bestands-Organisationen: Benachrichtigungstyp INCOMING_DUE aktivieren (bleibt abwaehlbar, kein Pflicht-Alarm).
-- enabledTypesJson ist ein kompaktes JSON-Array (JSON.stringify); '[]' und Arrays ohne den Typ werden ergaenzt.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["INCOMING_DUE"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"INCOMING_DUE"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"INCOMING_DUE"%';
