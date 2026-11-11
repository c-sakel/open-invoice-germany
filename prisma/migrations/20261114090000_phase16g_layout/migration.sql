-- Phase 16g (Layout-Designer), Task 2 — nur additiv. Bestand: keine Designs, Mahnungen
-- behalten layoutVersionId NULL (= festes Layout). Versionen sind unveraenderlich (Guard in
-- src/lib/db.ts); Fremdschluessel ON DELETE RESTRICT, damit eingefrorene Belege nie ins Leere zeigen.
CREATE TABLE "LayoutDesign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseLayoutId" TEXT NOT NULL DEFAULT 'standard',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LayoutDesign_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "LayoutDesignVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "designId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "configJson" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LayoutDesignVersion_designId_fkey" FOREIGN KEY ("designId") REFERENCES "LayoutDesign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LayoutDesign_orgId_name_key" ON "LayoutDesign"("orgId", "name");
CREATE UNIQUE INDEX "LayoutDesignVersion_designId_version_key" ON "LayoutDesignVersion"("designId", "version");

ALTER TABLE "Dunning" ADD COLUMN "layoutVersionId" TEXT;
