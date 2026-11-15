-- Stripe — nur Spalten: Zahlungsreferenz am Bezahlvorgang, Live-Kennzeichen am Bezahllink (Bestand gilt als live ausgegeben).
-- AlterTable
ALTER TABLE "PaymentProviderAttempt" ADD COLUMN "providerPaymentRef" TEXT;

-- AlterTable
ALTER TABLE "InvoicePayLink" ADD COLUMN "liveIssued" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderAttempt_provider_providerPaymentRef_key" ON "PaymentProviderAttempt"("provider", "providerPaymentRef");
