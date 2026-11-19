-- CreateTable
CREATE TABLE "PlaygroundRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "extraMinuteCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlaygroundRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlaygroundSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "rateId" TEXT NOT NULL,
    "braceletCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "checkInAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkOutAt" DATETIME,
    "contractedMinutes" INTEGER NOT NULL,
    "basePriceCents" INTEGER NOT NULL,
    "extraMinuteCents" INTEGER NOT NULL,
    "amountCents" INTEGER,
    "pickedUpBy" TEXT,
    "notes" TEXT,
    "checkedInById" TEXT NOT NULL,
    "checkedOutById" TEXT,
    CONSTRAINT "PlaygroundSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlaygroundSession_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlaygroundSession_tenantId_rateId_fkey" FOREIGN KEY ("tenantId", "rateId") REFERENCES "PlaygroundRate" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlaygroundSession_checkedInById_fkey" FOREIGN KEY ("checkedInById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlaygroundSession_checkedOutById_fkey" FOREIGN KEY ("checkedOutById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Columna añadida con ALTER (evita redefinir la tabla Tenant)
ALTER TABLE "Tenant" ADD COLUMN "playgroundCapacity" INTEGER NOT NULL DEFAULT 30;

-- CreateIndex
CREATE INDEX "PlaygroundRate_tenantId_idx" ON "PlaygroundRate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaygroundRate_tenantId_id_key" ON "PlaygroundRate"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PlaygroundSession_tenantId_status_idx" ON "PlaygroundSession"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PlaygroundSession_tenantId_checkInAt_idx" ON "PlaygroundSession"("tenantId", "checkInAt");


-- Un menor / una pulsera solo puede tener una sesión abierta (previene doble ingreso aun con concurrencia)
CREATE UNIQUE INDEX "PlaygroundSession_open_child_key" ON "PlaygroundSession"("tenantId", "childId") WHERE "status" = 'OPEN';
CREATE UNIQUE INDEX "PlaygroundSession_open_bracelet_key" ON "PlaygroundSession"("tenantId", "braceletCode") WHERE "status" = 'OPEN';
