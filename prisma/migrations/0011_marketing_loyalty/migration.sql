-- CreateTable
CREATE TABLE "LoyaltyConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pointsPerSol" INTEGER NOT NULL DEFAULT 1,
    "expiryDays" INTEGER NOT NULL DEFAULT 365,
    "centsPerPoint" INTEGER NOT NULL DEFAULT 10,
    "maxRedeemPercent" INTEGER NOT NULL DEFAULT 50,
    "updatedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LoyaltyConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LoyaltyConfig_check" CHECK ("pointsPerSol" BETWEEN 0 AND 1000 AND "expiryDays" BETWEEN 0 AND 3650 AND "centsPerPoint" BETWEEN 1 AND 10000 AND "maxRedeemPercent" BETWEEN 1 AND 100)
);

-- CreateTable
CREATE TABLE "LoyaltyLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "saleId" TEXT,
    "expiresAt" DATETIME,
    "lotId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoyaltyLedger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LoyaltyLedger_tenantId_guardianId_fkey" FOREIGN KEY ("tenantId", "guardianId") REFERENCES "Guardian" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "validFrom" DATETIME,
    "validUntil" DATETIME,
    "maxUses" INTEGER,
    "usesCount" INTEGER NOT NULL DEFAULT 0,
    "maxUsesPerGuardian" INTEGER,
    "minPurchaseCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Coupon_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Coupon_check" CHECK (("type" = 'PERCENTAGE' AND "value" BETWEEN 1 AND 100 OR "type" = 'FIXED_CENTS' AND "value" > 0) AND "usesCount" >= 0 AND "minPurchaseCents" >= 0 AND ("maxUses" IS NULL OR "maxUses" > 0 AND "usesCount" <= "maxUses") AND ("maxUsesPerGuardian" IS NULL OR "maxUsesPerGuardian" > 0))
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "guardianId" TEXT,
    "discountCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponRedemption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CouponRedemption_tenantId_couponId_fkey" FOREIGN KEY ("tenantId", "couponId") REFERENCES "Coupon" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConsentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT,
    "recordedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ConsentEvent_tenantId_guardianId_fkey" FOREIGN KEY ("tenantId", "guardianId") REFERENCES "Guardian" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "couponCode" TEXT,
    "inactiveDays" INTEGER NOT NULL DEFAULT 30,
    "prepaidMinutesBelow" INTEGER NOT NULL DEFAULT 60,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    CONSTRAINT "Campaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "childFirstName" TEXT,
    "extraValue" TEXT,
    "messageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignRecipient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CampaignRecipient_tenantId_campaignId_fkey" FOREIGN KEY ("tenantId", "campaignId") REFERENCES "Campaign" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CampaignRecipient_tenantId_guardianId_fkey" FOREIGN KEY ("tenantId", "guardianId") REFERENCES "Guardian" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Columnas con ALTER (evita recrear Guardian y Sale, de las que dependen muchas tablas). Los CHECK impiden saldos o importes negativos.
ALTER TABLE "Guardian" ADD COLUMN "loyaltyPoints" INTEGER NOT NULL DEFAULT 0 CHECK ("loyaltyPoints" >= 0);
ALTER TABLE "Guardian" ADD COLUMN "marketingConsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Guardian" ADD COLUMN "marketingConsentAt" DATETIME;
ALTER TABLE "Guardian" ADD COLUMN "marketingConsentSource" TEXT;
ALTER TABLE "Guardian" ADD COLUMN "marketingConsentById" TEXT;
ALTER TABLE "Guardian" ADD COLUMN "marketingRevokedAt" DATETIME;
ALTER TABLE "Sale" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0 CHECK ("discountCents" >= 0);
ALTER TABLE "Sale" ADD COLUMN "couponId" TEXT;
ALTER TABLE "Sale" ADD COLUMN "pointsRedeemed" INTEGER NOT NULL DEFAULT 0 CHECK ("pointsRedeemed" >= 0);
ALTER TABLE "Sale" ADD COLUMN "pointsEarned" INTEGER NOT NULL DEFAULT 0 CHECK ("pointsEarned" >= 0);
ALTER TABLE "Sale" ADD COLUMN "loyaltyGuardianId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyConfig_tenantId_key" ON "LoyaltyConfig"("tenantId");

-- CreateIndex
CREATE INDEX "LoyaltyLedger_tenantId_guardianId_createdAt_idx" ON "LoyaltyLedger"("tenantId", "guardianId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyLedger_tenantId_saleId_type_key" ON "LoyaltyLedger"("tenantId", "saleId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyLedger_tenantId_lotId_type_key" ON "LoyaltyLedger"("tenantId", "lotId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_tenantId_code_key" ON "Coupon"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_tenantId_id_key" ON "Coupon"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CouponRedemption_tenantId_couponId_guardianId_idx" ON "CouponRedemption"("tenantId", "couponId", "guardianId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_tenantId_saleId_key" ON "CouponRedemption"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "ConsentEvent_tenantId_guardianId_createdAt_idx" ON "ConsentEvent"("tenantId", "guardianId", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_tenantId_status_idx" ON "Campaign"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_tenantId_id_key" ON "Campaign"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CampaignRecipient_tenantId_guardianId_createdAt_idx" ON "CampaignRecipient"("tenantId", "guardianId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_tenantId_campaignId_guardianId_key" ON "CampaignRecipient"("tenantId", "campaignId", "guardianId");



-- El libro de puntos es inmutable: no se permite UPDATE; el saldo posterior nunca es negativo
CREATE TRIGGER "LoyaltyLedger_no_update" BEFORE UPDATE ON "LoyaltyLedger"
BEGIN SELECT RAISE(ABORT, 'LoyaltyLedger es inmutable'); END;
CREATE TRIGGER "LoyaltyLedger_balance_check" BEFORE INSERT ON "LoyaltyLedger" WHEN NEW."balanceAfter" < 0
BEGIN SELECT RAISE(ABORT, 'saldo de puntos negativo'); END;
-- La prueba del consentimiento (Ley 29733) tampoco se modifica
CREATE TRIGGER "ConsentEvent_no_update" BEFORE UPDATE ON "ConsentEvent"
BEGIN SELECT RAISE(ABORT, 'ConsentEvent es inmutable'); END;
