-- Phase 17a (E-Rechnung & Steuer), Task 1 — nur additiv. Bestand: EAS-Schemacodes und BT-47 NULL
-- (= Bestandsverhalten, EM), VIES-Pruefung eingeschaltet, nicht beim Festschreiben.
-- VatIdCheck ist append-only (Guard in src/lib/db.ts).
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "electronicAddressScheme" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "peppolScheme" TEXT,
ADD COLUMN "legalRegistrationId" TEXT;

-- AlterTable
ALTER TABLE "DocumentSettings" ADD COLUMN "viesCheckEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "viesCheckOnFinalize" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "VatIdCheck" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "vatId" TEXT NOT NULL,
    "requesterVatId" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "requestIdentifier" TEXT,
    "requestDate" TIMESTAMP(3),
    "traderName" TEXT,
    "traderAddress" TEXT,
    "trigger" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VatIdCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VatIdCheck_orgId_customerId_checkedAt_idx" ON "VatIdCheck"("orgId", "customerId", "checkedAt");

-- AddForeignKey
ALTER TABLE "VatIdCheck" ADD CONSTRAINT "VatIdCheck_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
