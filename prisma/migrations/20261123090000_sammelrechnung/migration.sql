-- Sammelrechnung: Schalter und Blockueberschrift am Abo, Herkunft je Rechnungsposition (nur Spalten, additiv)
ALTER TABLE "RecurringInvoice" ADD COLUMN "collectiveBilling" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RecurringInvoice" ADD COLUMN "invoiceHeading" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "recurringInvoiceId" TEXT;
