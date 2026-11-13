-- Phase 16d (Postversand) — nur additiv. Bestand: Kunden behalten den Kanal EMAIL, Mahnstufen
-- CUSTOMER mit Post-Rueckfall; PostalSettings/PostalJob/PostalJobEvent starten leer.
-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "deliveryChannel" TEXT NOT NULL DEFAULT 'EMAIL';

-- AlterTable
ALTER TABLE "DunningStage" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'CUSTOMER',
ADD COLUMN "postFallback" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PostalSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'LETTERXPRESS',
    "username" TEXT,
    "apiKeyEnc" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'DRY_RUN',
    "autoDunningPost" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT NOT NULL DEFAULT '1',
    "duplex" BOOLEAN NOT NULL DEFAULT false,
    "shipping" TEXT NOT NULL DEFAULT 'auto',
    "registeredDefault" TEXT,
    "monthlyBudgetCents" INTEGER,
    "lastBalanceCents" INTEGER,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostalJob" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'LETTERXPRESS',
    "providerJobId" INTEGER,
    "filename" TEXT NOT NULL,
    "pages" INTEGER NOT NULL,
    "color" TEXT NOT NULL,
    "duplex" BOOLEAN NOT NULL,
    "shipping" TEXT NOT NULL,
    "registered" TEXT,
    "quotedPriceCents" INTEGER,
    "priceCents" INTEGER,
    "vatCents" INTEGER,
    "pdfSha256" TEXT NOT NULL,
    "base64Md5" TEXT NOT NULL,
    "providerAddress" TEXT,
    "trackingCode" TEXT,
    "trackingStatus" TEXT,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PostalJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostalJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "PostalJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostalSettings_orgId_key" ON "PostalSettings"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PostalJob_provider_providerJobId_key" ON "PostalJob"("provider", "providerJobId");

-- CreateIndex
CREATE INDEX "PostalJob_orgId_status_idx" ON "PostalJob"("orgId", "status");

-- CreateIndex
CREATE INDEX "PostalJob_docType_docId_idx" ON "PostalJob"("docType", "docId");

-- CreateIndex
CREATE INDEX "PostalJob_orgId_createdAt_idx" ON "PostalJob"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "PostalJobEvent_jobId_at_idx" ON "PostalJobEvent"("jobId", "at");

-- AddForeignKey
ALTER TABLE "PostalSettings" ADD CONSTRAINT "PostalSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostalJob" ADD CONSTRAINT "PostalJob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostalJobEvent" ADD CONSTRAINT "PostalJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PostalJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
