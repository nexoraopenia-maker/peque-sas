import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/lib/generated/prisma/client";

export type CheckInInput = {
  tenantId: string; childId: string; rateId: string; braceletCode: string; userId: string;
  contractedMinutes: number; basePriceCents: number; extraMinuteCents: number;
};

/**
 * Inserta la sesión SOLO si el aforo no está completo, en UNA sola sentencia SQL.
 * El conteo y el INSERT son atómicos (SQLite serializa las escrituras), por lo que
 * ingresos simultáneos no pueden superar `Tenant.playgroundCapacity`.
 * Devuelve el id creado o null si el aforo está completo. Los índices únicos parciales
 * lanzan error si el menor o la pulsera ya tienen una sesión abierta.
 */
export async function insertSessionIfCapacity(db: PrismaClient, i: CheckInInput): Promise<string | null> {
  const id = randomUUID();
  const affected = await db.$executeRaw`
    INSERT INTO "PlaygroundSession"
      ("id","tenantId","childId","rateId","braceletCode","status","checkInAt","contractedMinutes","basePriceCents","extraMinuteCents","checkedInById")
    SELECT ${id}, ${i.tenantId}, ${i.childId}, ${i.rateId}, ${i.braceletCode}, 'OPEN', ${new Date().toISOString()},
           ${i.contractedMinutes}, ${i.basePriceCents}, ${i.extraMinuteCents}, ${i.userId}
    WHERE (SELECT COUNT(*) FROM "PlaygroundSession" WHERE "tenantId" = ${i.tenantId} AND "status" = 'OPEN')
          < (SELECT "playgroundCapacity" FROM "Tenant" WHERE "id" = ${i.tenantId})`;
  return affected === 1 ? id : null;
}
