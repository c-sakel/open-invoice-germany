-- Phase 13d — Tags. Zwei neue Tabellen, rein additiv. DocumentTag haengt per
-- ON DELETE CASCADE am Tag: das Loeschen eines Tags entfernt seine Zuordnungen,
-- ruehrt aber keinen Beleg an (Tags sind Metadaten, kein Belegdatum).
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tag_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "DocumentTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Tag_orgId_name_key" ON "Tag"("orgId", "name");
CREATE UNIQUE INDEX "DocumentTag_orgId_tagId_docType_docId_key" ON "DocumentTag"("orgId", "tagId", "docType", "docId");
CREATE INDEX "DocumentTag_orgId_docType_docId_idx" ON "DocumentTag"("orgId", "docType", "docId");
CREATE INDEX "DocumentTag_orgId_tagId_idx" ON "DocumentTag"("orgId", "tagId");
