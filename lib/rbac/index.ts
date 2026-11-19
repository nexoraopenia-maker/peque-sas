import "server-only";
import { cache } from "react";
import { forbidden, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { readSession } from "@/lib/auth/session";
import { tenantHasModule, type ModuleKey } from "@/lib/plans/modules";
import { featureEnabled, type Feature } from "@/lib/plans/pure";
import { hasPermission, type Permission, type Role } from "./permissions";

export class ForbiddenError extends Error {
  constructor(msg = "No autorizado") { super(msg); }
}

/**
 * Usuario autenticado; valida usuario activo, sessionVersion y tenant activo.
 * `allowBilling`: un establecimiento suspendido POR IMPAGO (suspensionSource = BILLING) sigue siendo visible para su propietario,
 * pero solo la pantalla /billing lo pide así; todo lo demás recibe null (acceso bloqueado hasta pagar).
 */
const load = cache(async (allowBilling: boolean) => {
  const s = await readSession();
  if (!s) return null;
  const user = await db.user.findUnique({ where: { id: s.uid }, include: { tenant: { include: { plan: true } } } });
  if (!user || !user.isActive || user.sessionVersion !== s.sv) return null;
  if (user.role !== "SUPERADMIN" && user.tenant?.status === "SUSPENDED" && !(allowBilling && user.tenant.suspensionSource === "BILLING")) return null;
  // Demo vencida: se bloquea el acceso (los datos se conservan)
  if (user.role !== "SUPERADMIN" && user.tenant?.status === "DEMO" && user.tenant.demoExpiresAt && user.tenant.demoExpiresAt < new Date()) return null;
  return user;
});

export const getCurrentUser = () => load(false);
export const getBillingUser = () => load(true);
export const isBillingLocked = (u: { role: Role; tenant: { status: string; suspensionSource: string | null } | null }) => u.role !== "SUPERADMIN" && u.tenant?.status === "SUSPENDED" && u.tenant.suspensionSource === "BILLING";

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    // Suspendido por impago: el propietario va a pagar; cualquier otro caso, a iniciar sesión
    const b = await getBillingUser();
    if (b && b.role === "OWNER" && isBillingLocked(b)) redirect("/billing");
    redirect("/login");
  }
  return user;
}

/** Pantalla /billing: permite al PROPIETARIO entrar aunque el acceso esté bloqueado por impago. */
export async function requireBillingUser() {
  const user = await getBillingUser();
  if (!user) redirect("/login");
  if (user.role !== "OWNER" || !user.tenantId) forbidden();
  if (user.mustChangePassword) redirect("/change-password");
  return { user, tenantId: user.tenantId, locked: isBillingLocked(user) };
}

/** La función debe estar incluida en el plan del establecimiento (comprobación en servidor). */
export async function requireFeature(f: Feature) {
  const user = await requireUser();
  if (user.role === "SUPERADMIN" || !user.tenant || !featureEnabled(user.tenant, f)) forbidden();
  return user;
}

/** El tenantId siempre sale de la sesión, nunca del navegador. */
export async function getCurrentTenant() {
  const user = await requireUser();
  if (!user.tenantId || !user.tenant) throw new ForbiddenError("Sin establecimiento");
  return user.tenant;
}

export async function requireRole(...roles: Role[]) {
  const user = await requireUser();
  if (!roles.includes(user.role)) forbidden();
  return user;
}

export async function requirePermission(perm: Permission) {
  const user = await requireUser();
  if (user.role === "SUPERADMIN" || !user.tenantId || !hasPermission(user.role, perm)) forbidden();
  return { user, tenantId: user.tenantId };
}

/** Verifica que un recurso pertenezca al tenant de la sesión. */
export async function requireTenantAccess(resourceTenantId: string | null | undefined) {
  const user = await requireUser();
  if (!user.tenantId || user.tenantId !== resourceTenantId) forbidden();
  return user;
}

/**
 * Contexto administrativo global. Triple verificación en servidor, por cada página/acción/ruta:
 *  1) rol SUPERADMIN y sin establecimiento (además lo garantizan triggers en la base de datos),
 *  2) la sesión lleva la marca `sa` (solo se emite a un SUPERADMIN al iniciar sesión),
 *  3) contraseña temporal ya cambiada.
 * Cualquier otro usuario (incluido el OWNER de un establecimiento) recibe 403.
 */
export async function requireSuperAdmin() {
  const user = await requireUser();
  const s = await readSession();
  if (user.role !== "SUPERADMIN" || user.tenantId !== null || !s?.sa) forbidden();
  if (user.mustChangePassword) redirect("/change-password");
  return user;
}

/** El módulo debe estar contratado por el establecimiento (comprobación en servidor). */
export async function requireModule(key: ModuleKey) {
  const user = await requireUser();
  if (user.role === "SUPERADMIN" || !tenantHasModule(user.tenant?.modules, key)) forbidden();
  return user;
}
