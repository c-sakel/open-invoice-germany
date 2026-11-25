-- Abrechnungsart je Abo (ADVANCE = im Voraus, ARREARS = nachträglich). Bestand bleibt nachträglich.
ALTER TABLE "RecurringInvoice" ADD COLUMN "billingTiming" TEXT NOT NULL DEFAULT 'ARREARS';
