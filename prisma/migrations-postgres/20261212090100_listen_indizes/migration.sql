-- CreateIndex
CREATE INDEX "Customer_orgId_name_idx" ON "Customer"("orgId", "name");

-- CreateIndex
CREATE INDEX "Invoice_orgId_issueDate_idx" ON "Invoice"("orgId", "issueDate");
