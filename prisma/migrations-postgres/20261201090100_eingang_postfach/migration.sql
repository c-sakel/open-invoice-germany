-- Eingangsrechnungen: Postfach-Abruf — drei neue Tabellen, nur additiv. Standard aus (ohne Einstellungszeile kein Abruf).

-- CreateTable
CREATE TABLE "InboundMailboxSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT,
    "port" INTEGER NOT NULL DEFAULT 993,
    "security" TEXT NOT NULL DEFAULT 'TLS',
    "username" TEXT,
    "passwordEnc" TEXT,
    "folder" TEXT NOT NULL DEFAULT 'INBOX',
    "fetchSince" TIMESTAMP(3),
    "allowedSenderDomainsJson" TEXT NOT NULL DEFAULT '[]',
    "credentialsChangedAt" TIMESTAMP(3),
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunOk" BOOLEAN,
    "lastRunError" TEXT,
    "lastRunFetched" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InboundMailboxSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InboundMailboxSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InboundMailMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "uidValidity" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "messageIdHash" TEXT,
    "internalDate" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "size" INTEGER NOT NULL,
    "senderDomain" TEXT,
    "subject" TEXT,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InboundMailMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InboundMailMessage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InboundMailAttachment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "stagingPath" TEXT,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "previewJson" TEXT,
    "incomingInvoiceId" TEXT,
    "duplicateOfIncomingId" TEXT,
    "duplicateOfAttachmentId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "discardReason" TEXT,
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InboundMailAttachment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InboundMailAttachment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InboundMailAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "InboundMailMessage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InboundMailAttachment_incomingInvoiceId_fkey" FOREIGN KEY ("incomingInvoiceId") REFERENCES "IncomingInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundMailboxSettings_orgId_key" ON "InboundMailboxSettings"("orgId");

-- CreateIndex
CREATE INDEX "InboundMailMessage_orgId_messageIdHash_idx" ON "InboundMailMessage"("orgId", "messageIdHash");

-- CreateIndex
CREATE INDEX "InboundMailMessage_orgId_fetchedAt_idx" ON "InboundMailMessage"("orgId", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMailMessage_orgId_accountKey_uidValidity_uid_key" ON "InboundMailMessage"("orgId", "accountKey", "uidValidity", "uid");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMailAttachment_incomingInvoiceId_key" ON "InboundMailAttachment"("incomingInvoiceId");

-- CreateIndex
CREATE INDEX "InboundMailAttachment_orgId_status_createdAt_idx" ON "InboundMailAttachment"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "InboundMailAttachment_orgId_sha256_idx" ON "InboundMailAttachment"("orgId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMailAttachment_messageId_partIndex_key" ON "InboundMailAttachment"("messageId", "partIndex");

-- Bestands-Organisationen: Benachrichtigungstypen INBOUND_MAIL_NEW und INBOUND_MAIL_ERROR aktivieren (bleiben abwaehlbar, keine Pflicht-Alarme).
-- enabledTypesJson ist ein kompaktes JSON-Array (JSON.stringify); '[]' und Arrays ohne den Typ werden ergaenzt.
UPDATE "NotificationSettings"
SET "enabledTypesJson" = CASE
  WHEN "enabledTypesJson" = '[]' THEN '["INBOUND_MAIL_NEW"]'
  ELSE SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"INBOUND_MAIL_NEW"]'
END
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"INBOUND_MAIL_NEW"%';
UPDATE "NotificationSettings"
SET "enabledTypesJson" = SUBSTR("enabledTypesJson", 1, LENGTH("enabledTypesJson") - 1) || ',"INBOUND_MAIL_ERROR"]'
WHERE "enabledTypesJson" LIKE '[%]' AND "enabledTypesJson" NOT LIKE '%"INBOUND_MAIL_ERROR"%';
