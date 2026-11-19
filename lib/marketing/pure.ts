// Lógica PURA de fidelización y cupones (sin base de datos). Todo en céntimos y puntos enteros.
export type CouponLike = {
  code: string; type: "PERCENTAGE" | "FIXED_CENTS"; value: number; validFrom: Date | null; validUntil: Date | null;
  maxUses: number | null; usesCount: number; maxUsesPerGuardian: number | null; minPurchaseCents: number; isActive: boolean;
};
export type CouponCheck = { ok: true; discountCents: number } | { ok: false; reason: string };

export const normalizeCouponCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30);
const soles = (c: number) => `S/ ${(c / 100).toFixed(2)}`;

/** Valida un cupón contra una compra y calcula su descuento (nunca mayor que el subtotal). */
export function evaluateCoupon(c: CouponLike, ctx: { subtotalCents: number; now: Date; guardianUses: number; hasGuardian: boolean }): CouponCheck {
  if (!c.isActive) return { ok: false, reason: "El cupón está desactivado" };
  if (c.validFrom && ctx.now < c.validFrom) return { ok: false, reason: "El cupón aún no está vigente" };
  if (c.validUntil && ctx.now > c.validUntil) return { ok: false, reason: "El cupón venció" };
  if (ctx.subtotalCents < c.minPurchaseCents) return { ok: false, reason: `El cupón requiere una compra mínima de ${soles(c.minPurchaseCents)}` };
  if (c.maxUses !== null && c.usesCount >= c.maxUses) return { ok: false, reason: "El cupón alcanzó su límite de usos" };
  if (c.maxUsesPerGuardian !== null) {
    if (!ctx.hasGuardian) return { ok: false, reason: "Este cupón requiere identificar al apoderado (DNI o teléfono)" };
    if (ctx.guardianUses >= c.maxUsesPerGuardian) return { ok: false, reason: "Esta familia ya usó el cupón el máximo de veces" };
  }
  const raw = c.type === "PERCENTAGE" ? Math.floor((ctx.subtotalCents * c.value) / 100) : Math.min(c.value, ctx.subtotalCents);
  const discountCents = Math.min(raw, ctx.subtotalCents);
  return discountCents > 0 ? { ok: true, discountCents } : { ok: false, reason: "El cupón no genera descuento en esta compra" };
}

export type LoyaltyCfg = { enabled: boolean; pointsPerSol: number; expiryDays: number; centsPerPoint: number; maxRedeemPercent: number };
export const DEFAULT_LOYALTY: LoyaltyCfg = { enabled: true, pointsPerSol: 1, expiryDays: 365, centsPerPoint: 10, maxRedeemPercent: 50 };

/** Puntos por lo realmente PAGADO (después de descuentos): `pointsPerSol` por cada S/ 1.00 completo. */
export const pointsForPayment = (paidCents: number, cfg: LoyaltyCfg) => (cfg.enabled && paidCents > 0 ? Math.floor(paidCents / 100) * cfg.pointsPerSol : 0);
export const expiryDate = (from: Date, days: number): Date | null => (days > 0 ? new Date(from.getTime() + days * 86_400_000) : null);

export type Redemption = { ok: true; points: number; discountCents: number } | { ok: false; reason: string };
/** Canje de puntos: respeta el saldo, la tasa de conversión y el tope porcentual del total a pagar. Solo se consumen los puntos necesarios. */
export function planRedemption(i: { requestedPoints: number; availablePoints: number; payableCents: number; cfg: LoyaltyCfg }): Redemption {
  const { requestedPoints: req, cfg } = i;
  if (!Number.isSafeInteger(req) || req < 0) return { ok: false, reason: "Cantidad de puntos inválida" };
  if (req === 0) return { ok: true, points: 0, discountCents: 0 };
  if (!cfg.enabled) return { ok: false, reason: "El programa de puntos no está activo" };
  if (req > i.availablePoints) return { ok: false, reason: `Puntos insuficientes (disponibles: ${i.availablePoints})` };
  const maxDiscount = Math.floor((i.payableCents * cfg.maxRedeemPercent) / 100);
  const discountCents = Math.min(req * cfg.centsPerPoint, maxDiscount, i.payableCents);
  if (discountCents <= 0) return { ok: true, points: 0, discountCents: 0 };
  return { ok: true, points: Math.ceil(discountCents / cfg.centsPerPoint), discountCents };
}

export type LedgerEntry = { id: string; type: "EARN" | "REDEEM" | "EXPIRE" | "ADJUST"; points: number; expiresAt: Date | null; lotId: string | null; createdAt: Date };
export type Lot = { id: string; remaining: number; expiresAt: Date | null };

/**
 * Lotes de puntos por orden de llegada (FIFO): los canjes consumen primero los lotes más antiguos y un EXPIRE agota el suyo.
 * Función determinista sobre el libro inmutable: no necesita campos mutables.
 */
export function computeLots(entries: LedgerEntry[]): Lot[] {
  const lots: Lot[] = [];
  const sorted = [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  for (const e of sorted) {
    if (e.type === "EARN") lots.push({ id: e.id, remaining: e.points, expiresAt: e.expiresAt });
    else if (e.type === "EXPIRE") { const l = lots.find((x) => x.id === e.lotId); if (l) l.remaining = Math.max(0, l.remaining + e.points); }
    else if (e.points < 0) {
      let need = -e.points;
      for (const l of lots) { if (need === 0) break; const take = Math.min(l.remaining, need); l.remaining -= take; need -= take; }
    } else if (e.type === "ADJUST") lots.push({ id: e.id, remaining: e.points, expiresAt: null });
  }
  return lots;
}
export const isLotExpired = (l: Lot, now: Date) => l.expiresAt !== null && l.expiresAt <= now;
export const availablePoints = (lots: Lot[], now: Date) => lots.filter((l) => !isLotExpired(l, now)).reduce((n, l) => n + l.remaining, 0);
export const expiredLots = (lots: Lot[], now: Date) => lots.filter((l) => l.remaining > 0 && isLotExpired(l, now));

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const OPT_OUT = new Set(["baja", "stop", "parar", "dar de baja", "darme de baja", "desuscribir", "desuscribirme", "unsubscribe", "no mas promociones", "no quiero promociones", "no quiero mas promociones", "no mas mensajes"]);
/** Baja del marketing: solo coincidencia EXACTA con una palabra clave (evita revocar por frases normales de una conversación). */
export const isOptOut = (text: string) => OPT_OUT.has(norm(text));
