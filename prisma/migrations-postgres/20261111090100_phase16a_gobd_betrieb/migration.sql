-- Phase 16a (GoBD + Betrieb), Task 1 — Schema-Grundlage: Gegenbuchung fuer Zahlungen
-- (Payment.kind/reversesPaymentId/reason, Anbieter-Idempotenz provider+providerPaymentId,
-- createdBy), Belegarchiv (ArchivedDocument), Ergebnisse der Kettenpruefung
-- (ChainVerification), Systemmarken (SystemMarker, archive-epoch = Grenze fuer BACKFILL)
-- und Dunning.pdfSha256. Nur additiv: Bestandszeilen erhalten die Defaults (kind=PAYMENT,
-- createdBy=user), nichts wird entfernt oder umgeschrieben. Der Unique-Index auf
-- (provider, providerPaymentId) erlaubt beliebig viele Zeilen mit NULL/NULL.
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PAYMENT';
ALTER TABLE "Payment" ADD COLUMN "reversesPaymentId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "reason" TEXT;
ALTER TABLE "Payment" ADD COLUMN "provider" TEXT;
ALTER TABLE "Payment" ADD COLUMN "providerPaymentId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "createdBy" TEXT NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "Dunning" ADD COLUMN "pdfSha256" TEXT;

-- CreateTable
CREATE TABLE "ArchivedDocument" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchivedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainVerification" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid" BOOLEAN NOT NULL,
    "entries" INTEGER NOT NULL,
    "brokenEntryId" INTEGER,
    "lastHash" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,

    CONSTRAINT "ChainVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemMarker" (
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemMarker_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Payment_reversesPaymentId_idx" ON "Payment"("reversesPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerPaymentId_key" ON "Payment"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchivedDocument_invoiceId_kind_key" ON "ArchivedDocument"("invoiceId", "kind");

-- CreateIndex
CREATE INDEX "ChainVerification_orgId_checkedAt_idx" ON "ChainVerification"("orgId", "checkedAt");

-- AddForeignKey
ALTER TABLE "ArchivedDocument" ADD CONSTRAINT "ArchivedDocument_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "SystemMarker" ("key", "at") VALUES ('archive-epoch', CURRENT_TIMESTAMP);
