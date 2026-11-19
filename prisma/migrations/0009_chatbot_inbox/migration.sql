-- AlterTable
ALTER TABLE "WhatsAppMessage" ADD COLUMN "authorKind" TEXT;
ALTER TABLE "WhatsAppMessage" ADD COLUMN "mediaFilename" TEXT;

-- CreateTable
CREATE TABLE "BotConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "personality" TEXT NOT NULL DEFAULT 'Amable, cercano y breve',
    "instructions" TEXT,
    "welcomeMessage" TEXT,
    "outOfHoursMessage" TEXT,
    "handoffMessage" TEXT NOT NULL DEFAULT 'Te comunico con una persona del equipo para ayudarte mejor. En unos minutos te responden.',
    "policies" TEXT,
    "hours" JSONB NOT NULL DEFAULT [],
    "answerOutsideHours" BOOLEAN NOT NULL DEFAULT false,
    "maxRepliesPerHour" INTEGER NOT NULL DEFAULT 20,
    "updatedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BotConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotFaq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotFaq_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotService" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotService_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT,
    "month" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConversationNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ConversationNote_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "WhatsAppConversation" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Columnas con ALTER (evita recrear Plan y WhatsAppConversation, que tienen tablas dependientes)
ALTER TABLE "Plan" ADD COLUMN "botMonthlyReplies" INTEGER NOT NULL DEFAULT 300 CHECK ("botMonthlyReplies" >= 0);
ALTER TABLE "WhatsAppConversation" ADD COLUMN "botEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE "WhatsAppConversation" ADD COLUMN "assignedToId" TEXT;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "needsHuman" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "handoffReason" TEXT;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "handoffAt" DATETIME;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "botCursorAt" DATETIME;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "botLockedUntil" DATETIME;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "lastBotReplyAt" DATETIME;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "welcomedAt" DATETIME;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "lastOutOfHoursAt" DATETIME;
ALTER TABLE "WhatsAppConversation" ADD COLUMN "staffSeenAt" DATETIME;
CREATE INDEX "WhatsAppConversation_inbox_idx" ON "WhatsAppConversation"("tenantId", "status", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "BotConfig_tenantId_key" ON "BotConfig"("tenantId");

-- CreateIndex
CREATE INDEX "BotFaq_tenantId_isActive_idx" ON "BotFaq"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "BotService_tenantId_isActive_idx" ON "BotService"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "BotUsage_tenantId_month_idx" ON "BotUsage"("tenantId", "month");

-- CreateIndex
CREATE INDEX "ConversationNote_tenantId_conversationId_createdAt_idx" ON "ConversationNote"("tenantId", "conversationId", "createdAt");

