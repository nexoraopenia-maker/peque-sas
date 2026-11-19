-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "schoolYear" INTEGER NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "entryTime" TEXT NOT NULL DEFAULT '08:00',
    "exitTime" TEXT NOT NULL DEFAULT '17:00',
    "monthlyFeeCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Enrollment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Enrollment_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DaycareAttendance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "checkInAt" DATETIME,
    "checkOutAt" DATETIME,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "pickedUpBy" TEXT,
    "pickupKind" TEXT,
    "pickupRefId" TEXT,
    "notes" TEXT,
    "checkedInById" TEXT,
    "checkedOutById" TEXT,
    CONSTRAINT "DaycareAttendance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DaycareAttendance_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DaycareAttendance_tenantId_enrollmentId_fkey" FOREIGN KEY ("tenantId", "enrollmentId") REFERENCES "Enrollment" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DaycareLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subtype" TEXT,
    "level" TEXT,
    "notes" TEXT,
    "visibleToParents" BOOLEAN NOT NULL DEFAULT true,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "recordedById" TEXT NOT NULL,
    CONSTRAINT "DaycareLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DaycareLog_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DaycareIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parentNotified" BOOLEAN NOT NULL DEFAULT false,
    "reportedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DaycareIncident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DaycareIncident_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DaycareNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "logId" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DaycareNotification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DaycareNotification_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DaycareProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "bloodType" TEXT,
    "pediatrician" TEXT,
    "pediatricianPhone" TEXT,
    "insurance" TEXT,
    "medications" TEXT,
    "dietaryNotes" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "photoConsent" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DaycareProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DaycareProfile_tenantId_childId_fkey" FOREIGN KEY ("tenantId", "childId") REFERENCES "Child" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Enrollment_tenantId_status_idx" ON "Enrollment"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_tenantId_id_key" ON "Enrollment"("tenantId", "id");

-- CreateIndex
CREATE INDEX "DaycareAttendance_tenantId_date_idx" ON "DaycareAttendance"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DaycareAttendance_tenantId_childId_date_key" ON "DaycareAttendance"("tenantId", "childId", "date");

-- CreateIndex
CREATE INDEX "DaycareLog_tenantId_childId_date_idx" ON "DaycareLog"("tenantId", "childId", "date");

-- CreateIndex
CREATE INDEX "DaycareLog_tenantId_date_idx" ON "DaycareLog"("tenantId", "date");

-- CreateIndex
CREATE INDEX "DaycareIncident_tenantId_childId_date_idx" ON "DaycareIncident"("tenantId", "childId", "date");

-- CreateIndex
CREATE INDEX "DaycareNotification_tenantId_childId_createdAt_idx" ON "DaycareNotification"("tenantId", "childId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DaycareProfile_tenantId_childId_key" ON "DaycareProfile"("tenantId", "childId");


-- Una sola matrícula activa por menor
CREATE UNIQUE INDEX "Enrollment_active_child_key" ON "Enrollment"("tenantId", "childId") WHERE "status" = 'ACTIVE';
-- Una sola siesta abierta por menor
CREATE UNIQUE INDEX "DaycareLog_open_nap_key" ON "DaycareLog"("tenantId", "childId") WHERE "kind" = 'NAP' AND "endedAt" IS NULL;
