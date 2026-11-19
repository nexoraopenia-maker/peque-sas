import { describe, expect, it } from "vitest";
import { DEFAULT_LOYALTY, availablePoints, computeLots, evaluateCoupon, expiredLots, expiryDate, isOptOut, normalizeCouponCode, planRedemption, pointsForPayment, type CouponLike, type LedgerEntry } from "@/lib/marketing/pure";
import { hasPermission } from "@/lib/rbac/permissions";

const now = new Date("2026-03-10T12:00:00Z");
const coupon = (o: Partial<CouponLike> = {}): CouponLike => ({ code: "PROMO", type: "PERCENTAGE", value: 10, validFrom: null, validUntil: null, maxUses: null, usesCount: 0, maxUsesPerGuardian: null, minPurchaseCents: 0, isActive: true, ...o });
const ev = (c: CouponLike, subtotal = 10000, over = {}) => evaluateCoupon(c, { subtotalCents: subtotal, now, guardianUses: 0, hasGuardian: true, ...over });

describe("cupones", () => {
  it("porcentaje y monto fijo; el descuento nunca supera el subtotal", () => {
    expect(ev(coupon())).toEqual({ ok: true, discountCents: 1000 });
    expect(ev(coupon({ value: 33 }), 1001)).toEqual({ ok: true, discountCents: 330 });          // se redondea hacia abajo: nunca se descuenta de más
    expect(ev(coupon({ type: "FIXED_CENTS", value: 500 }))).toEqual({ ok: true, discountCents: 500 });
    expect(ev(coupon({ type: "FIXED_CENTS", value: 5000 }), 1200)).toEqual({ ok: true, discountCents: 1200 });
    expect(ev(coupon({ value: 100 }), 1500)).toEqual({ ok: true, discountCents: 1500 });
  });
  it("rechaza desactivado, fuera de vigencia, monto mínimo y límites", () => {
    expect(ev(coupon({ isActive: false }))).toMatchObject({ ok: false, reason: expect.stringContaining("desactivado") });
    expect(ev(coupon({ validFrom: new Date("2026-03-11T00:00:00Z") }))).toMatchObject({ ok: false, reason: expect.stringContaining("aún no") });
    expect(ev(coupon({ validUntil: new Date("2026-03-09T00:00:00Z") }))).toMatchObject({ ok: false, reason: expect.stringContaining("venció") });
    expect(ev(coupon({ minPurchaseCents: 20000 }))).toMatchObject({ ok: false, reason: expect.stringContaining("S/ 200.00") });
    expect(ev(coupon({ maxUses: 5, usesCount: 5 }))).toMatchObject({ ok: false, reason: expect.stringContaining("límite de usos") });
    expect(ev(coupon({ maxUses: 5, usesCount: 4 })).ok).toBe(true);
  });
  it("límite por familia: exige identificar al apoderado y se agota", () => {
    const c = coupon({ maxUsesPerGuardian: 1 });
    expect(ev(c, 10000, { hasGuardian: false })).toMatchObject({ ok: false, reason: expect.stringContaining("identificar") });
    expect(ev(c, 10000, { guardianUses: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining("ya usó") });
    expect(ev(c, 10000, { guardianUses: 0 }).ok).toBe(true);
  });
  it("vigencia inclusiva en los extremos y código normalizado", () => {
    expect(ev(coupon({ validFrom: now, validUntil: now })).ok).toBe(true);
    expect(normalizeCouponCode(" verano-25! ")).toBe("VERANO-25");
    expect(normalizeCouponCode("a".repeat(50))).toHaveLength(30);
  });
  it("subtotal 0 no genera descuento", () => expect(ev(coupon(), 0)).toMatchObject({ ok: false }));
});

describe("puntos", () => {
  it("1 punto por cada S/ 1.00 pagado (solo soles completos) y configurable", () => {
    expect(pointsForPayment(10000, DEFAULT_LOYALTY)).toBe(100);
    expect(pointsForPayment(1999, DEFAULT_LOYALTY)).toBe(19);
    expect(pointsForPayment(99, DEFAULT_LOYALTY)).toBe(0);
    expect(pointsForPayment(10000, { ...DEFAULT_LOYALTY, pointsPerSol: 3 })).toBe(300);
    expect(pointsForPayment(10000, { ...DEFAULT_LOYALTY, enabled: false })).toBe(0);
    expect(pointsForPayment(0, DEFAULT_LOYALTY)).toBe(0);
  });
  it("vence a los 365 días; 0 = sin vencimiento", () => {
    expect(expiryDate(now, 365)!.toISOString()).toBe("2027-03-10T12:00:00.000Z");
    expect(expiryDate(now, 0)).toBeNull();
  });
  it("canje: respeta saldo, tasa y tope porcentual; consume solo los puntos necesarios", () => {
    const base = { availablePoints: 500, payableCents: 10000, cfg: DEFAULT_LOYALTY };    // 1 punto = S/ 0.10; tope 50%
    expect(planRedemption({ ...base, requestedPoints: 100 })).toEqual({ ok: true, points: 100, discountCents: 1000 });
    expect(planRedemption({ ...base, requestedPoints: 500 })).toEqual({ ok: true, points: 500, discountCents: 5000 });   // justo el tope
    expect(planRedemption({ ...base, requestedPoints: 400 })).toEqual({ ok: true, points: 400, discountCents: 4000 });
    expect(planRedemption({ ...base, availablePoints: 900, requestedPoints: 800 })).toEqual({ ok: true, points: 500, discountCents: 5000 }); // tope 50%: solo 500 puntos
    expect(planRedemption({ ...base, requestedPoints: 501 })).toMatchObject({ ok: false, reason: expect.stringContaining("insuficientes") });
    expect(planRedemption({ ...base, requestedPoints: 0 })).toEqual({ ok: true, points: 0, discountCents: 0 });
    expect(planRedemption({ ...base, requestedPoints: -5 })).toMatchObject({ ok: false });
    expect(planRedemption({ ...base, requestedPoints: 1.5 })).toMatchObject({ ok: false });
    expect(planRedemption({ ...base, cfg: { ...DEFAULT_LOYALTY, enabled: false }, requestedPoints: 10 })).toMatchObject({ ok: false });
  });
  it("el canje nunca deja el total negativo ni supera lo que se paga", () => {
    for (const payable of [0, 1, 99, 101, 5555, 100000]) for (const req of [1, 7, 100, 1000]) {
      const r = planRedemption({ requestedPoints: req, availablePoints: 100000, payableCents: payable, cfg: { ...DEFAULT_LOYALTY, maxRedeemPercent: 100 } });
      if (r.ok) { expect(r.discountCents).toBeLessThanOrEqual(payable); expect(r.points).toBeLessThanOrEqual(req); expect(Number.isInteger(r.points)).toBe(true); }
    }
  });
});

describe("lotes FIFO y vencimiento", () => {
  const d = (s: string) => new Date(`2026-${s}T00:00:00Z`);
  const earn = (id: string, pts: number, at: string, exp: string | null): LedgerEntry => ({ id, type: "EARN", points: pts, expiresAt: exp ? d(exp) : null, lotId: null, createdAt: d(at) });
  const redeem = (id: string, pts: number, at: string): LedgerEntry => ({ id, type: "REDEEM", points: -pts, expiresAt: null, lotId: null, createdAt: d(at) });
  it("los canjes consumen primero el lote más antiguo", () => {
    const lots = computeLots([earn("a", 100, "01-01", "12-31"), earn("b", 50, "02-01", "12-31"), redeem("r", 120, "03-01")]);
    expect(lots.map((l) => [l.id, l.remaining])).toEqual([["a", 0], ["b", 30]]);
  });
  it("detecta lotes vencidos con saldo y los excluye del disponible", () => {
    const lots = computeLots([earn("a", 100, "01-01", "03-01"), earn("b", 50, "02-01", "12-31")]);
    expect(expiredLots(lots, d("03-10")).map((l) => [l.id, l.remaining])).toEqual([["a", 100]]);
    expect(availablePoints(lots, d("03-10"))).toBe(50);
    expect(availablePoints(lots, d("02-15"))).toBe(150);
  });
  it("lo ya canjeado de un lote no vence; un EXPIRE agota su lote y no se repite", () => {
    const lots = computeLots([earn("a", 100, "01-01", "03-01"), redeem("r", 100, "02-01")]);
    expect(expiredLots(lots, d("03-10"))).toEqual([]);
    const l2 = computeLots([earn("a", 100, "01-01", "03-01"), { id: "x", type: "EXPIRE", points: -100, expiresAt: null, lotId: "a", createdAt: d("03-02") }]);
    expect(expiredLots(l2, d("03-10"))).toEqual([]);
    expect(l2[0]!.remaining).toBe(0);
  });
  it("sin vencimiento (null) nunca expira; el saldo del libro coincide con los lotes", () => {
    const entries = [earn("a", 100, "01-01", null), redeem("r", 30, "02-01"), earn("b", 20, "03-01", "04-01")];
    const lots = computeLots(entries);
    expect(availablePoints(lots, d("12-01"))).toBe(70);
    expect(lots.reduce((n, l) => n + l.remaining, 0)).toBe(entries.reduce((n, e) => n + e.points, 0));
  });
});

describe("baja del marketing por WhatsApp", () => {
  it.each(["BAJA", "baja", "Stop", "STOP.", " no quiero promociones ", "No más promociones", "dar de baja", "Unsubscribe", "darme de baja!"])("reconoce: %s", (t) => expect(isOptOut(t)).toBe(true));
  it.each(["quiero reservar", "¿cuánto cuesta?", "no puedo ir, cancelar la reserva", "stop the car", "la baja de mi hijo por enfermedad", "hola", ""])("NO reconoce: %s", (t) => expect(isOptOut(t)).toBe(false));
});

describe("permisos de cupones y marketing", () => {
  it("solo OWNER y ADMIN crean/editan/desactivan; RECEPTION solo consulta", () => {
    for (const r of ["OWNER", "ADMIN"] as const) { expect(hasPermission(r, "coupons:manage")).toBe(true); expect(hasPermission(r, "marketing:manage")).toBe(true); expect(hasPermission(r, "loyalty:configure")).toBe(true); }
    expect(hasPermission("RECEPTION", "coupons:manage")).toBe(false);
    expect(hasPermission("RECEPTION", "coupons:view")).toBe(true);
    expect(hasPermission("RECEPTION", "cash:use")).toBe(true);        // y puede aplicarlos al cobrar
    expect(hasPermission("RECEPTION", "marketing:manage")).toBe(false);
    expect(hasPermission("RECEPTION", "loyalty:configure")).toBe(false);
    expect(hasPermission("TEACHER", "coupons:manage")).toBe(false);
    expect(hasPermission("SUPERADMIN", "coupons:manage")).toBe(false);
  });
});
