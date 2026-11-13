-- Phase 17a (E-Rechnung & Steuer), Task 1 — nur additiv. Bestand: EAS-Schemacodes und BT-47 NULL
-- (= Bestandsverhalten, EM), VIES-Pruefung eingeschaltet, nicht beim Festschreiben.
-- VatIdCheck ist append-only (Guard in src/lib/db.ts).
ALTER TABLE "Organization" ADD COLUMN "electronicAddressScheme" TEXT;
ALTER TABLE "Customer" ADD COLUMN "peppolScheme" TEXT;
ALTER TABLE "Customer" ADD COLUMN "legalRegistrationId" TEXT;
ALTER TABLE "DocumentSettings" ADD COLUMN "viesCheckEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "DocumentSettings" ADD COLUMN "viesCheckOnFinalize" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "VatIdCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "vatId" TEXT NOT NULL,
    "requesterVatId" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "requestIdentifier" TEXT,
    "requestDate" DATETIME,
    "traderName" TEXT,
    "traderAddress" TEXT,
    "trigger" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VatIdCheck_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "VatIdCheck_orgId_customerId_checkedAt_idx" ON "VatIdCheck"("orgId", "customerId", "checkedAt");
