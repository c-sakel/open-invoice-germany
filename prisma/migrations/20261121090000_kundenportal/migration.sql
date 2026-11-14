-- Kundenportal — nur additiv: drei neue Tabellen, Bestand unveraendert (Portal standardmaessig aus).
CREATE TABLE "CustomerPortalSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "linkDays" INTEGER NOT NULL DEFAULT 365,
    "showDunnings" BOOLEAN NOT NULL DEFAULT true,
    "showEInvoice" BOOLEAN NOT NULL DEFAULT true,
    "mailSubject" TEXT,
    "mailBody" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CustomerPortalSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CustomerPortalLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revokedBy" TEXT,
    "revokeReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastViewedAt" DATETIME,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CustomerPortalLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CustomerPortalLink_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CustomerPortalEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "docType" TEXT,
    "docId" TEXT,
    "fileKind" TEXT,
    CONSTRAINT "CustomerPortalEvent_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "CustomerPortalLink" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CustomerPortalSettings_orgId_key" ON "CustomerPortalSettings"("orgId");
CREATE UNIQUE INDEX "CustomerPortalLink_tokenHash_key" ON "CustomerPortalLink"("tokenHash");
CREATE INDEX "CustomerPortalLink_orgId_customerId_idx" ON "CustomerPortalLink"("orgId", "customerId");
CREATE INDEX "CustomerPortalEvent_linkId_at_idx" ON "CustomerPortalEvent"("linkId", "at");
CREATE INDEX "CustomerPortalEvent_orgId_at_idx" ON "CustomerPortalEvent"("orgId", "at");
