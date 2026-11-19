import "server-only";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { retryBusy } from "@/lib/billing/service";
import {
  CODE_TTL_MS, FAIL_WINDOW_MS, MAX_CODE_ATTEMPTS, MAX_FAILS_PER_IDENTIFIER, MAX_FAILS_PER_PORTAL, generateAccessCode, hashAccessCode,
  normalizeCode, normalizeIdentifier, normalizePortalCode, rateKeys, safeEqualHex,
} from "./identity";
import { readGuardianToken, verifyGuardianToken, type GuardianToken } from "./session";

export class PortalError extends Error {}
export const GENERIC_LOGIN_ERROR = "Los datos o el código no son correctos, o el código venció. Pide uno nuevo en recepción.";

/** Staff: genera un código de un solo uso para un apoderado. Se muestra UNA vez; solo se guarda su HMAC. */
export async function issueAccessCode(i: { tenantId: string; guardianId: string; createdById: string }) {
  const tenant = await db.tenant.findUnique({ where: { id: i.tenantId }, select: { portalEnabled: true, portalCode: true } });
  if (!tenant?.portalEnabled || !tenant.portalCode) throw new PortalError("El portal de padres no está habilitado para este establecimiento");
  const g = await db.guardian.findFirst({ where: { id: i.guardianId, tenantId: i.tenantId } });
  if (!g) throw new PortalError("Apoderado no encontrado");
  if (g.portalBlocked) throw new PortalError("El acceso de este apoderado está bloqueado");
  if (!g.dni && !g.phoneDigits) throw new PortalError("Registra el DNI o el teléfono del apoderado para habilitar su acceso");
  const hasChild = await db.childGuardian.count({ where: { tenantId: i.tenantId, guardianId: g.id } });
  if (!hasChild) throw new PortalError("El apoderado no está vinculado a ningún menor");

  const id = randomUUID();
  const code = generateAccessCode();
  const now = new Date();
  await retryBusy(() => db.$transaction(async (tx) => {
    // Un solo código vigente por apoderado: los anteriores sin usar vencen ahora
    await tx.parentAccessCode.updateMany({ where: { tenantId: i.tenantId, guardianId: g.id, usedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
    await tx.parentAccessCode.create({ data: { id, tenantId: i.tenantId, guardianId: g.id, codeHash: hashAccessCode(id, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS), createdById: i.createdById } });
  }));
  return { code, guardianName: g.fullName, expiresAt: new Date(now.getTime() + CODE_TTL_MS), portalCode: tenant.portalCode };
}

async function recordFailure(keys: string[]) {
  await db.parentAuthEvent.createMany({ data: keys.map((key) => ({ key })) });
  // limpieza oportunista de eventos viejos
  await db.parentAuthEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } } });
}

export type LoginResult = { ok: true; token: GuardianToken } | { ok: false; error: string };

/**
 * Valida portal + DNI/teléfono + código. Todas las fallas devuelven el MISMO mensaje (no revela si el establecimiento,
 * el apoderado o el código existen). Los intentos se limitan por (portal+identificador) y por portal.
 */
export async function loginWithCode(i: { portalCode: string; identifier: string; code: string }): Promise<LoginResult> {
  const fail = (error = GENERIC_LOGIN_ERROR): LoginResult => ({ ok: false, error });
  const portalCode = normalizePortalCode(i.portalCode);
  const id = normalizeIdentifier(i.identifier);
  const code = normalizeCode(i.code);
  const keys = rateKeys(portalCode, id ? id.value : i.identifier.trim().slice(0, 40));
  const since = new Date(Date.now() - FAIL_WINDOW_MS);
  const [fi, fp] = await Promise.all([
    db.parentAuthEvent.count({ where: { key: keys.perIdentifier, createdAt: { gte: since } } }),
    db.parentAuthEvent.count({ where: { key: keys.perPortal, createdAt: { gte: since } } }),
  ]);
  if (fi >= MAX_FAILS_PER_IDENTIFIER || fp >= MAX_FAILS_PER_PORTAL) return fail("Demasiados intentos. Espera unos minutos e inténtalo de nuevo.");
  const bad = async () => { await recordFailure([keys.perIdentifier, keys.perPortal]); return fail(); };

  if (!id || code.length !== 8 || portalCode.length < 6) return bad();
  const tenant = await db.tenant.findUnique({ where: { portalCode } });
  if (!tenant || !tenant.portalEnabled || tenant.status === "SUSPENDED") return bad();

  const guardians = await db.guardian.findMany({
    where: { tenantId: tenant.id, portalBlocked: false, ...(id.kind === "dni" ? { dni: id.value } : { phoneDigits: id.value }) },
    select: { id: true, portalSessionVersion: true },
  });
  if (!guardians.length) return bad();
  const now = new Date();
  const codes = await db.parentAccessCode.findMany({
    where: { tenantId: tenant.id, guardianId: { in: guardians.map((g) => g.id) }, usedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_CODE_ATTEMPTS } },
  });
  const match = codes.find((c) => safeEqualHex(hashAccessCode(c.id, code), c.codeHash));
  if (!match) {
    if (codes.length) await db.parentAccessCode.updateMany({ where: { id: { in: codes.map((c) => c.id) } }, data: { attempts: { increment: 1 } } });
    return bad();
  }
  // Uso único: el UPDATE condicionado impide que dos logins simultáneos usen el mismo código
  const claim = await retryBusy(() => db.parentAccessCode.updateMany({
    where: { id: match.id, usedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_CODE_ATTEMPTS } }, data: { usedAt: now },
  }));
  if (claim.count !== 1) return bad();
  const g = guardians.find((x) => x.id === match.guardianId)!;
  await db.guardian.updateMany({ where: { id: g.id, tenantId: tenant.id }, data: { portalLastLoginAt: now } });
  return { ok: true, token: { gid: g.id, tid: tenant.id, sv: g.portalSessionVersion } };
}

/** Carga el apoderado de un token verificando que siga vigente (no bloqueado, mismo tenant, versión de sesión y portal activo). */
export async function loadGuardian(t: GuardianToken) {
  const g = await db.guardian.findFirst({ where: { id: t.gid, tenantId: t.tid }, include: { tenant: true } });
  if (!g || g.portalBlocked || g.portalSessionVersion !== t.sv) return null;
  if (!g.tenant.portalEnabled || g.tenant.status === "SUSPENDED") return null;
  return g;
}

export const getCurrentGuardian = cache(async () => {
  const token = await readGuardianToken();
  const payload = token ? await verifyGuardianToken(token) : null;
  return payload ? loadGuardian(payload) : null;
});

export async function requireGuardian() {
  const g = await getCurrentGuardian();
  if (!g) redirect("/parent-portal/login");
  return g;
}

/** Staff: cierra todas las sesiones del apoderado y anula sus códigos pendientes. */
export async function revokeGuardianAccess(tenantId: string, guardianId: string) {
  const now = new Date();
  const r = await db.guardian.updateMany({ where: { id: guardianId, tenantId }, data: { portalSessionVersion: { increment: 1 } } });
  if (r.count !== 1) throw new PortalError("Apoderado no encontrado");
  await db.parentAccessCode.updateMany({ where: { tenantId, guardianId, usedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
}
