-- Phase 13d — Belegvorlagen. Eine neue Tabelle, rein additiv, kein Bestandsdatensatz
-- wird angefasst. Stammdaten, kein GoBD-Beleg (kein ChangeLog-Bezug).
-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "kind" TEXT,
    "customerId" TEXT,
    "payloadJson" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_orgId_name_key" ON "DocumentTemplate"("orgId", "name");

-- CreateIndex
CREATE INDEX "DocumentTemplate_orgId_docType_idx" ON "DocumentTemplate"("orgId", "docType");

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
