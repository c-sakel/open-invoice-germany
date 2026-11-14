-- Bankabgleich — nur additiv: vier neue Tabellen, Bestand unveraendert.
CREATE TABLE "BankStatementImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "fileName" TEXT,
    "format" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "accountIban" TEXT,
    "statementId" TEXT,
    "seqNo" TEXT,
    "periodFrom" DATETIME,
    "periodTo" DATETIME,
    "entryCount" INTEGER NOT NULL,
    "importedCount" INTEGER NOT NULL,
    "duplicateCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "warningsJson" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankStatementImport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "accountIban" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "bookingDate" DATETIME NOT NULL,
    "valueDate" DATETIME,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "counterpartyName" TEXT,
    "counterpartyIban" TEXT,
    "remittance" TEXT NOT NULL DEFAULT '',
    "endToEndId" TEXT,
    "acctSvcrRef" TEXT,
    "bankTxCode" TEXT,
    "returnReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "allocatedCents" INTEGER NOT NULL DEFAULT 0,
    "ignoredReason" TEXT,
    "ignoredBy" TEXT,
    "ignoredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankTransaction_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankTransaction_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankStatementImport" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "BankMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "refMatchId" TEXT,
    "reason" TEXT,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankMatch_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankMatch_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BankMatch_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "BankCounterpartyHint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "ibanHash" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "lastUsedAt" DATETIME NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "BankCounterpartyHint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BankCounterpartyHint_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BankStatementImport_orgId_fileSha256_key" ON "BankStatementImport"("orgId", "fileSha256");
CREATE INDEX "BankStatementImport_orgId_createdAt_idx" ON "BankStatementImport"("orgId", "createdAt");
CREATE UNIQUE INDEX "BankTransaction_orgId_fingerprint_key" ON "BankTransaction"("orgId", "fingerprint");
CREATE INDEX "BankTransaction_orgId_status_bookingDate_idx" ON "BankTransaction"("orgId", "status", "bookingDate");
CREATE INDEX "BankTransaction_importId_idx" ON "BankTransaction"("importId");
CREATE UNIQUE INDEX "BankMatch_paymentId_key" ON "BankMatch"("paymentId");
CREATE INDEX "BankMatch_orgId_invoiceId_idx" ON "BankMatch"("orgId", "invoiceId");
CREATE INDEX "BankMatch_transactionId_idx" ON "BankMatch"("transactionId");
CREATE UNIQUE INDEX "BankCounterpartyHint_orgId_ibanHash_key" ON "BankCounterpartyHint"("orgId", "ibanHash");
