-- Phase 13d — Belegvorlagen. Eine neue Tabelle, rein additiv, kein Bestandsdatensatz
-- wird angefasst. Stammdaten, kein GoBD-Beleg (kein ChangeLog-Bezug).
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "kind" TEXT,
    "customerId" TEXT,
    "payloadJson" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DocumentTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DocumentTemplate_orgId_name_key" ON "DocumentTemplate"("orgId", "name");
CREATE INDEX "DocumentTemplate_orgId_docType_idx" ON "DocumentTemplate"("orgId", "docType");
