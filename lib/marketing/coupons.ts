import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { normalizeCouponCode } from "./pure";

/** Alta/edición de cupones (los permisos —solo OWNER y ADMIN— se exigen en las acciones; aquí todo va con tenantId explícito). */
export class CouponError extends Error {}
const date = z.string().optional().transform((v) => (v ? new Date(v) : null)).pipe(z.date().nullable());
export const couponSchema = z.object({
  code: z.string().transform(normalizeCouponCode).pipe(z.string().min(3, "El código debe tener al menos 3 caracteres")),
  description: z.string().trim().max(200).optional().transform((v) => v || null),
  type: z.enum(["PERCENTAGE", "FIXED_CENTS"]),
  value: z.number().int().positive(),
  validFrom: date, validUntil: date,
  maxUses: z.number().int().positive().nullable(),
  maxUsesPerGuardian: z.number().int().positive().nullable(),
  minPurchaseCents: z.number().int().min(0),
}).refine((c) => c.type !== "PERCENTAGE" || c.value <= 100, { message: "El porcentaje debe estar entre 1 y 100", path: ["value"] })
  .refine((c) => !c.validFrom || !c.validUntil || c.validUntil >= c.validFrom, { message: "La fecha de fin debe ser posterior al inicio", path: ["validUntil"] });
export type CouponInput = z.input<typeof couponSchema>;

const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e));

export async function createCoupon(tenantId: string, userId: string, input: CouponInput) {
  const d = couponSchema.parse(input);
  try { return await db.coupon.create({ data: { tenantId, createdById: userId, ...d } }); }
  catch (e) { throw isUnique(e) ? new CouponError("Ya existe un cupón con ese código") : e; }
}

export async function updateCoupon(tenantId: string, id: string, input: CouponInput) {
  const d = couponSchema.parse(input);
  const cur = await db.coupon.findFirst({ where: { id, tenantId } });
  if (!cur) throw new CouponError("Cupón no encontrado");
  if (d.maxUses !== null && d.maxUses < cur.usesCount) throw new CouponError(`El límite no puede ser menor a los usos ya realizados (${cur.usesCount})`);
  // El código no cambia (los canjes pasados hacen referencia a él); lo demás sí. Un cambio no altera descuentos ya otorgados.
  const { code: _c, ...rest } = d; void _c;
  const r = await db.coupon.updateMany({ where: { id, tenantId }, data: rest });
  if (r.count !== 1) throw new CouponError("Cupón no encontrado");
}

export async function setCouponActive(tenantId: string, id: string, active: boolean) {
  const r = await db.coupon.updateMany({ where: { id, tenantId }, data: { isActive: active } });
  if (r.count !== 1) throw new CouponError("Cupón no encontrado");
}

export const listCoupons = (tenantId: string) => db.coupon.findMany({ where: { tenantId }, orderBy: [{ isActive: "desc" }, { createdAt: "desc" }], take: 200 });
