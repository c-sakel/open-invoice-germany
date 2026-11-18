-- Kontoabruf per FinTS: vier neue Tabellen, eine neue Spalte, nur additiv. Standard aus (ohne Einstellungszeile und ohne Bankzugang kein Abruf).

-- AlterTable
ALTER TABLE "BankStatementImport" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'UPLOAD';

-- CreateTable
CREATE TABLE "BankFetchSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "productId" TEXT,
    "autoHour" INTEGER NOT NULL DEFAULT 6,
    "firstFetchDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankFetchSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT,
    "pinMode" TEXT NOT NULL DEFAULT 'PER_FETCH',
    "pinEnc" TEXT,
    "rejectedPinHmac" TEXT,
    "tanMethodId" INTEGER,
    "tanMediaName" TEXT,
    "bankingInfoJson" TEXT,
    "autoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "authFailures" INTEGER NOT NULL DEFAULT 0,
    "transientFailuresToday" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastScaAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "nextAutoAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "credentialsChangedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankConnectionAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "accountNumber" TEXT,
    "subAccount" TEXT,
    "currency" TEXT,
    "productName" TEXT,
    "camtSupported" BOOLEAN NOT NULL DEFAULT false,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "lastFetchedTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankConnectionAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankFetchRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "accountId" TEXT,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "result" TEXT NOT NULL,
    "bankCodes" TEXT,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "documents" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "importId" TEXT,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "scaUsed" BOOLEAN NOT NULL DEFAULT false,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankFetchRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankFetchSettings_orgId_key" ON "BankFetchSettings"("orgId");

-- CreateIndex
CREATE INDEX "BankConnection_orgId_state_idx" ON "BankConnection"("orgId", "state");

-- CreateIndex
CREATE INDEX "BankConnectionAccount_orgId_selected_idx" ON "BankConnectionAccount"("orgId", "selected");

-- CreateIndex
CREATE UNIQUE INDEX "BankConnectionAccount_connectionId_iban_key" ON "BankConnectionAccount"("connectionId", "iban");

-- CreateIndex
CREATE INDEX "BankFetchRun_orgId_startedAt_idx" ON "BankFetchRun"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "BankFetchRun_connectionId_startedAt_idx" ON "BankFetchRun"("connectionId", "startedAt");

-- AddForeignKey
ALTER TABLE "BankFetchSettings" ADD CONSTRAINT "BankFetchSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankConnectionAccount" ADD CONSTRAINT "BankConnectionAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankConnectionAccount" ADD CONSTRAINT "BankConnectionAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankFetchRun" ADD CONSTRAINT "BankFetchRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankFetchRun" ADD CONSTRAINT "BankFetchRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankFetchRun" ADD CONSTRAINT "BankFetchRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankConnectionAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankFetchRun" ADD CONSTRAINT "BankFetchRun_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankStatementImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bestands-Organisationen: Benachrichtigungstypen BANK_FETCH_ACTION und BANK_FETCH_ERROR aktivieren (bleiben abwaehlbar, keine Pflicht-Alarme).
-- enabledTypesJson ist ein kompaktes JSON-Array (JSON.stringify); '[]' und Arrays ohne den Typ werden ergaenzt.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["BANK_FETCH_ACTION"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"BANK_FETCH_ACTION"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"BANK_FETCH_ACTION"%';
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["BANK_FETCH_ERROR"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"BANK_FETCH_ERROR"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"BANK_FETCH_ERROR"%';
