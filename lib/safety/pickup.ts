import "server-only";
import { tenantDb } from "@/lib/db/tenant";

export type PickupChoice = { kind: "GUARDIAN" | "AUTHORIZED"; id: string };

/** Formato del valor del <select>: "G:<id>" (apoderado) o "A:<id>" (persona autorizada). */
export function parsePickup(value: string): PickupChoice | null {
  const m = /^([GA]):([\w-]{1,64})$/.exec(value);
  return m ? { kind: m[1] === "G" ? "GUARDIAN" : "AUTHORIZED", id: m[2]! } : null;
}

/**
 * Valida contra la lista blanca del menor: apoderado vinculado con canPickup o persona
 * autorizada activa, siempre dentro del tenant. Devuelve el nombre o null si no es válido.
 */
export async function resolvePickupName(tenantId: string, childId: string, c: PickupChoice): Promise<string | null> {
  const tdb = tenantDb(tenantId);
  if (c.kind === "GUARDIAN") {
    const link = await tdb.childGuardian.findFirst({ where: { childId, guardianId: c.id, canPickup: true }, include: { guardian: true } });
    return link?.guardian.fullName ?? null;
  }
  const a = await tdb.authorizedPickup.findFirst({ where: { id: c.id, childId, isActive: true } });
  return a?.fullName ?? null;
}
