-- CreateTable
CREATE TABLE "IncomingInvoice" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "originalMime" TEXT NOT NULL,
    "originalSize" INTEGER NOT NULL,
    "originalSha256" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "xmlPath" TEXT,
    "xmlSha256" TEXT,
    "kind" TEXT NOT NULL,
    "syntax" TEXT,
    "profile" TEXT,
    "isEInvoice" BOOLEAN NOT NULL DEFAULT false,
    "typeCode" TEXT,
    "number" TEXT,
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "deliveryDate" TIMESTAMP(3),
    "currency" TEXT,
    "netCents" INTEGER,
    "taxCents" INTEGER,
    "grossCents" INTEGER,
    "payableCents" INTEGER,
    "supplierName" TEXT,
    "supplierVatId" TEXT,
    "supplierTaxNumber" TEXT,
    "supplierJson" TEXT,
    "buyerName" TEXT,
    "buyerVatId" TEXT,
    "paymentJson" TEXT,
    "hintsJson" TEXT NOT NULL DEFAULT '[]',
    "validationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "duplicateOfId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IncomingInvoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IncomingInvoice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IncomingInvoice_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "IncomingInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IncomingInvoiceValidation" (
    "id" TEXT NOT NULL,
    "incomingInvoiceId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "engine" TEXT NOT NULL,
    "artefactVersion" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "formatErrors" INTEGER NOT NULL DEFAULT 0,
    "ruleErrors" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "findingsJson" TEXT NOT NULL DEFAULT '[]',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "IncomingInvoiceValidation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IncomingInvoiceValidation_incomingInvoiceId_fkey" FOREIGN KEY ("incomingInvoiceId") REFERENCES "IncomingInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "IncomingInvoice_orgId_status_receivedAt_idx" ON "IncomingInvoice"("orgId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "IncomingInvoice_orgId_supplierVatId_number_idx" ON "IncomingInvoice"("orgId", "supplierVatId", "number");

-- CreateIndex
CREATE INDEX "IncomingInvoice_orgId_updatedAt_idx" ON "IncomingInvoice"("orgId", "updatedAt");

-- CreateIndex
CREATE INDEX "IncomingInvoice_orgId_validationStatus_idx" ON "IncomingInvoice"("orgId", "validationStatus");

-- CreateIndex
CREATE INDEX "IncomingInvoice_duplicateOfId_idx" ON "IncomingInvoice"("duplicateOfId");

-- CreateIndex
CREATE UNIQUE INDEX "IncomingInvoice_orgId_originalSha256_key" ON "IncomingInvoice"("orgId", "originalSha256");

-- CreateIndex
CREATE INDEX "IncomingInvoiceValidation_incomingInvoiceId_at_idx" ON "IncomingInvoiceValidation"("incomingInvoiceId", "at");

