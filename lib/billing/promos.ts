import "server-only";
import { randomUUID } from "node:crypto";
import { normalizeIdentifier } from "@/lib/portal/identity";
import { BillingError } from "./errors";
import type { ItemInput, Tx } from "./service";
import { expireDue, getLoyaltyConfig, earnPoints, redeemPoints } from "@/lib/marketing/loyalty";
import { evaluateCoupon, normalizeCouponCode, planRedemption, type LoyaltyCfg } from "@/lib/marketing/pure";

/**
 * Cupones y puntos aplicados DENTRO de la transacción de la venta: el descuento se recalcula en el servidor (nunca se confía en el navegador),
 * el uso del cupón y el saldo de puntos se consumen con actualizaciones condicionadas, y si cualquier paso falla se revierte la venta completa.
 */
export type PromoInput = { couponCode?: string | null; redeemPoints?: number; guardianLookup?: string | null; preferredGuardianId?: string | null; childId?: string | null };
export type PromoPlan = {
  guardianId: string | null; cfg: LoyaltyCfg; items: ItemInput[]; discountCents: number; couponId: string | null; couponDiscountCents: number;
  couponMaxPerGuardian: number | null; pointsUsed: number; pointsDiscountCents: number;
};

/** Apoderado al que se le acreditan los puntos (y que identifica a la familia para los límites de cupón). */
export async function resolveGuardian(tx: Tx, tenantId: string, i: PromoInput): Promise<string | null> {
  if (i.guardianLookup?.trim()) {
    const id = normalizeIdentifier(i.guardianLookup);
    if (!id) throw new BillingError("DNI (8 dígitos) o teléfono (9 dígitos) no válido");
    const found = await tx.guardian.findMany({ where: { tenantId, ...(id.kind === "dni" ? { dni: id.value } : { phoneDigits: id.value }) }, select: { id: true }, take: 2 });
    if (found.length === 0) throw new BillingError("No se encontró un apoderado con ese DNI o teléfono");
    if (found.length > 1) throw new BillingError("Hay más de un apoderado con ese dato: usa el DNI");
    return found[0]!.id;
  }
  if (i.preferredGuardianId) {
    const g = await tx.guardian.findFirst({ where: { id: i.preferredGuardianId, tenantId }, select: { id: true } });
    if (g) return g.id;
  }
  if (i.childId) {
    const l = await tx.childGuardian.findFirst({ where: { tenantId, childId: i.childId }, orderBy: { guardianId: "asc" }, select: { guardianId: true } });
    if (l) return l.guardianId;
  }
  return null;
}

export async function preparePromos(tx: Tx, p: { tenantId: string; subtotalCents: number; input: PromoInput; now: Date }): Promise<PromoPlan> {
  const { tenantId, subtotalCents, input, now } = p;
  const guardianId = await resolveGuardian(tx, tenantId, input);
  const cfg = await getLoyaltyConfig(tenantId, tx);
  const plan: PromoPlan = { guardianId, cfg, items: [], discountCents: 0, couponId: null, couponDiscountCents: 0, couponMaxPerGuardian: null, pointsUsed: 0, pointsDiscountCents: 0 };

  const code = input.couponCode ? normalizeCouponCode(input.couponCode) : "";
  if (code) {
    const c = await tx.coupon.findFirst({ where: { tenantId, code } });
    if (!c) throw new BillingError("Cupón no válido");
    const uses = guardianId ? await tx.couponRedemption.count({ where: { tenantId, couponId: c.id, guardianId } }) : 0;
    const check = evaluateCoupon(c, { subtotalCents, now, guardianUses: uses, hasGuardian: !!guardianId });
    if (!check.ok) throw new BillingError(check.reason);
    // Uso global atómico: dos cobros simultáneos no pueden superar maxUses
    const n = await tx.$executeRaw`UPDATE "Coupon" SET "usesCount" = "usesCount" + 1 WHERE "id" = ${c.id} AND "tenantId" = ${tenantId} AND "isActive" = 1 AND ("maxUses" IS NULL OR "usesCount" < "maxUses")`;
    if (n !== 1) throw new BillingError("El cupón alcanzó su límite de usos");
    plan.couponId = c.id; plan.couponDiscountCents = check.discountCents; plan.couponMaxPerGuardian = c.maxUsesPerGuardian;
    plan.items.push({ kind: "COUPON_DISCOUNT", description: `Cupón ${c.code}`, quantity: 1, unitPriceCents: 0, totalCents: -check.discountCents });
  }

  const requested = input.redeemPoints ?? 0;
  if (requested > 0) {
    if (!guardianId) throw new BillingError("Identifica al apoderado (DNI o teléfono) para canjear puntos");
    await expireDue(tx, tenantId, guardianId, now);                                   // primero vencen los puntos viejos
    const g = await tx.guardian.findFirstOrThrow({ where: { id: guardianId, tenantId }, select: { loyaltyPoints: true } });
    const r = planRedemption({ requestedPoints: requested, availablePoints: g.loyaltyPoints, payableCents: subtotalCents - plan.couponDiscountCents, cfg });
    if (!r.ok) throw new BillingError(r.reason);
    if (r.points > 0) {
      plan.pointsUsed = r.points; plan.pointsDiscountCents = r.discountCents;
      plan.items.push({ kind: "POINTS_DISCOUNT", description: `Canje de ${r.points} puntos`, quantity: r.points, unitPriceCents: 0, totalCents: -r.discountCents });
    }
  }
  plan.discountCents = plan.couponDiscountCents + plan.pointsDiscountCents;
  return plan;
}

/** Después de insertar la venta: registra el canje del cupón y del saldo (condicionados) y acredita los puntos ganados. */
export async function recordPromos(tx: Tx, p: { tenantId: string; userId: string; saleId: string; plan: PromoPlan; earned: number; now: Date }) {
  const { tenantId, saleId, plan, now } = p;
  if (plan.couponId) {
    // Límite por familia ATÓMICO: la fila solo entra si la familia no alcanzó el máximo
    const max = plan.couponMaxPerGuardian;
    const n = await tx.$executeRaw`
      INSERT INTO "CouponRedemption" ("id","tenantId","couponId","saleId","guardianId","discountCents","createdAt")
      SELECT ${randomUUID()}, ${tenantId}, ${plan.couponId}, ${saleId}, ${plan.guardianId}, ${plan.couponDiscountCents}, ${now.toISOString()}
      WHERE ${max} IS NULL OR (SELECT COUNT(*) FROM "CouponRedemption" WHERE "tenantId" = ${tenantId} AND "couponId" = ${plan.couponId} AND "guardianId" = ${plan.guardianId}) < ${max}`;
    if (n !== 1) throw new BillingError("Esta familia ya usó el cupón el máximo de veces");
  }
  if (plan.pointsUsed > 0) await redeemPoints(tx, { tenantId, guardianId: plan.guardianId!, saleId, points: plan.pointsUsed, now, userId: p.userId });
  if (plan.guardianId && p.earned > 0) await earnPoints(tx, { tenantId, guardianId: plan.guardianId, saleId, points: p.earned, cfg: plan.cfg, now, userId: p.userId });
}

