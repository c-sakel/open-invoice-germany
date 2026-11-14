-- Bankabgleich — nur additiv: vier neue Tabellen, Bestand unveraendert.
-- CreateTable
CREATE TABLE "BankStatementImport" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "fileName" TEXT,
    "format" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "accountIban" TEXT,
    "statementId" TEXT,
    "seqNo" TEXT,
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3),
    "entryCount" INTEGER NOT NULL,
    "importedCount" INTEGER NOT NULL,
    "duplicateCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "warningsJson" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "accountIban" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "bookingDate" TIMESTAMP(3) NOT NULL,
    "valueDate" TIMESTAMP(3),
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
    "ignoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankMatch" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "refMatchId" TEXT,
    "reason" TEXT,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankCounterpartyHint" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ibanHash" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BankCounterpartyHint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementImport_orgId_fileSha256_key" ON "BankStatementImport"("orgId", "fileSha256");

-- CreateIndex
CREATE INDEX "BankStatementImport_orgId_createdAt_idx" ON "BankStatementImport"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_orgId_fingerprint_key" ON "BankTransaction"("orgId", "fingerprint");

-- CreateIndex
CREATE INDEX "BankTransaction_orgId_status_bookingDate_idx" ON "BankTransaction"("orgId", "status", "bookingDate");

-- CreateIndex
CREATE INDEX "BankTransaction_importId_idx" ON "BankTransaction"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "BankMatch_paymentId_key" ON "BankMatch"("paymentId");

-- CreateIndex
CREATE INDEX "BankMatch_orgId_invoiceId_idx" ON "BankMatch"("orgId", "invoiceId");

-- CreateIndex
CREATE INDEX "BankMatch_transactionId_idx" ON "BankMatch"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "BankCounterpartyHint_orgId_ibanHash_key" ON "BankCounterpartyHint"("orgId", "ibanHash");

-- AddForeignKey
ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankStatementImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankCounterpartyHint" ADD CONSTRAINT "BankCounterpartyHint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankCounterpartyHint" ADD CONSTRAINT "BankCounterpartyHint_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
