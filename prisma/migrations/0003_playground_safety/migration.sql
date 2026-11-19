-- AlterTable
ALTER TABLE "PlaygroundSession" ADD COLUMN "pickupKind" TEXT;
ALTER TABLE "PlaygroundSession" ADD COLUMN "pickupRefId" TEXT;

-- CreateTable
CREATE TABLE "AuthorizedPickup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "dni" TEXT,
    "phone" TEXT,
    "relationship" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthorizedPickup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuthorizedPickup_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuthorizedPickup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlaygroundIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "sessionId" TEXT,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlaygroundIncident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlaygroundIncident_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlaygroundIncident_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AuthorizedPickup_tenantId_childId_idx" ON "AuthorizedPickup"("tenantId", "childId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedPickup_tenantId_id_key" ON "AuthorizedPickup"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PlaygroundIncident_tenantId_childId_createdAt_idx" ON "PlaygroundIncident"("tenantId", "childId", "createdAt");

-- CreateIndex
CREATE INDEX "PlaygroundIncident_tenantId_sessionId_idx" ON "PlaygroundIncident"("tenantId", "sessionId");

