-- Zahlungsaktionen — nur additiv: zwei neue Tabellen, Bestand unveraendert.
-- CreateTable
CREATE TABLE "PaymentRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL,
    "sourcesJson" TEXT,
    "invoiceTagId" TEXT,
    "delayMinutes" INTEGER NOT NULL DEFAULT 5,
    "actionsJson" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRuleRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actionsJson" TEXT NOT NULL,
    "stepsJson" TEXT NOT NULL,
    "contextJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "skipReason" TEXT,
    "mailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentRuleRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentRule_orgId_active_idx" ON "PaymentRule"("orgId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRuleRun_ruleId_paymentId_key" ON "PaymentRuleRun"("ruleId", "paymentId");

-- CreateIndex
CREATE INDEX "PaymentRuleRun_status_nextAttemptAt_idx" ON "PaymentRuleRun"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PaymentRuleRun_orgId_createdAt_idx" ON "PaymentRuleRun"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentRuleRun_orgId_customerId_mailSentAt_idx" ON "PaymentRuleRun"("orgId", "customerId", "mailSentAt");

-- CreateIndex
CREATE INDEX "PaymentRuleRun_paymentId_idx" ON "PaymentRuleRun"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentRuleRun_invoiceId_idx" ON "PaymentRuleRun"("invoiceId");

-- AddForeignKey
ALTER TABLE "PaymentRule" ADD CONSTRAINT "PaymentRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRuleRun" ADD CONSTRAINT "PaymentRuleRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PaymentRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bestands-Organisationen: neue Benachrichtigungstypen aktivieren (abwaehlbar). enabledTypesJson ist ein kompaktes JSON-Array.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["PAYMENT_RULE"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"PAYMENT_RULE"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"PAYMENT_RULE"%';

UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["PAYMENT_RULE_FAILED"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"PAYMENT_RULE_FAILED"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"PAYMENT_RULE_FAILED"%';
