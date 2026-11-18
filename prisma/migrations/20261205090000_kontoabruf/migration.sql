-- Kontoabruf per FinTS: vier neue Tabellen, eine neue Spalte, nur additiv. Standard aus (ohne Einstellungszeile und ohne Bankzugang kein Abruf).

-- CreateTable
CREATE TABLE "BankFetchSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "productId" TEXT,
    "autoHour" INTEGER NOT NULL DEFAULT 6,
    "firstFetchDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankFetchSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "lastAttemptAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastScaAt" DATETIME,
    "lastErrorCode" TEXT,
    "nextAutoAt" DATETIME,
    "leaseUntil" DATETIME,
    "credentialsChangedAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankConnectionAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "accountNumber" TEXT,
    "subAccount" TEXT,
    "currency" TEXT,
    "productName" TEXT,
    "camtSupported" BOOLEAN NOT NULL DEFAULT false,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "lastFetchedTo" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankConnectionAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankConnectionAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankFetchRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "accountId" TEXT,
    "trigger" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME NOT NULL,
    "result" TEXT NOT NULL,
    "bankCodes" TEXT,
    "fromDate" DATETIME,
    "toDate" DATETIME,
    "documents" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "importId" TEXT,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "scaUsed" BOOLEAN NOT NULL DEFAULT false,
    "actor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankFetchRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankFetchRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankFetchRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankConnectionAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankFetchRun_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankStatementImport" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- AlterTable (Herkunft des Imports; Bestand = Upload)
ALTER TABLE "BankStatementImport" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'UPLOAD';

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
