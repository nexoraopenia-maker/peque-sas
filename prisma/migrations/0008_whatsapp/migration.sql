-- CreateTable
CREATE TABLE "WhatsAppConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "accessTokenLast4" TEXT NOT NULL,
    "appSecretEnc" TEXT,
    "verifyTokenEnc" TEXT NOT NULL,
    "verifyTokenHash" TEXT NOT NULL,
    "apiVersion" TEXT,
    "countryCode" TEXT NOT NULL DEFAULT '51',
    "templateLanguage" TEXT NOT NULL DEFAULT 'es',
    "tplPortalCode" TEXT,
    "portalCodeTplKind" TEXT NOT NULL DEFAULT 'UTILITY',
    "tplReservationReminder" TEXT,
    "tplCashAlert" TEXT,
    "ownerAlertPhone" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "displayPhoneNumber" TEXT,
    "verifiedName" TEXT,
    "qualityRating" TEXT,
    "lastTestAt" DATETIME,
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "subscribedAt" DATETIME,
    "updatedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WhatsAppConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WhatsAppConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "contactName" TEXT,
    "lastInboundAt" DATETIME,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsAppConversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "waMessageId" TEXT,
    "direction" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "body" TEXT,
    "templateName" TEXT,
    "mediaId" TEXT,
    "mediaMime" TEXT,
    "errorCode" INTEGER,
    "errorDetail" TEXT,
    "purpose" TEXT,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "sentById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusAt" DATETIME,
    CONSTRAINT "WhatsAppMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WhatsAppMessage_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "WhatsAppConversation" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WhatsAppOrphanStatus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" INTEGER,
    "errorDetail" TEXT,
    "at" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsAppOrphanStatus_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConfig_tenantId_key" ON "WhatsAppConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConfig_phoneNumberId_key" ON "WhatsAppConfig"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConfig_verifyTokenHash_key" ON "WhatsAppConfig"("verifyTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_tenantId_id_key" ON "WhatsAppConversation"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppConversation_tenantId_waId_key" ON "WhatsAppConversation"("tenantId", "waId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_tenantId_conversationId_createdAt_idx" ON "WhatsAppMessage"("tenantId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_tenantId_purpose_relatedType_relatedId_idx" ON "WhatsAppMessage"("tenantId", "purpose", "relatedType", "relatedId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_tenantId_waMessageId_key" ON "WhatsAppMessage"("tenantId", "waMessageId");

-- CreateIndex
CREATE INDEX "WhatsAppOrphanStatus_tenantId_waMessageId_idx" ON "WhatsAppOrphanStatus"("tenantId", "waMessageId");


-- Un solo aviso vigente (no fallido) por recordatorio de reserva / alerta de caja: evita envios duplicados aun con ejecuciones simultaneas
CREATE UNIQUE INDEX "WhatsAppMessage_notice_once_key" ON "WhatsAppMessage"("tenantId", "purpose", "relatedId")
  WHERE "direction" = 'OUT' AND "purpose" IN ('CASH_ALERT', 'RESERVATION_REMINDER') AND "relatedId" IS NOT NULL AND "status" <> 'FAILED';
