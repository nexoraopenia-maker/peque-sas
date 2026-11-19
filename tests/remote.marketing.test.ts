import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { BillingError, checkoutPlayground, closeCashSession, openCashSession, posSale, sellPrepaidPackage } from "@/lib/billing/service";
import { insertSessionIfCapacity } from "@/lib/playground/checkin";
import { createCoupon, setCouponActive, updateCoupon, CouponError } from "@/lib/marketing/coupons";
import { expireAllDue, loyaltyBalance, saveLoyaltyConfig } from "@/lib/marketing/loyalty";
import { ConsentError, revokeByPhone, setMarketingConsent } from "@/lib/marketing/consent";
import { cancelCampaign, createCampaign, sendBatch, segmentAudience, startCampaign } from "@/lib/marketing/campaigns";
import { configSchema, saveConfig, type Fetch } from "@/lib/whatsapp/service";
import { handleWebhookPost } from "@/lib/whatsapp/webhook";
import { signBody } from "@/lib/whatsapp/signature";
import { limaDate } from "@/lib/utils/date";
import { addDays } from "@/lib/reservations/calendar";

// Contra Turso remoto (RUN_REMOTE_TESTS=1). Graph API = doble inyectado.
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__mkt_${Date.now()}`;
let planId = "", A = "", B = "", uA = "", uB = "", seq = 0;
const cash = { first: "EFECTIVO" as const, firstAmountCents: null };
const key = () => `${tag}-${++seq}-${Math.random().toString(36).slice(2)}`;
const PID = "910000000000001", WABA = "920000000000001", TOK = "EAAmkt_" + "t".repeat(40), SECRET = "f3".repeat(16);

async function product(tenantId: string, name: string, stock: number, priceCents: number) { return db.product.create({ data: { tenantId, name, stock, priceCents } }); }
async function guardian(tenantId: string, name: string, dni: string, phone: string, consent = false) {
  return db.guardian.create({ data: { tenantId, fullName: name, dni, phone, phoneDigits: phone, ...(consent ? { marketingConsent: true, marketingConsentAt: new Date(), marketingConsentSource: "STAFF" } : {}) } });
}
async function family(tenantId: string, gName: string, dni: string, phone: string, kid: string, extra: Record<string, unknown> = {}, consent = false) {
  const g = await guardian(tenantId, gName, dni, phone, consent);
  const c = await db.child.create({ data: { tenantId, fullName: kid, ...extra } });
  await db.childGuardian.create({ data: { tenantId, childId: c.id, guardianId: g.id, canPickup: true } });
  return { g, c };
}
const sale = (tenantId: string, userId: string, lines: { productId: string; quantity: number }[], promo: Parameters<typeof posSale>[0]["promo"], pay = cash) => posSale({ tenantId, userId, lines, pay, idempotencyKey: key(), promo });
const pts = async (id: string) => (await db.guardian.findFirstOrThrow({ where: { id } })).loyaltyPoints;
const ledgerSum = async (id: string) => (await db.loyaltyLedger.aggregate({ where: { guardianId: id }, _sum: { points: true } }))._sum.points ?? 0;
const coupon = (over: Record<string, unknown> = {}) => createCoupon(A, uA, { code: `C${++seq}${Math.random().toString(36).slice(2, 5)}`, type: "PERCENTAGE", value: 10, maxUses: null, maxUsesPerGuardian: null, minPurchaseCents: 0, ...over } as never);

function graph() {
  const calls: { to: string; template: { name: string; components: { parameters: { text: string }[] }[] } | undefined }[] = [];
  let n = 0;
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/messages")) { const b = JSON.parse(String(init!.body)); calls.push({ to: b.to, template: b.template }); return new Response(JSON.stringify({ messages: [{ id: `wamid.${tag}.${++n}.${Math.random().toString(36).slice(2, 8)}` }] })); }
    return new Response("{}");
  }) as unknown as Fetch;
  return { impl, calls };
}

run("Fase 13: fidelización, cupones, consentimiento y campañas (Turso remoto)", () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "s".repeat(48);
    planId = (await db.plan.create({ data: { name: tag, modules: [] } })).id;
    A = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId, modules: ["PLAYGROUND", "WHATSAPP"], playgroundCapacity: 50 } })).id;
    B = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId, modules: ["PLAYGROUND", "WHATSAPP"] } })).id;
    uA = (await db.user.create({ data: { email: `${tag}-a@example.test`, name: "a", role: "ADMIN", tenantId: A, passwordHash: "x" } })).id;
    uB = (await db.user.create({ data: { email: `${tag}-b@example.test`, name: "b", role: "ADMIN", tenantId: B, passwordHash: "x" } })).id;
    await openCashSession(A, uA, 0); await openCashSession(B, uB, 0);
    await saveConfig(A, uA, configSchema.parse({ phoneNumberId: PID, wabaId: WABA, accessToken: TOK, appSecret: SECRET }));
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { enabled: true, lastTestOk: true } });
  }, 240000);

  afterAll(async () => {
    const w = { where: { tenantId: { in: [A, B] } } };
    for (const m of ["campaignRecipient", "campaign", "couponRedemption", "saleItem", "sale", "loyaltyLedger", "consentEvent", "coupon", "loyaltyConfig", "prepaidLedger", "playgroundSession", "playgroundRate", "prepaidPackage", "stockMovement", "product", "cashRegisterSession", "whatsAppMessage", "whatsAppConversation", "whatsAppConfig", "enrollment", "childGuardian", "child", "guardian", "auditLog", "user"] as const)
      await (db[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany(w);
    await db.tenant.deleteMany({ where: { id: { in: [A, B] } } }); await db.plan.deleteMany({ where: { id: planId } });
  }, 240000);

  // ===== Puntos =====
  it("regla por defecto: 1 punto por cada S/ 1.00 PAGADO, acreditado al completar la venta, con vencimiento a 365 días", async () => {
    const { g } = await family(A, "Madre Puntos", "71000001", "987100001", "Niño P");
    const p = await product(A, "Jugo", 100, 2550);
    const r = await sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000001" });
    expect(r.totalCents).toBe(2550);
    expect(await pts(g.id)).toBe(25);                                                                   // solo soles completos
    const e = await db.loyaltyLedger.findFirstOrThrow({ where: { guardianId: g.id, type: "EARN" } });
    expect([e.points, e.balanceAfter, e.saleId]).toEqual([25, 25, r.saleId]);
    expect(Math.round((e.expiresAt!.getTime() - e.createdAt.getTime()) / 86_400_000)).toBe(365);
    const s = await db.sale.findFirstOrThrow({ where: { id: r.saleId } });
    expect([s.pointsEarned, s.loyaltyGuardianId, s.discountCents]).toEqual([25, g.id, 0]);
    // sin apoderado identificado no se acreditan puntos
    const before = await db.loyaltyLedger.count({ where: { tenantId: A } });
    await sale(A, uA, [{ productId: p.id, quantity: 1 }], undefined);
    expect(await db.loyaltyLedger.count({ where: { tenantId: A } })).toBe(before);
  }, 240000);

  it("configurable por establecimiento: puntos por sol, vencimiento (0 = nunca) y desactivación", async () => {
    const { g } = await family(A, "Madre Config", "71000002", "987100002", "Niño C");
    const p = await product(A, "Galleta", 100, 1000);
    await saveLoyaltyConfig(A, uA, { enabled: true, pointsPerSol: 3, expiryDays: 0, centsPerPoint: 10, maxRedeemPercent: 50 });
    await sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000002" });
    expect(await pts(g.id)).toBe(30);
    expect((await db.loyaltyLedger.findFirstOrThrow({ where: { guardianId: g.id, type: "EARN" } })).expiresAt).toBeNull();
    await saveLoyaltyConfig(A, uA, { enabled: false, pointsPerSol: 3, expiryDays: 0, centsPerPoint: 10, maxRedeemPercent: 50 });
    await sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000002" });
    expect(await pts(g.id)).toBe(30);                                                                   // desactivado: no acredita
    await saveLoyaltyConfig(A, uA, { enabled: true, pointsPerSol: 1, expiryDays: 365, centsPerPoint: 10, maxRedeemPercent: 50 });
    await expect(saveLoyaltyConfig(A, uA, { enabled: true, pointsPerSol: 1, expiryDays: 365, centsPerPoint: 0, maxRedeemPercent: 50 })).rejects.toThrow();
    await expect(saveLoyaltyConfig(A, uA, { enabled: true, pointsPerSol: 1, expiryDays: 365, centsPerPoint: 10, maxRedeemPercent: 101 })).rejects.toThrow();
  }, 240000);

  it("puntos en todos los cobros: cuponera y ludoteca los acreditan a la familia del menor", async () => {
    const { g, c } = await family(A, "Madre Cuponera", "71000003", "987100003", "Niño Q");
    const pkg = await db.prepaidPackage.create({ data: { tenantId: A, name: "60", minutes: 60, priceCents: 5000 } });
    await sellPrepaidPackage({ tenantId: A, userId: uA, childId: c.id, packageId: pkg.id, pay: cash, idempotencyKey: key() });
    expect(await pts(g.id)).toBe(50);
    // Ludoteca con otro menor SIN cuponera (la cuponera cubriría el cobro): cupón fijo + puntos sobre lo realmente pagado
    const k = await family(A, "Madre Ludoteca", "71000103", "987100103", "Niño Lud");
    const rate = await db.playgroundRate.create({ data: { tenantId: A, name: "1h", minutes: 60, priceCents: 2000, extraMinuteCents: 0 } });
    const sid = await insertSessionIfCapacity(db, { tenantId: A, childId: k.c.id, rateId: rate.id, braceletCode: "MK1", userId: uA, contractedMinutes: 60, basePriceCents: 2000, extraMinuteCents: 0 });
    const cp = await coupon({ type: "FIXED_CENTS", value: 500 });
    const r = await checkoutPlayground({ tenantId: A, userId: uA, sessionId: sid!, pay: cash, pickup: { kind: "GUARDIAN", refId: k.g.id, name: "Madre" }, promo: { couponCode: cp.code } });
    expect(r.totalCents).toBe(1500);                                                                    // 20.00 − 5.00 de cupón
    expect(await pts(k.g.id)).toBe(15);                                                                 // puntos sobre lo realmente pagado
    expect(await db.couponRedemption.count({ where: { tenantId: A, guardianId: k.g.id } })).toBe(1);
  }, 300000);

  // ===== Cupones =====
  it("aplica un cupón en el servidor: ítem de descuento, venta, canje y puntos sobre lo pagado", async () => {
    const { g } = await family(A, "Madre Cupón", "71000004", "987100004", "Niño K");
    const p = await product(A, "Torta", 100, 3000);
    const cp = await coupon({ value: 10 });
    const r = await sale(A, uA, [{ productId: p.id, quantity: 1 }], { couponCode: ` ${cp.code.toLowerCase()} `, guardianLookup: "71000004" });
    expect(r.totalCents).toBe(2700);
    const s = await db.sale.findFirstOrThrow({ where: { id: r.saleId }, include: { items: true } });
    expect([s.totalCents, s.discountCents, s.couponId, s.cashCents, s.pointsEarned]).toEqual([2700, 300, cp.id, 2700, 27]);
    expect(s.items.map((i) => [i.kind, i.totalCents]).sort()).toEqual([["COUPON_DISCOUNT", -300], ["PRODUCT", 3000]]);
    expect(s.items.reduce((n, i) => n + i.totalCents, 0)).toBe(s.totalCents);                          // los ítems siempre suman el total
    expect((await db.coupon.findFirstOrThrow({ where: { id: cp.id } })).usesCount).toBe(1);
    expect(await pts(g.id)).toBe(27);
  }, 240000);

  it("rechaza cupones inválidos SIN dejar rastro (venta, stock, uso)", async () => {
    const p = await product(A, "Pan", 10, 3000);
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["inactivo", { isActive: false }, /desactivado/], ["aún no vigente", { validFrom: new Date(Date.now() + 86_400_000).toISOString() }, /aún no/],
      ["vencido", { validUntil: new Date(Date.now() - 86_400_000).toISOString() }, /venció/], ["compra mínima", { minPurchaseCents: 99999 }, /compra mínima/],
    ];
    for (const [, over, re] of cases) {
      const { isActive, ...rest } = over as { isActive?: boolean };
      const cp = await coupon(rest); if (isActive === false) await setCouponActive(A, cp.id, false);
      const n = await db.sale.count({ where: { tenantId: A } });
      await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { couponCode: cp.code })).rejects.toThrow(re);
      expect(await db.sale.count({ where: { tenantId: A } })).toBe(n);
      expect((await db.coupon.findFirstOrThrow({ where: { id: cp.id } })).usesCount).toBe(0);
    }
    expect((await db.product.findFirstOrThrow({ where: { id: p.id } })).stock).toBe(10);
    await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { couponCode: "NOEXISTE" })).rejects.toThrow(/no válido/);
  }, 300000);

  it("un cupón de OTRO establecimiento no se puede usar", async () => {
    const cb = await createCoupon(B, uB, { code: "SOLOB", type: "PERCENTAGE", value: 50, maxUses: null, maxUsesPerGuardian: null, minPurchaseCents: 0 } as never);
    const p = await product(A, "Leche", 10, 1000);
    await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { couponCode: "SOLOB" })).rejects.toThrow(/no válido/);
    expect((await db.coupon.findFirstOrThrow({ where: { id: cb.id } })).usesCount).toBe(0);
    await expect(updateCoupon(A, cb.id, { code: "X123", type: "PERCENTAGE", value: 99, maxUses: null, maxUsesPerGuardian: null, minPurchaseCents: 0 } as never)).rejects.toThrow(CouponError); // no editable desde A
    await expect(setCouponActive(A, cb.id, false)).rejects.toThrow(/no encontrado/);
    expect((await db.coupon.findFirstOrThrow({ where: { id: cb.id } })).isActive).toBe(true);
    await createCoupon(A, uA, { code: "SOLOB", type: "PERCENTAGE", value: 5, maxUses: null, maxUsesPerGuardian: null, minPurchaseCents: 0 } as never); // el mismo código en otro tenant es independiente
    await expect(createCoupon(A, uA, { code: "solob", type: "PERCENTAGE", value: 5, maxUses: null, maxUsesPerGuardian: null, minPurchaseCents: 0 } as never)).rejects.toThrow(/Ya existe/);
  }, 240000);

  it("límite GLOBAL de usos con 8 cobros simultáneos: exactamente 3 lo logran y los demás se revierten por completo", async () => {
    const p = await product(A, "Cola", 100, 1000);
    const cp = await coupon({ value: 10, maxUses: 3 });
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => sale(A, uA, [{ productId: p.id, quantity: 1 }], { couponCode: cp.code })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(res.filter((r) => r.status === "rejected").every((r) => /límite de usos/.test(String((r as PromiseRejectedResult).reason?.message)))).toBe(true);
    expect((await db.coupon.findFirstOrThrow({ where: { id: cp.id } })).usesCount).toBe(3);
    expect(await db.couponRedemption.count({ where: { tenantId: A, couponId: cp.id } })).toBe(3);
    expect((await db.product.findFirstOrThrow({ where: { id: p.id } })).stock).toBe(97);               // los 5 rechazados no descontaron stock
  }, 300000);

  it("límite POR FAMILIA con 5 cobros simultáneos de la misma familia: exactamente 1", async () => {
    await family(A, "Madre Límite", "71000005", "987100005", "Niño L");
    const p = await product(A, "Agua", 100, 1000);
    const cp = await coupon({ value: 20, maxUsesPerGuardian: 1 });
    await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { couponCode: cp.code })).rejects.toThrow(/identificar al apoderado/);
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => sale(A, uA, [{ productId: p.id, quantity: 1 }], { couponCode: cp.code, guardianLookup: "71000005" })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const g = await db.guardian.findFirstOrThrow({ where: { tenantId: A, dni: "71000005" } });
    expect(await db.couponRedemption.count({ where: { tenantId: A, couponId: cp.id, guardianId: g.id } })).toBe(1);
    expect((await db.coupon.findFirstOrThrow({ where: { id: cp.id } })).usesCount).toBe(1);             // los rechazados devolvieron su uso global
    expect(await db.sale.count({ where: { tenantId: A, couponId: cp.id } })).toBe(1);
    await family(A, "Otra Madre", "71000006", "987100006", "Niño M");
    await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { couponCode: cp.code, guardianLookup: "71000006" })).resolves.toBeTruthy(); // otra familia sí puede
  }, 300000);

  it("la BD rechaza cupones incoherentes", async () => {
    const cp = await coupon({ maxUses: 2 });
    await expect(db.$executeRaw`UPDATE "Coupon" SET "value" = 150 WHERE "id" = ${cp.id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "Coupon" SET "usesCount" = 3 WHERE "id" = ${cp.id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "Coupon" SET "maxUses" = 0 WHERE "id" = ${cp.id}`).rejects.toThrow();
    await db.coupon.update({ where: { id: cp.id }, data: { usesCount: 2 } });                                // permitido: 2 usos de 2
    await expect(updateCoupon(A, cp.id, { code: "XYZ1", type: "PERCENTAGE", value: 10, maxUses: 1, maxUsesPerGuardian: null, minPurchaseCents: 0 } as never)).rejects.toThrow(/menor a los usos/);
    await expect(createCoupon(A, uA, { code: "PCT", type: "PERCENTAGE", value: 101, maxUses: null, maxUsesPerGuardian: null, minPurchaseCents: 0 } as never)).rejects.toThrow();
  }, 240000);

  // ===== Canje de puntos =====
  it("canjea puntos como descuento: tasa, tope y saldo; un canje mayor al saldo se rechaza", async () => {
    const { g } = await family(A, "Madre Canje", "71000007", "987100007", "Niño R");
    await db.guardian.update({ where: { id: g.id }, data: { loyaltyPoints: 100 } });
    await db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "ADJUST", points: 100, balanceAfter: 100, note: "saldo de prueba" } });
    const p = await product(A, "Pizza", 100, 3000);
    const r = await sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000007", redeemPoints: 40 });
    expect(r.totalCents).toBe(2600);                                                                    // 40 puntos × S/ 0.10 = S/ 4.00 de descuento
    const s = await db.sale.findFirstOrThrow({ where: { id: r.saleId }, include: { items: true } });
    expect([s.pointsRedeemed, s.discountCents, s.pointsEarned]).toEqual([40, 400, 26]);
    expect(s.items.find((i) => i.kind === "POINTS_DISCOUNT")!.totalCents).toBe(-400);
    expect(await pts(g.id)).toBe(100 - 40 + 26);
    expect(await ledgerSum(g.id)).toBe(await pts(g.id));
    await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000007", redeemPoints: 9999 })).rejects.toThrow(/insuficientes/);
    await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { redeemPoints: 10 })).rejects.toThrow(/Identifica al apoderado/);
    await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "12345678", redeemPoints: 10 })).rejects.toThrow(/No se encontró/);
    const cap = await sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000007", redeemPoints: 86 });   // 86 pts = S/ 8.60, tope 50% de S/ 30.00 = S/ 15.00 → sin recorte
    expect(cap.totalCents).toBe(2140);
    expect(await pts(g.id)).toBeGreaterThanOrEqual(0);
  }, 300000);

  it("NUNCA saldo negativo: 5 canjes simultáneos de 40 puntos con saldo de 100 → como máximo los que alcanzan", async () => {
    const { g } = await family(A, "Madre Carrera", "71000008", "987100008", "Niño S");
    await db.guardian.update({ where: { id: g.id }, data: { loyaltyPoints: 100 } });
    await db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "ADJUST", points: 100, balanceAfter: 100 } });
    const p = await product(A, "Barra", 100, 1000);
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000008", redeemPoints: 40 })));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(2);                                                                                  // cada canje deja neto −34 (−40 + 6 ganados): 100 → 66 → 32 → ya no alcanza
    expect(await pts(g.id)).toBe(100 - 34 * ok);
    expect(await ledgerSum(g.id)).toBe(await pts(g.id));                                                // el libro cuadra siempre con el saldo
    expect((await db.loyaltyLedger.aggregate({ where: { guardianId: g.id }, _min: { balanceAfter: true } }))._min.balanceAfter).toBeGreaterThanOrEqual(0);
    expect(await db.sale.count({ where: { tenantId: A, loyaltyGuardianId: g.id, pointsRedeemed: 40 } })).toBe(ok);   // las rechazadas no dejaron venta
    expect((await db.product.findFirstOrThrow({ where: { id: p.id } })).stock).toBe(100 - ok);
  }, 300000);

  it("la BD impide saldo negativo y el libro es inmutable", async () => {
    const { g } = await family(A, "Madre BD", "71000009", "987100009", "Niño T");
    await expect(db.$executeRaw`UPDATE "Guardian" SET "loyaltyPoints" = -1 WHERE "id" = ${g.id}`).rejects.toThrow();
    const e = await db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "ADJUST", points: 0, balanceAfter: 0 } });
    await expect(db.loyaltyLedger.update({ where: { id: e.id }, data: { points: 999 } })).rejects.toThrow(/inmutable/i);
    await expect(db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "REDEEM", points: -5, balanceAfter: -5 } })).rejects.toThrow();
    const ev = await db.consentEvent.create({ data: { tenantId: A, guardianId: g.id, granted: true, source: "STAFF", evidence: "x" } });
    await expect(db.consentEvent.update({ where: { id: ev.id }, data: { granted: false } })).rejects.toThrow(/inmutable/i);
  }, 240000);

  it("una venta acredita puntos una sola vez (índice único) y el libro de otro tenant no se mezcla", async () => {
    const { g } = await family(A, "Madre Única", "71000010", "987100010", "Niño U");
    const p = await product(A, "Pan2", 100, 1000);
    const r = await sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000010" });
    await expect(db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "EARN", points: 10, balanceAfter: 20, saleId: r.saleId } })).rejects.toThrow();
    expect(await db.loyaltyLedger.count({ where: { guardianId: g.id, type: "EARN" } })).toBe(1);
    await expect(db.loyaltyLedger.create({ data: { tenantId: B, guardianId: g.id, type: "ADJUST", points: 0, balanceAfter: 0 } })).rejects.toThrow(); // FK compuesta: el apoderado es de A
    const pb = await product(B, "ProdB", 10, 1000);
    await expect(sale(B, uB, [{ productId: pb.id, quantity: 1 }], { guardianLookup: "71000010" })).rejects.toThrow(/No se encontró/);   // B no ve a las familias de A
  }, 240000);

  // ===== Vencimiento =====
  it("los puntos vencidos no se pueden canjear y el vencimiento ocurre una sola vez (idempotente, FIFO)", async () => {
    const { g } = await family(A, "Madre Vence", "71000011", "987100011", "Niño V");
    const old = new Date(Date.now() - 400 * 86_400_000), recent = new Date(Date.now() - 10 * 86_400_000);
    await db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "EARN", points: 60, balanceAfter: 60, expiresAt: new Date(Date.now() - 35 * 86_400_000), createdAt: old } });
    await db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "EARN", points: 40, balanceAfter: 100, expiresAt: new Date(Date.now() + 355 * 86_400_000), createdAt: recent } });
    await db.guardian.update({ where: { id: g.id }, data: { loyaltyPoints: 100 } });
    expect((await loyaltyBalance(A, g.id)).available).toBe(40);
    const p = await product(A, "Torta2", 100, 5000);
    await expect(sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000011", redeemPoints: 50 })).rejects.toThrow(/insuficientes \(disponibles: 40\)/);
    expect(await pts(g.id)).toBe(100);                                                                  // el rechazo revierte TODA la transacción (también el vencimiento): el saldo almacenado no cambia
    expect((await loyaltyBalance(A, g.id)).available).toBe(40);                                         // pero lo vencido nunca está disponible
    const r1 = await expireAllDue(new Date(), 2000), r2 = await expireAllDue(new Date(), 2000);
    expect(r1.pointsExpired).toBeGreaterThanOrEqual(60);                                                // la tarea diaria lo vence...
    expect(r2.pointsExpired).toBe(0);                                                                   // ...una sola vez
    expect(await db.loyaltyLedger.count({ where: { guardianId: g.id, type: "EXPIRE" } })).toBe(1);
    expect(await ledgerSum(g.id)).toBe(40);
    const ok = await sale(A, uA, [{ productId: p.id, quantity: 1 }], { guardianLookup: "71000011", redeemPoints: 40 });
    expect(ok.totalCents).toBe(4600);
  }, 300000);

  it("el vencimiento diario resta lo vencido sin tocar lo ya canjeado", async () => {
    const { g } = await family(A, "Madre Cron", "71000012", "987100012", "Niño W");
    const t0 = new Date(Date.now() - 400 * 86_400_000);
    await db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "EARN", points: 100, balanceAfter: 100, expiresAt: new Date(Date.now() - 35 * 86_400_000), createdAt: t0 } });
    await db.loyaltyLedger.create({ data: { tenantId: A, guardianId: g.id, type: "REDEEM", points: -30, balanceAfter: 70, createdAt: new Date(t0.getTime() + 86_400_000) } });
    await db.guardian.update({ where: { id: g.id }, data: { loyaltyPoints: 70 } });
    const r = await expireAllDue(new Date(), 500);
    expect(r.pointsExpired).toBeGreaterThanOrEqual(70);
    expect(await pts(g.id)).toBe(0);
    const e = await db.loyaltyLedger.findFirstOrThrow({ where: { guardianId: g.id, type: "EXPIRE" } });
    expect([e.points, e.balanceAfter]).toEqual([-70, 0]);                                               // vencen solo los 70 que quedaban
    expect(await ledgerSum(g.id)).toBe(0);
  }, 300000);

  // ===== Consentimiento (Ley 29733) =====
  it("consentimiento: exige constancia cuando lo registra el personal, es idempotente y deja prueba inmutable", async () => {
    const { g } = await family(A, "Madre Consent", "71000013", "987100013", "Niño X");
    await expect(setMarketingConsent({ tenantId: A, guardianId: g.id, granted: true, source: "STAFF", recordedById: uA })).rejects.toThrow(ConsentError);
    await expect(setMarketingConsent({ tenantId: A, guardianId: g.id, granted: true, source: "FORM", evidence: " ", recordedById: uA })).rejects.toThrow(/cómo se obtuvo/);
    expect((await db.guardian.findFirstOrThrow({ where: { id: g.id } })).marketingConsent).toBe(false);          // por defecto NO hay consentimiento
    expect(await setMarketingConsent({ tenantId: A, guardianId: g.id, granted: true, source: "FORM", evidence: "Formulario firmado en recepción", recordedById: uA })).toBe(true);
    expect(await setMarketingConsent({ tenantId: A, guardianId: g.id, granted: true, source: "FORM", evidence: "otra vez", recordedById: uA })).toBe(false);   // sin duplicar la prueba
    let k = await db.guardian.findFirstOrThrow({ where: { id: g.id } });
    expect([k.marketingConsent, k.marketingConsentSource, k.marketingConsentById, k.marketingConsentAt !== null, k.marketingRevokedAt]).toEqual([true, "FORM", uA, true, null]);
    expect(await setMarketingConsent({ tenantId: A, guardianId: g.id, granted: false, source: "STAFF", recordedById: uA })).toBe(true);
    k = await db.guardian.findFirstOrThrow({ where: { id: g.id } });
    expect([k.marketingConsent, k.marketingRevokedAt !== null]).toEqual([false, true]);
    expect(await db.consentEvent.count({ where: { guardianId: g.id } })).toBe(2);
    expect(await setMarketingConsent({ tenantId: A, guardianId: g.id, granted: true, source: "PORTAL" })).toBe(true);        // el propio titular desde el portal: sin evidencia adicional
    expect((await db.guardian.findFirstOrThrow({ where: { id: g.id } })).marketingRevokedAt).toBeNull();
    await expect(setMarketingConsent({ tenantId: B, guardianId: g.id, granted: true, source: "PORTAL" })).rejects.toThrow(/no encontrado/);   // otro tenant no puede tocar al apoderado
  }, 300000);

  // ===== Segmentación y campañas =====
  it("segmentación: solo apoderados con consentimiento vigente; el resto se cuenta como excluido; nunca de otro tenant", async () => {
    const month = Number(limaDate().slice(5, 7)), y = new Date().getUTCFullYear() - 6;
    const bday = new Date(Date.UTC(y, month - 1, 15));
    const other = new Date(Date.UTC(y, (month % 12), 15));
    const yes = await family(A, "Madre Sí", "71100001", "987200001", "Luna Cumple", { birthDate: bday }, true);
    await family(A, "Madre No", "71100002", "987200002", "Sol Cumple", { birthDate: bday }, false);
    const rev = await family(A, "Madre Revocó", "71100003", "987200003", "Mar Cumple", { birthDate: bday }, true);
    await setMarketingConsent({ tenantId: A, guardianId: rev.g.id, granted: false, source: "STAFF" });
    await family(A, "Madre Otro Mes", "71100004", "987200004", "Rio Otro", { birthDate: other }, true);
    await family(B, "Madre B", "71100005", "987200005", "Kid B", { birthDate: bday }, true);
    const aud = await segmentAudience(A, { segment: "BIRTHDAY_MONTH", inactiveDays: 30, prepaidMinutesBelow: 60 });
    expect(aud.eligible.map((a) => a.guardianId)).toEqual([yes.g.id]);
    expect(aud.eligible[0]).toMatchObject({ childFirstName: "Luna", phoneDigits: "987200001" });
    expect(aud.excludedNoConsent).toBe(2);
    expect(JSON.stringify(aud)).not.toContain("Madre B");                                              // el apoderado de B jamás aparece
    // cuponera por agotarse
    const low = await family(A, "Madre Low", "71100006", "987200006", "Pablo Low", { prepaidMinutes: 25 }, true);
    await family(A, "Madre Mucho", "71100007", "987200007", "Ana Mucho", { prepaidMinutes: 500 }, true);
    await family(A, "Madre Cero", "71100008", "987200008", "Zoe Cero", { prepaidMinutes: 0 }, true);
    const pl = await segmentAudience(A, { segment: "PREPAID_LOW", inactiveDays: 30, prepaidMinutesBelow: 60 });
    expect(pl.eligible.map((a) => [a.guardianId, a.extraValue])).toEqual([[low.g.id, "25"]]);
    // inactivos: actividad hace 40 días sin matrícula activa
    const ina = await family(A, "Madre Inactiva", "71100009", "987200009", "Iris Inactiva", {}, true);
    const act = await family(A, "Madre Activa", "71100010", "987200010", "Axel Activo", {}, true);
    const enr = await family(A, "Madre Matriculada", "71100011", "987200011", "Mia Matriculada", {}, true);
    const cs = await db.cashRegisterSession.findFirstOrThrow({ where: { tenantId: A } });
    const mk = (childId: string, daysAgo: number) => db.sale.create({ data: { tenantId: A, cashRegisterSessionId: cs.id, kind: "POS", totalCents: 100, cashCents: 100, childId, createdById: uA, createdAt: new Date(Date.now() - daysAgo * 86_400_000) } });
    await mk(ina.c.id, 40); await mk(act.c.id, 3); await mk(enr.c.id, 60);
    await db.enrollment.create({ data: { tenantId: A, childId: enr.c.id, schoolYear: 2026, startDate: "2026-01-05", monthlyFeeCents: 100, createdById: uA } });
    const ia = await segmentAudience(A, { segment: "INACTIVE", inactiveDays: 30, prepaidMinutesBelow: 60 });
    expect(ia.eligible.map((a) => a.guardianId)).toEqual([ina.g.id]);
  }, 400000);

  it("campaña: solo a consentidos, plantilla con parámetros reales, sin duplicados, y el consentimiento se re-comprueba al ENVIAR", async () => {
    await db.campaign.deleteMany({ where: { tenantId: A } });
    const month = Number(limaDate().slice(5, 7)), bday = new Date(Date.UTC(new Date().getUTCFullYear() - 5, month - 1, 20));
    const a = await family(A, "Ana Campaña", "71200001", "987300001", "Lucía Cumple", { birthDate: bday }, true);
    const b = await family(A, "Beto Campaña", "71200002", "987300002", "Mateo Cumple", { birthDate: bday }, true);
    await family(A, "Sin Consentimiento", "71200003", "987300003", "Nico Cumple", { birthDate: bday }, false);
    const cp = await coupon({ value: 15 });
    const camp = await createCampaign(A, uA, { name: "Cumpleaños de marzo", segment: "BIRTHDAY_MONTH", templateName: "promo_cumple", couponCode: cp.code } as never);
    const g = graph();
    const st = await startCampaign(A, camp.id);
    expect(st.recipients).toBeGreaterThanOrEqual(2);
    await expect(startCampaign(A, camp.id)).rejects.toThrow(/ya se inició/);                           // no se puede iniciar dos veces
    await setMarketingConsent({ tenantId: A, guardianId: b.g.id, granted: false, source: "STAFF" });    // Beto revoca DESPUÉS de la vista previa
    const r1 = await sendBatch(A, camp.id, { limit: 50, fetchImpl: g.impl });
    const r2 = await sendBatch(A, camp.id, { limit: 50, fetchImpl: g.impl });                           // segunda ejecución: no vuelve a enviar
    expect(r2.sent).toBe(0);
    const to = g.calls.map((c) => c.to);
    expect(to).toContain("51987300001"); expect(to).not.toContain("51987300002"); expect(to).not.toContain("51987300003");
    expect(new Set(to).size).toBe(to.length);                                                           // un mensaje por apoderado
    const mine = g.calls.find((c) => c.to === "51987300001")!;
    expect(mine.template!.name).toBe("promo_cumple");
    expect(mine.template!.components[0]!.parameters.map((p) => p.text)).toEqual(["Ana", "Lucía", cp.code]);
    const rb = await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: camp.id, guardianId: b.g.id } });
    expect([rb.status, rb.reason]).toEqual(["SKIPPED", "Sin consentimiento comercial vigente"]);
    expect(r1.skipped).toBeGreaterThanOrEqual(1);
    expect((await db.campaign.findFirstOrThrow({ where: { id: camp.id } })).status).toBe("SENT");
    expect((await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, purpose: "CAMPAIGN", conversation: { waId: "51987300001" } } })).templateName).toBe("promo_cumple");
    // tope de frecuencia: otra campaña esta semana no vuelve a escribirle
    const camp2 = await createCampaign(A, uA, { name: "Segunda", segment: "BIRTHDAY_MONTH", templateName: "promo_cumple" } as never);
    await startCampaign(A, camp2.id);
    const g2 = graph(); await sendBatch(A, camp2.id, { limit: 50, fetchImpl: g2.impl });
    expect(g2.calls.map((c) => c.to)).not.toContain("51987300001");
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: camp2.id, guardianId: a.g.id } })).reason).toMatch(/últimos 7 días/);
  }, 480000);

  it("campaña: falla de Meta, cancelación, validaciones y aislamiento", async () => {
    const month = Number(limaDate().slice(5, 7)), bday = new Date(Date.UTC(new Date().getUTCFullYear() - 4, month - 1, 5));
    await family(A, "Carla Falla", "71300001", "987400001", "Kai Cumple", { birthDate: bday }, true);
    await expect(createCampaign(A, uA, { name: "x", segment: "BIRTHDAY_MONTH", templateName: "Plantilla Inválida" } as never)).rejects.toThrow();
    await expect(createCampaign(A, uA, { name: "Con cupón falso", segment: "INACTIVE", templateName: "promo", couponCode: "NOEXISTE" } as never)).rejects.toThrow(/cupón/);
    const camp = await createCampaign(A, uA, { name: "Falla de Meta", segment: "BIRTHDAY_MONTH", templateName: "promo_falla" } as never);
    await startCampaign(A, camp.id);
    const failing = (async () => new Response(JSON.stringify({ error: { message: "plantilla no existe", code: 132001 } }), { status: 400 })) as unknown as Fetch;
    const r = await sendBatch(A, camp.id, { limit: 50, fetchImpl: failing });
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect((await db.campaignRecipient.findFirst({ where: { campaignId: camp.id, status: "FAILED" } }))!.reason).toBeTruthy();
    const camp3 = await createCampaign(A, uA, { name: "Cancelada", segment: "PREPAID_LOW", templateName: "promo_x" } as never);
    await startCampaign(A, camp3.id); await cancelCampaign(A, camp3.id);
    expect((await sendBatch(A, camp3.id, { fetchImpl: graph().impl })).sent).toBe(0);
    await expect(cancelCampaign(B, camp3.id)).rejects.toThrow(/no se puede cancelar/);                 // otro tenant no puede cancelar
    await expect(startCampaign(B, (await createCampaign(A, uA, { name: "De A", segment: "INACTIVE", templateName: "promo_y" } as never)).id)).rejects.toThrow(/no encontrada/);
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { enabled: false } });
    await expect(startCampaign(A, (await createCampaign(A, uA, { name: "Sin WA", segment: "INACTIVE", templateName: "promo_z" } as never)).id)).rejects.toThrow(/WhatsApp no está activo/);
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { enabled: true } });
  }, 480000);

  // ===== Baja por WhatsApp =====
  it("la palabra «BAJA» por WhatsApp revoca el consentimiento (con prueba) solo del establecimiento correcto", async () => {
    const mine = await guardian(A, "Madre Baja", "71400001", "987500001", true);
    const twin = await guardian(B, "Madre Gemela B", "71400002", "987500001", true);       // mismo teléfono en OTRO establecimiento
    const keep = await guardian(A, "Madre Sigue", "71400003", "987500002", true);
    const mkMsg = (text: string, id: string) => { const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PID }, contacts: [{ profile: { name: "X" }, wa_id: "51987500001" }], messages: [{ from: "51987500001", id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] })); return { raw, sig: signBody(SECRET, raw) }; };
    const normal = mkMsg("hola, quiero información", `wamid.${tag}.n1`);
    const r0 = await handleWebhookPost(normal.raw, normal.sig);
    expect(r0.jobs![0]!.optOutRevoked).toBe(0);
    expect((await db.guardian.findFirstOrThrow({ where: { id: mine.id } })).marketingConsent).toBe(true);        // una frase normal NO revoca
    const bye = mkMsg("BAJA", `wamid.${tag}.n2`);
    const r1 = await handleWebhookPost(bye.raw, bye.sig);
    expect(r1.status).toBe(200); expect(r1.jobs![0]!.optOutRevoked).toBe(1);
    const k = await db.guardian.findFirstOrThrow({ where: { id: mine.id } });
    expect([k.marketingConsent, k.marketingRevokedAt !== null]).toEqual([false, true]);
    const ev = await db.consentEvent.findFirstOrThrow({ where: { guardianId: mine.id, granted: false } });
    expect([ev.source, ev.evidence]).toEqual(["WHATSAPP", "Mensaje de baja recibido por WhatsApp"]);
    expect((await db.guardian.findFirstOrThrow({ where: { id: twin.id } })).marketingConsent).toBe(true);        // el gemelo de OTRO tenant no se toca
    expect((await db.guardian.findFirstOrThrow({ where: { id: keep.id } })).marketingConsent).toBe(true);        // otro teléfono, tampoco
    expect((await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, waMessageId: `wamid.${tag}.n2` } })).botHandledAt).not.toBeNull(); // el bot no la contesta
    const dup = await handleWebhookPost(bye.raw, bye.sig);                                                      // reintento de Meta: idempotente
    expect(dup.jobs).toEqual([]);
    expect(await db.consentEvent.count({ where: { guardianId: mine.id, granted: false } })).toBe(1);
    expect(await revokeByPhone(A, "51987500001")).toBe(0);                                                      // ya revocado
    // el cierre de caja sigue cuadrando con descuentos (los ítems negativos no rompen los totales)
    const closed = await closeCashSession(A, uA, 0);
    expect(closed.expectedCashCents).toBe((await db.sale.aggregate({ where: { tenantId: A, cashRegisterSessionId: closed.sessionId }, _sum: { cashCents: true } }))._sum.cashCents);
  }, 300000);
});
