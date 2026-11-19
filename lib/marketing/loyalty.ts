import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { BillingError } from "@/lib/billing/errors";
import type { Tx } from "@/lib/billing/service";
import { DEFAULT_LOYALTY, availablePoints, computeLots, expiredLots, expiryDate, type LedgerEntry, type LoyaltyCfg } from "./pure";

/**
 * Programa de puntos. El libro (LoyaltyLedger) es INMUTABLE y `Guardian.loyaltyPoints` el saldo derivado (CHECK >= 0).
 * Cada movimiento se inserta con UNA sentencia condicionada al saldo (INSERT … SELECT … WHERE saldo + delta >= 0) y después se actualiza
 * el saldo en la misma transacción: ni dos canjes simultáneos ni un vencimiento pueden dejar el saldo negativo, y ni una venta acredita
 * dos veces ni un lote vence dos veces (índices únicos).
 */
export const loyaltyConfigSchema = z.object({
  enabled: z.boolean(),
  pointsPerSol: z.number().int().min(0).max(1000),
  expiryDays: z.number().int().min(0).max(3650),
  centsPerPoint: z.number().int().min(1).max(10000),
  maxRedeemPercent: z.number().int().min(1).max(100),
});

export async function getLoyaltyConfig(tenantId: string, client: Pick<Tx, "loyaltyConfig"> = db): Promise<LoyaltyCfg> {
  const c = await client.loyaltyConfig.findUnique({ where: { tenantId } });
  return c ? { enabled: c.enabled, pointsPerSol: c.pointsPerSol, expiryDays: c.expiryDays, centsPerPoint: c.centsPerPoint, maxRedeemPercent: c.maxRedeemPercent } : DEFAULT_LOYALTY;
}

export async function saveLoyaltyConfig(tenantId: string, userId: string, input: LoyaltyCfg) {
  const d = loyaltyConfigSchema.parse(input);
  await db.loyaltyConfig.upsert({ where: { tenantId }, create: { tenantId, ...d, updatedById: userId }, update: { ...d, updatedById: userId } });
}

type Movement = { tenantId: string; guardianId: string; type: "EARN" | "REDEEM" | "EXPIRE" | "ADJUST"; delta: number; saleId?: string | null; expiresAt?: Date | null; lotId?: string | null; note?: string | null; userId?: string | null; now: Date };

/** Inserta el movimiento solo si el saldo no queda negativo y actualiza el saldo. Devuelve false si no hay saldo suficiente. */
async function move(tx: Tx, m: Movement): Promise<boolean> {
  const affected = await tx.$executeRaw`
    INSERT INTO "LoyaltyLedger" ("id","tenantId","guardianId","type","points","balanceAfter","saleId","expiresAt","lotId","note","createdById","createdAt")
    SELECT ${randomUUID()}, ${m.tenantId}, g."id", ${m.type}, ${m.delta}, g."loyaltyPoints" + ${m.delta}, ${m.saleId ?? null}, ${m.expiresAt?.toISOString() ?? null},
           ${m.lotId ?? null}, ${m.note ?? null}, ${m.userId ?? null}, ${m.now.toISOString()}
    FROM "Guardian" g WHERE g."id" = ${m.guardianId} AND g."tenantId" = ${m.tenantId} AND g."loyaltyPoints" + ${m.delta} >= 0`;
  if (affected !== 1) return false;
  const upd = await tx.$executeRaw`UPDATE "Guardian" SET "loyaltyPoints" = "loyaltyPoints" + ${m.delta} WHERE "id" = ${m.guardianId} AND "tenantId" = ${m.tenantId} AND "loyaltyPoints" + ${m.delta} >= 0`;
  if (upd !== 1) throw new BillingError("No se pudo actualizar el saldo de puntos");
  return true;
}

const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e));

/** Vence los lotes cuya fecha ya pasó (una sola vez por lote). Debe ejecutarse antes de leer el saldo para canjear. */
export async function expireDue(tx: Tx, tenantId: string, guardianId: string, now: Date): Promise<number> {
  const entries = await tx.loyaltyLedger.findMany({ where: { tenantId, guardianId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, type: true, points: true, expiresAt: true, lotId: true, createdAt: true } });
  let expired = 0;
  for (const lot of expiredLots(computeLots(entries as LedgerEntry[]), now)) {
    try {
      if (await move(tx, { tenantId, guardianId, type: "EXPIRE", delta: -lot.remaining, lotId: lot.id, note: "Vencimiento de puntos", now })) expired += lot.remaining;
    } catch (e) { if (!isUnique(e)) throw e; /* otro proceso ya venció este lote */ }
  }
  return expired;
}

export async function earnPoints(tx: Tx, p: { tenantId: string; guardianId: string; saleId: string; points: number; cfg: LoyaltyCfg; now: Date; userId?: string }) {
  if (p.points <= 0) return;
  try { await move(tx, { tenantId: p.tenantId, guardianId: p.guardianId, type: "EARN", delta: p.points, saleId: p.saleId, expiresAt: expiryDate(p.now, p.cfg.expiryDays), userId: p.userId, now: p.now }); }
  catch (e) { if (!isUnique(e)) throw e; /* esta venta ya acreditó sus puntos */ }
}

export async function redeemPoints(tx: Tx, p: { tenantId: string; guardianId: string; saleId: string; points: number; now: Date; userId: string }) {
  if (p.points <= 0) return;
  if (!(await move(tx, { tenantId: p.tenantId, guardianId: p.guardianId, type: "REDEEM", delta: -p.points, saleId: p.saleId, note: "Canje en caja", userId: p.userId, now: p.now }))) throw new BillingError("Puntos insuficientes (el saldo cambió)");
}

/** Saldo para la interfaz: disponible (sin vencidos), por vencer en 30 días y movimientos recientes. */
export async function loyaltyBalance(tenantId: string, guardianId: string, now = new Date()) {
  const [g, entries] = await Promise.all([
    db.guardian.findFirst({ where: { id: guardianId, tenantId }, select: { loyaltyPoints: true } }),
    db.loyaltyLedger.findMany({ where: { tenantId, guardianId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200 }),
  ]);
  const lots = computeLots([...entries].reverse() as LedgerEntry[]);
  const soon = new Date(now.getTime() + 30 * 86_400_000);
  return {
    stored: g?.loyaltyPoints ?? 0, available: availablePoints(lots, now),
    expiringSoon: lots.filter((l) => l.remaining > 0 && l.expiresAt && l.expiresAt > now && l.expiresAt <= soon).reduce((n, l) => n + l.remaining, 0),
    recent: entries.slice(0, 20),
  };
}

/** Tarea diaria: vence los puntos de todos los apoderados con saldo (idempotente). */
export async function expireAllDue(now = new Date(), batch = 200) {
  const guardians = await db.guardian.findMany({ where: { loyaltyPoints: { gt: 0 } }, select: { id: true, tenantId: true }, take: batch });
  let points = 0, touched = 0;
  for (const g of guardians) {
    const n = await db.$transaction((tx) => expireDue(tx, g.tenantId, g.id, now), { maxWait: 10_000, timeout: 30_000 });
    if (n > 0) { points += n; touched++; }
  }
  return { checked: guardians.length, guardiansWithExpiry: touched, pointsExpired: points };
}
