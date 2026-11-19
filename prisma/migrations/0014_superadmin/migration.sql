-- Fase 16: SuperAdmin y gestión de establecimientos
ALTER TABLE "Tenant" ADD COLUMN "suspendedAt" DATETIME;
ALTER TABLE "Tenant" ADD COLUMN "suspendedReason" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "provisionedById" TEXT;

-- El SuperAdmin es global (sin establecimiento) y ningún otro rol puede carecer de él
CREATE TRIGGER "User_superadmin_scope_insert" BEFORE INSERT ON "User" WHEN (NEW."role" = 'SUPERADMIN') <> (NEW."tenantId" IS NULL)
BEGIN SELECT RAISE(ABORT, 'SUPERADMIN no pertenece a un establecimiento y el resto de roles si'); END;

CREATE TRIGGER "User_superadmin_scope_update" BEFORE UPDATE OF "role", "tenantId" ON "User" WHEN (NEW."role" = 'SUPERADMIN') <> (NEW."tenantId" IS NULL)
BEGIN SELECT RAISE(ABORT, 'SUPERADMIN no pertenece a un establecimiento y el resto de roles si'); END;

-- Anti escalada de privilegios: el rol SUPERADMIN solo se crea con INSERT (script de administración); nadie puede ascender ni degradar con UPDATE
CREATE TRIGGER "User_superadmin_role_immutable" BEFORE UPDATE OF "role" ON "User" WHEN NEW."role" <> OLD."role" AND (OLD."role" = 'SUPERADMIN' OR NEW."role" = 'SUPERADMIN')
BEGIN SELECT RAISE(ABORT, 'El rol SUPERADMIN no se puede asignar ni quitar'); END;

-- Suspensión coherente: status SUSPENDED si y solo si hay fecha de suspensión
CREATE TRIGGER "Tenant_suspension_insert" BEFORE INSERT ON "Tenant" WHEN (NEW."status" = 'SUSPENDED') <> (NEW."suspendedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Suspension inconsistente'); END;

CREATE TRIGGER "Tenant_suspension_update" BEFORE UPDATE OF "status", "suspendedAt" ON "Tenant" WHEN (NEW."status" = 'SUSPENDED') <> (NEW."suspendedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Suspension inconsistente'); END;

CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
