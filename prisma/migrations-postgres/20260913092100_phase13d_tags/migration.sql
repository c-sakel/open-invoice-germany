-- Phase 13d — Tags. Zwei neue Tabellen, rein additiv. DocumentTag haengt per
-- ON DELETE CASCADE am Tag: das Loeschen eines Tags entfernt seine Zuordnungen,
-- ruehrt aber keinen Beleg an (Tags sind Metadaten, kein Belegdatum).
-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTag" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tag_orgId_name_key" ON "Tag"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTag_orgId_tagId_docType_docId_key" ON "DocumentTag"("orgId", "tagId", "docType", "docId");

-- CreateIndex
CREATE INDEX "DocumentTag_orgId_docType_docId_idx" ON "DocumentTag"("orgId", "docType", "docId");

-- CreateIndex
CREATE INDEX "DocumentTag_orgId_tagId_idx" ON "DocumentTag"("orgId", "tagId");

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTag" ADD CONSTRAINT "DocumentTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
