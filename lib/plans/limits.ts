import "server-only";
import { db } from "@/lib/db";
import { BillingError } from "@/lib/billing/errors";
import { retryBusy, type Tx } from "@/lib/billing/service";
import { limaDate } from "@/lib/utils/date";
import { featureEnabled, featureMessage, userLimitMessage, type Feature } from "./pure";

/**
 * Límites y funciones por plan. TODO se decide en el servidor con el plan vigente del establecimiento (nunca con datos del navegador).
 * Un tope rebasado devuelve un error controlado (BillingError con mensaje claro) que las pantallas muestran tal cual.
 */
const TX = { maxWait: 10_000, timeout: 30_000 } as const;
export class PlanLimitError extends BillingError {}

async function loadTenant(tenantId: string) {
  const t = await db.tenant.findFirst({ where: { id: tenantId }, include: { plan: true } });
  if (!t) throw new PlanLimitError("Establecimiento no encontrado");
  return t;
}

export async function assertFeature(tenantId: string, f: Feature) {
  const t = await loadTenant(tenantId);
  if (!featureEnabled(t, f)) throw new PlanLimitError(featureMessage(f));
}
export async function hasFeature(tenantId: string, f: Feature): Promise<boolean> {
  const t = await db.tenant.findFirst({ where: { id: tenantId }, include: { plan: true } });
  return !!t && featureEnabled(t, f);
}

/** Alta de usuario dentro del tope: contar y crear en UNA transacción (SQLite serializa los escritores: dos altas simultáneas no superan el límite). */
export async function createUserWithinLimit(tenantId: string, data: { name: string; email: string; role: "ADMIN" | "RECEPTION" | "TEACHER"; passwordHash: string }) {
  return retryBusy(() => db.$transaction(async (tx: Tx) => {
    const t = await tx.tenant.findFirst({ where: { id: tenantId }, include: { plan: true } });
    if (!t) throw new PlanLimitError("Establecimiento no encontrado");
    const active = await tx.user.count({ where: { tenantId, isActive: true } });
    if (active >= t.plan.maxUsers) throw new PlanLimitError(userLimitMessage(t.plan.maxUsers));
    if (await tx.user.findFirst({ where: { email: data.email }, select: { id: true } })) throw new PlanLimitError("Ese correo ya está registrado");
    return tx.user.create({ data: { ...data, tenantId, mustChangePassword: true } });
  }, TX));
}

/** Reactivar un usuario también cuenta contra el tope. Desactivar siempre se permite. */
export async function setUserActiveWithinLimit(tenantId: string, userId: string, active: boolean): Promise<boolean> {
  return retryBusy(() => db.$transaction(async (tx: Tx) => {
    if (active) {
      const t = await tx.tenant.findFirst({ where: { id: tenantId }, include: { plan: true } });
      if (!t) throw new PlanLimitError("Establecimiento no encontrado");
      const target = await tx.user.findFirst({ where: { id: userId, tenantId }, select: { isActive: true } });
      if (target && !target.isActive && (await tx.user.count({ where: { tenantId, isActive: true } })) >= t.plan.maxUsers) throw new PlanLimitError(userLimitMessage(t.plan.maxUsers));
    }
    // updateMany con tenantId: no puede afectar usuarios de otro establecimiento ni al OWNER
    const r = await tx.user.updateMany({ where: { id: userId, tenantId, role: { not: "OWNER" } }, data: { isActive: active, sessionVersion: { increment: 1 } } });
    return r.count > 0;
  }, TX));
}

export async function storageUsedBytes(tenantId: string): Promise<number> {
  const r = await db.$queryRaw<{ bytes: bigint | number | null }[]>`SELECT COALESCE(SUM(COALESCE(LENGTH("pdf"),0) + COALESCE(LENGTH("xml"),0)),0) AS bytes FROM "SunatDocument" WHERE "tenantId" = ${tenantId}`;
  return Number(r[0]?.bytes ?? 0);
}
/** ¿Cabe `bytes` más dentro del almacenamiento del plan? */
export async function canStore(tenantId: string, bytes: number): Promise<boolean> {
  const t = await loadTenant(tenantId);
  return (await storageUsedBytes(tenantId)) + bytes <= t.plan.storageMb * 1024 * 1024;
}

export type UsageSummary = {
  planName: string; users: { used: number; max: number }; bot: { used: number; max: number; month: string }; storage: { usedBytes: number; maxBytes: number };
  features: Record<Feature, boolean>;
};
export async function usageSummary(tenantId: string, now = new Date()): Promise<UsageSummary> {
  const t = await loadTenant(tenantId), month = limaDate(now).slice(0, 7);
  const [users, bot, bytes] = await Promise.all([db.user.count({ where: { tenantId, isActive: true } }), db.botUsage.count({ where: { tenantId, month } }), storageUsedBytes(tenantId)]);
  return {
    planName: t.plan.name, users: { used: users, max: t.plan.maxUsers }, bot: { used: bot, max: t.plan.botMonthlyReplies, month }, storage: { usedBytes: bytes, maxBytes: t.plan.storageMb * 1024 * 1024 },
    features: { WHATSAPP: featureEnabled(t, "WHATSAPP"), SUNAT: featureEnabled(t, "SUNAT"), REPORTS: featureEnabled(t, "REPORTS"), AUTOMATIONS: featureEnabled(t, "AUTOMATIONS") },
  };
}
