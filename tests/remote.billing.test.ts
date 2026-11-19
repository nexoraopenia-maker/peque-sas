import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { insertSessionIfCapacity } from "@/lib/playground/checkin";
import {
  BillingError, addConsumption, checkoutPlayground, closeCashSession, generateInvoices, getOpenSession,
  openCashSession, payInvoice, posSale, quotePlayground, sellPrepaidPackage, sessionTotals,
} from "@/lib/billing/service";

// Contra Turso remoto (RUN_REMOTE_TESTS=1). Crea datos con prefijo único y los borra al terminar.
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__bill_${Date.now()}`;
let planId = "", A = "", B = "", uA = "", uB = "";
const cash = { first: "EFECTIVO" as const, firstAmountCents: null };
const key = () => `${tag}-${Math.random().toString(36).slice(2)}`;

async function mkChild(tenantId: string, name: string) { return db.child.create({ data: { tenantId, fullName: name } }); }
async function mkProduct(tenantId: string, name: string, stock: number, priceCents: number) { return db.product.create({ data: { tenantId, name, stock, priceCents } }); }
async function balanceMatchesLedger(tenantId: string, childId: string) {
  const c = await db.child.findFirstOrThrow({ where: { id: childId, tenantId } });
  const s = await db.prepaidLedger.aggregate({ where: { tenantId, childId }, _sum: { minutes: true } });
  expect(c.prepaidMinutes).toBe(s._sum.minutes ?? 0);
  return c.prepaidMinutes;
}

run("Fase 8: caja, cuponeras y cobros (Turso remoto)", () => {
  beforeAll(async () => {
    planId = (await db.plan.create({ data: { name: tag, modules: [] } })).id;
    A = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId, modules: ["WHATSAPP"] } })).id;
    B = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId, modules: ["WHATSAPP"] } })).id;
    uA = (await db.user.create({ data: { email: `${tag}-a@example.test`, name: "a", role: "RECEPTION", tenantId: A, passwordHash: "x" } })).id;
    uB = (await db.user.create({ data: { email: `${tag}-b@example.test`, name: "b", role: "RECEPTION", tenantId: B, passwordHash: "x" } })).id;
  }, 90000);

  afterAll(async () => {
    const ids = [A, B];
    const w = { where: { tenantId: { in: ids } } };
    await db.saleItem.deleteMany(w); await db.sale.deleteMany(w); await db.prepaidLedger.deleteMany(w);
    await db.playgroundConsumption.deleteMany(w); await db.playgroundSession.deleteMany(w); await db.playgroundRate.deleteMany(w);
    await db.daycareInvoice.deleteMany(w); await db.enrollment.deleteMany(w); await db.stockMovement.deleteMany(w);
    await db.product.deleteMany(w); await db.prepaidPackage.deleteMany(w); await db.cashRegisterSession.deleteMany(w);
    await db.auditLog.deleteMany(w); await db.child.deleteMany(w); await db.user.deleteMany(w);
    await db.tenant.deleteMany({ where: { id: { in: ids } } }); await db.plan.deleteMany({ where: { id: planId } });
  }, 120000);

  it("sin turno abierto no se puede cobrar y no queda NADA a medias", async () => {
    const p = await mkProduct(A, "sin-turno", 5, 300);
    await expect(posSale({ tenantId: A, userId: uA, lines: [{ productId: p.id, quantity: 1 }], pay: cash, idempotencyKey: key() })).rejects.toThrow(/turno de caja abierto/);
    expect(await db.sale.count({ where: { tenantId: A } })).toBe(0);
    expect((await db.product.findFirstOrThrow({ where: { id: p.id } })).stock).toBe(5); // el stock no se tocó
  }, 90000);

  it("un solo turno abierto por establecimiento; otro establecimiento abre el suyo", async () => {
    await openCashSession(A, uA, 10000);
    await expect(openCashSession(A, uA, 5)).rejects.toThrow(/ya hay un turno/i);
    await expect(openCashSession(B, uB, 2000)).resolves.toBeTruthy();
    await expect(openCashSession(A, uA, -1)).rejects.toThrow();
  }, 90000);

  it("la BD rechaza ventas cuyo desglose no suma el total y saldos negativos", async () => {
    const s = await getOpenSession(A);
    await expect(db.$executeRaw`INSERT INTO "Sale" ("id","tenantId","cashRegisterSessionId","kind","totalCents","cashCents","createdById","createdAt") VALUES (${key()}, ${A}, ${s!.id}, 'POS', 1000, 500, ${uA}, ${new Date().toISOString()})`).rejects.toThrow();
    const c = await mkChild(A, "neg");
    await expect(db.$executeRaw`UPDATE "Child" SET "prepaidMinutes" = -1 WHERE "id" = ${c.id}`).rejects.toThrow();
  }, 90000);

  it("compra de cuponera: venta + saldo + libro atómicos, pago mixto e idempotencia", async () => {
    const child = await mkChild(A, "cupon");
    const pkg = await db.prepaidPackage.create({ data: { tenantId: A, name: "300", minutes: 300, priceCents: 15000 } });
    const k = key();
    const r = await sellPrepaidPackage({ tenantId: A, userId: uA, childId: child.id, packageId: pkg.id, pay: { first: "EFECTIVO", firstAmountCents: 5000, second: "YAPE_PLIN" }, idempotencyKey: k });
    expect(r.balance).toBe(300);
    const sale = await db.sale.findFirstOrThrow({ where: { id: r.saleId, tenantId: A } });
    expect([sale.totalCents, sale.cashCents, sale.yapePlinCents]).toEqual([15000, 5000, 10000]);
    // reintento con la misma clave (doble clic): no duplica venta ni saldo
    await expect(sellPrepaidPackage({ tenantId: A, userId: uA, childId: child.id, packageId: pkg.id, pay: cash, idempotencyKey: k })).rejects.toThrow(/duplicada/);
    expect(await balanceMatchesLedger(A, child.id)).toBe(300);
    expect(await db.sale.count({ where: { tenantId: A, childId: child.id } })).toBe(1);
    await expect(db.prepaidLedger.updateMany({ where: { childId: child.id }, data: { minutes: 9999 } })).rejects.toThrow(/inmutable/i);
    // pago parcial sin segundo método es inválido y no deja rastro
    await expect(sellPrepaidPackage({ tenantId: A, userId: uA, childId: child.id, packageId: pkg.id, pay: { first: "EFECTIVO", firstAmountCents: 100, second: null }, idempotencyKey: key() })).rejects.toThrow(BillingError);
    expect(await balanceMatchesLedger(A, child.id)).toBe(300);
  }, 120000);

  it("checkout de ludoteca: tarifa + excedente + consumos − cuponera, en un solo comprobante", async () => {
    const child = await mkChild(A, "ludo");
    const pkg = await db.prepaidPackage.create({ data: { tenantId: A, name: "30", minutes: 30, priceCents: 1000 } });
    await sellPrepaidPackage({ tenantId: A, userId: uA, childId: child.id, packageId: pkg.id, pay: cash, idempotencyKey: key() });
    const rate = await db.playgroundRate.create({ data: { tenantId: A, name: "1h", minutes: 60, priceCents: 2000, extraMinuteCents: 50 } });
    const prod = await mkProduct(A, "jugo", 10, 300);
    const id = await insertSessionIfCapacity(db, { tenantId: A, childId: child.id, rateId: rate.id, braceletCode: "C1", userId: uA, contractedMinutes: 60, basePriceCents: 2000, extraMinuteCents: 50 });
    await db.playgroundSession.update({ where: { id: id! }, data: { checkInAt: new Date(Date.now() - 69.5 * 60000) } });
    await addConsumption({ tenantId: A, userId: uA, sessionId: id!, productId: prod.id, quantity: 2 });
    expect((await db.product.findFirstOrThrow({ where: { id: prod.id } })).stock).toBe(8);

    const q = await quotePlayground(A, id!);
    expect(q.extraMinutes).toBe(10);
    expect(q.prepaidMinutesUsed).toBe(30);
    expect(q.totalCents).toBe(2000 + 500 - 1000 + 600); // 2100
    const r = await checkoutPlayground({ tenantId: A, userId: uA, sessionId: id!, pay: { first: "EFECTIVO", firstAmountCents: 1000, second: "TARJETA" }, pickup: { kind: "GUARDIAN", refId: "x", name: "Mamá" } });
    expect(r.totalCents).toBe(2100);
    const sale = await db.sale.findFirstOrThrow({ where: { id: r.saleId, tenantId: A }, include: { items: true } });
    expect([sale.cashCents, sale.cardCents]).toEqual([1000, 1100]);
    expect(sale.items.reduce((n, i) => n + i.totalCents, 0)).toBe(2100);
    expect(sale.items.map((i) => i.kind).sort()).toEqual(["BASE_RATE", "EXTRA_MINUTES", "PREPAID_CREDIT", "PRODUCT"]);
    expect((await db.playgroundSession.findFirstOrThrow({ where: { id: id! } })).status).toBe("CLOSED");
    expect(await balanceMatchesLedger(A, child.id)).toBe(0); // consumió los 30 min
    await expect(checkoutPlayground({ tenantId: A, userId: uA, sessionId: id!, pay: cash, pickup: { kind: "GUARDIAN", refId: "x", name: "Mamá" } })).rejects.toThrow(/cerrada/);
  }, 180000);

  it("doble cobro: dos salidas simultáneas de la misma sesión generan UNA venta y UN consumo", async () => {
    const child = await mkChild(A, "doble");
    const pkg = await db.prepaidPackage.create({ data: { tenantId: A, name: "60", minutes: 60, priceCents: 1 } });
    await sellPrepaidPackage({ tenantId: A, userId: uA, childId: child.id, packageId: pkg.id, pay: cash, idempotencyKey: key() });
    const rate = await db.playgroundRate.create({ data: { tenantId: A, name: "r", minutes: 60, priceCents: 2000, extraMinuteCents: 0 } });
    const id = await insertSessionIfCapacity(db, { tenantId: A, childId: child.id, rateId: rate.id, braceletCode: "D1", userId: uA, contractedMinutes: 60, basePriceCents: 2000, extraMinuteCents: 0 });
    const go = () => checkoutPlayground({ tenantId: A, userId: uA, sessionId: id!, pay: cash, pickup: { kind: "GUARDIAN", refId: "x", name: "P" } });
    const res = await Promise.allSettled([go(), go(), go()]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.sale.count({ where: { tenantId: A, playgroundSessionId: id! } })).toBe(1);
    expect(await db.prepaidLedger.count({ where: { tenantId: A, playgroundSessionId: id!, type: "CONSUME" } })).toBe(1);
    expect(await balanceMatchesLedger(A, child.id)).toBe(0);
  }, 180000);

  it("atomicidad: si falla un paso (stock insuficiente) se revierte TODO, incluida la venta", async () => {
    const p1 = await mkProduct(A, "ok", 5, 100);
    const p2 = await mkProduct(A, "poco", 1, 100);
    const before = await db.sale.count({ where: { tenantId: A } });
    await expect(posSale({ tenantId: A, userId: uA, lines: [{ productId: p1.id, quantity: 2 }, { productId: p2.id, quantity: 3 }], pay: cash, idempotencyKey: key() })).rejects.toThrow(/Stock insuficiente/);
    expect(await db.sale.count({ where: { tenantId: A } })).toBe(before);
    expect((await db.product.findFirstOrThrow({ where: { id: p1.id } })).stock).toBe(5);
    expect((await db.product.findFirstOrThrow({ where: { id: p2.id } })).stock).toBe(1);
    const ok = await posSale({ tenantId: A, userId: uA, lines: [{ productId: p1.id, quantity: 2 }], pay: { first: "TRANSFERENCIA", firstAmountCents: null }, idempotencyKey: key() });
    expect(ok.totalCents).toBe(200);
    expect((await db.product.findFirstOrThrow({ where: { id: p1.id } })).stock).toBe(3);
  }, 180000);

  it("mensualidades: generación idempotente y pago único aun con cobros simultáneos", async () => {
    const child = await mkChild(A, "guard");
    await db.enrollment.create({ data: { tenantId: A, childId: child.id, schoolYear: 2026, startDate: "2026-01-05", monthlyFeeCents: 35000, createdById: uA } });
    const g1 = await generateInvoices(A, "2026-03");
    const g2 = await generateInvoices(A, "2026-03");
    expect(g1.created).toBe(1);
    expect(g2.created).toBe(0);
    const inv = await db.daycareInvoice.findFirstOrThrow({ where: { tenantId: A, childId: child.id, period: "2026-03" } });
    const res = await Promise.allSettled([1, 2, 3].map(() => payInvoice({ tenantId: A, userId: uA, invoiceId: inv.id, pay: cash, idempotencyKey: key() })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.sale.count({ where: { tenantId: A, kind: "DAYCARE_FEE", childId: child.id } })).toBe(1);
    expect((await db.daycareInvoice.findFirstOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
  }, 180000);

  it("aislamiento: B no puede cobrar ni afectar datos de A", async () => {
    const inv = await db.daycareInvoice.create({ data: { tenantId: A, enrollmentId: (await db.enrollment.findFirstOrThrow({ where: { tenantId: A } })).id, childId: "x", period: "2026-04", amountCents: 100, dueDate: "2026-04-05" } });
    await expect(payInvoice({ tenantId: B, userId: uB, invoiceId: inv.id, pay: cash, idempotencyKey: key() })).rejects.toThrow(/no encontrada/);
    const childA = await mkChild(A, "ajeno");
    const pkgA = await db.prepaidPackage.create({ data: { tenantId: A, name: "x", minutes: 10, priceCents: 1 } });
    await expect(sellPrepaidPackage({ tenantId: B, userId: uB, childId: childA.id, packageId: pkgA.id, pay: cash, idempotencyKey: key() })).rejects.toThrow(/no válidos/);
    const prodA = await mkProduct(A, "pa", 5, 100);
    await expect(posSale({ tenantId: B, userId: uB, lines: [{ productId: prodA.id, quantity: 1 }], pay: cash, idempotencyKey: key() })).rejects.toThrow(/no válido/);
    expect(await db.sale.count({ where: { tenantId: B } })).toBe(0);
    expect((await sessionTotals(B, (await getOpenSession(B))!.id)).count).toBe(0);
  }, 180000);

  it("cierre de caja: totales por método, esperado, diferencia; ventas simultáneas no se pierden y nada entra después", async () => {
    const before = await getOpenSession(A);
    const p = await mkProduct(A, "conc", 100, 100);
    const sales = Array.from({ length: 6 }, () => posSale({ tenantId: A, userId: uA, lines: [{ productId: p.id, quantity: 1 }], pay: cash, idempotencyKey: key() }));
    const closing = closeCashSession(A, uA, 0);
    const [closed, ...results] = await Promise.allSettled([closing, ...sales]);
    expect(closed.status).toBe("fulfilled");
    const s = await db.cashRegisterSession.findFirstOrThrow({ where: { id: before!.id } });
    expect(s.status).toBe("CLOSED");
    // invariante: los totales guardados coinciden con las ventas realmente registradas en ese turno
    const agg = await db.sale.aggregate({ where: { tenantId: A, cashRegisterSessionId: s.id }, _sum: { cashCents: true, yapePlinCents: true, cardCents: true, transferCents: true }, _count: true });
    expect(s.cashSalesCents).toBe(agg._sum.cashCents ?? 0);
    expect(s.cardSalesCents).toBe(agg._sum.cardCents ?? 0);
    expect(s.transferSalesCents).toBe(agg._sum.transferCents ?? 0);
    expect(s.yapePlinSalesCents).toBe(agg._sum.yapePlinCents ?? 0);
    expect(s.expectedCashCents).toBe(10000 + (agg._sum.cashCents ?? 0)); // solo efectivo suma a la caja física
    expect(s.differenceCents).toBe(0 - s.expectedCashCents!);
    expect(s.declaredCashCents).toBe(0);
    // las ventas que no entraron fallaron por falta de turno, y solo esas
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.every((f) => /turno de caja abierto/.test(String(f.reason?.message)))).toBe(true);
    expect(await db.sale.count({ where: { tenantId: A, cashRegisterSessionId: s.id, kind: "POS", createdAt: { gt: s.closedAt! } } })).toBe(0);
    expect(ok + failed.length).toBe(6);
    // ya cerrado: no se cobra, no se vuelve a cerrar
    await expect(posSale({ tenantId: A, userId: uA, lines: [{ productId: p.id, quantity: 1 }], pay: cash, idempotencyKey: key() })).rejects.toThrow(/turno de caja abierto/);
    await expect(closeCashSession(A, uA, 0)).rejects.toThrow(/No hay turno/);
    // el turno de B sigue abierto e intacto
    expect((await getOpenSession(B))?.status).toBe("OPEN");
  }, 240000);
});
