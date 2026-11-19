-- CreateTable
CREATE TABLE "ParentAccessCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParentAccessCode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ParentAccessCode_tenantId_guardianId_fkey" FOREIGN KEY ("tenantId", "guardianId") REFERENCES "Guardian" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ParentAuthEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Columnas con ALTER (evita recrear Tenant y Guardian, que tienen muchas claves foráneas apuntándolas)
ALTER TABLE "Tenant" ADD COLUMN "portalCode" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "portalEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Tenant_portalCode_key" ON "Tenant"("portalCode");
ALTER TABLE "Guardian" ADD COLUMN "phoneDigits" TEXT;
ALTER TABLE "Guardian" ADD COLUMN "portalSessionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Guardian" ADD COLUMN "portalBlocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Guardian" ADD COLUMN "portalLastLoginAt" DATETIME;
-- Relleno para apoderados existentes: últimos 9 dígitos del teléfono
UPDATE "Guardian" SET "phoneDigits" = substr(replace(replace(replace(replace(replace("phone", ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), -9) WHERE "phone" IS NOT NULL;
CREATE INDEX "Guardian_tenantId_phoneDigits_idx" ON "Guardian"("tenantId", "phoneDigits");
CREATE INDEX "Guardian_tenantId_dni_idx" ON "Guardian"("tenantId", "dni");

-- CreateIndex
CREATE INDEX "ParentAccessCode_tenantId_guardianId_createdAt_idx" ON "ParentAccessCode"("tenantId", "guardianId", "createdAt");

-- CreateIndex
CREATE INDEX "ParentAuthEvent_key_createdAt_idx" ON "ParentAuthEvent"("key", "createdAt");

