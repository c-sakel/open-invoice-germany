-- Phase 18d (API-Abgleich) — nur Indizes, keine Datenaenderung.

-- CreateIndex
CREATE INDEX "Invoice_orgId_updatedAt_idx" ON "Invoice"("orgId", "updatedAt");

-- CreateIndex
CREATE INDEX "Quote_orgId_updatedAt_idx" ON "Quote"("orgId", "updatedAt");

-- CreateIndex
CREATE INDEX "DeliveryNote_orgId_updatedAt_idx" ON "DeliveryNote"("orgId", "updatedAt");

-- CreateIndex
CREATE INDEX "Customer_orgId_updatedAt_idx" ON "Customer"("orgId", "updatedAt");

-- CreateIndex
CREATE INDEX "Product_orgId_updatedAt_idx" ON "Product"("orgId", "updatedAt");
