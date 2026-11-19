import "server-only";
import { db } from "@/lib/db";

/** Registra operaciones sensibles. No incluir datos personales de menores en metadata. */
export async function audit(p: {
  tenantId: string | null;
  actorId: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  await db.auditLog.create({ data: p });
}
