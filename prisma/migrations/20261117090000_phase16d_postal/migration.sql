-- Phase 16d (Postversand) — nur additiv. Bestand: Kunden behalten den Kanal EMAIL, Mahnstufen
-- CUSTOMER mit Post-Rueckfall; PostalSettings/PostalJob/PostalJobEvent starten leer.
ALTER TABLE "Customer" ADD COLUMN "deliveryChannel" TEXT NOT NULL DEFAULT 'EMAIL';
ALTER TABLE "DunningStage" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "DunningStage" ADD COLUMN "postFallback" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "PostalSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "lastTestAt" DATETIME,
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PostalSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PostalJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "lastPolledAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "PostalJob_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PostalJobEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "PostalJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PostalJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PostalSettings_orgId_key" ON "PostalSettings"("orgId");
CREATE UNIQUE INDEX "PostalJob_provider_providerJobId_key" ON "PostalJob"("provider", "providerJobId");
CREATE INDEX "PostalJob_orgId_status_idx" ON "PostalJob"("orgId", "status");
CREATE INDEX "PostalJob_docType_docId_idx" ON "PostalJob"("docType", "docId");
CREATE INDEX "PostalJob_orgId_createdAt_idx" ON "PostalJob"("orgId", "createdAt");
CREATE INDEX "PostalJobEvent_jobId_at_idx" ON "PostalJobEvent"("jobId", "at");
