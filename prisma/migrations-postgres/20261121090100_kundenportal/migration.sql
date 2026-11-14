-- Kundenportal — nur additiv: drei neue Tabellen, Bestand unveraendert (Portal standardmaessig aus).
-- CreateTable
CREATE TABLE "CustomerPortalSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "linkDays" INTEGER NOT NULL DEFAULT 365,
    "showDunnings" BOOLEAN NOT NULL DEFAULT true,
    "showEInvoice" BOOLEAN NOT NULL DEFAULT true,
    "mailSubject" TEXT,
    "mailBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPortalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPortalLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomerPortalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPortalEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "docType" TEXT,
    "docId" TEXT,
    "fileKind" TEXT,

    CONSTRAINT "CustomerPortalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPortalSettings_orgId_key" ON "CustomerPortalSettings"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPortalLink_tokenHash_key" ON "CustomerPortalLink"("tokenHash");

-- CreateIndex
CREATE INDEX "CustomerPortalLink_orgId_customerId_idx" ON "CustomerPortalLink"("orgId", "customerId");

-- CreateIndex
CREATE INDEX "CustomerPortalEvent_linkId_at_idx" ON "CustomerPortalEvent"("linkId", "at");

-- CreateIndex
CREATE INDEX "CustomerPortalEvent_orgId_at_idx" ON "CustomerPortalEvent"("orgId", "at");

-- AddForeignKey
ALTER TABLE "CustomerPortalSettings" ADD CONSTRAINT "CustomerPortalSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPortalLink" ADD CONSTRAINT "CustomerPortalLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPortalLink" ADD CONSTRAINT "CustomerPortalLink_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPortalEvent" ADD CONSTRAINT "CustomerPortalEvent_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "CustomerPortalLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
