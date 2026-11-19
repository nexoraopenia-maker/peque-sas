-- AlterTable
ALTER TABLE "Sale" ADD COLUMN "reservationId" TEXT;

-- CreateTable
CREATE TABLE "ReservationSpace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReservationSpace_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "childId" TEXT,
    "spaceId" TEXT,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "attendees" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "packageName" TEXT,
    "details" TEXT,
    "notes" TEXT,
    "totalAmountCents" INTEGER NOT NULL,
    "advanceRequiredCents" INTEGER NOT NULL DEFAULT 0,
    "advancePaidCents" INTEGER NOT NULL DEFAULT 0,
    "advanceCashSessionId" TEXT,
    "reminderSentAt" DATETIME,
    "reminderSentById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Reservation_integrity_check" CHECK (
      "startTime" < "endTime" AND "attendees" > 0 AND "totalAmountCents" >= 0 AND "advanceRequiredCents" >= 0
      AND "advanceRequiredCents" <= "totalAmountCents" AND "advancePaidCents" >= 0 AND "advancePaidCents" <= "totalAmountCents"
      AND "startTime" GLOB '[0-2][0-9]:[0-5][0-9]' AND "endTime" GLOB '[0-2][0-9]:[0-5][0-9]'
      AND "date" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
    )
);

-- CreateTable
CREATE TABLE "ScheduleBlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "spaceId" TEXT,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduleBlock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ScheduleBlock_time_check" CHECK ("startTime" < "endTime")
);

-- CreateTable
CREATE TABLE "ReservationChecklistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReservationChecklistItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReservationChecklistItem_tenantId_reservationId_fkey" FOREIGN KEY ("tenantId", "reservationId") REFERENCES "Reservation" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Columna con ALTER (evita recrear la tabla Tenant)
ALTER TABLE "Tenant" ADD COLUMN "daycareCapacity" INTEGER NOT NULL DEFAULT 20;

-- CreateIndex
CREATE INDEX "ReservationSpace_tenantId_idx" ON "ReservationSpace"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationSpace_tenantId_id_key" ON "ReservationSpace"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Reservation_tenantId_date_idx" ON "Reservation"("tenantId", "date");

-- CreateIndex
CREATE INDEX "Reservation_tenantId_status_idx" ON "Reservation"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_tenantId_id_key" ON "Reservation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ScheduleBlock_tenantId_date_idx" ON "ScheduleBlock"("tenantId", "date");

-- CreateIndex
CREATE INDEX "ReservationChecklistItem_tenantId_reservationId_idx" ON "ReservationChecklistItem"("tenantId", "reservationId");



-- Índice para consultas de solapamiento por fecha/servicio/estado
CREATE INDEX "Reservation_overlap_idx" ON "Reservation"("tenantId", "date", "serviceType", "status");
CREATE INDEX "Reservation_space_idx" ON "Reservation"("tenantId", "spaceId", "date");
