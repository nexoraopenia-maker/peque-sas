import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { closeCashSession, openCashSession, posSale } from "@/lib/billing/service";
import { createExpense, listExpenses, voidExpense, type NewExpense } from "@/lib/expenses/service";
import { getReport } from "@/lib/reports/service";
import { summaryCsv, expensesCsv, summaryPdf } from "@/lib/reports/export";
import { limaDate } from "@/lib/utils/date";

// Contra Turso remoto (RUN_REMOTE_TESTS=1).
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__exp_${Date.now()}`;
let planId = "", A = "", B = "", uA = "", uB = "", seq = 0;
const key = () => `${tag}-${++seq}-${Math.random().toString(36).slice(2)}`;
const today = () => limaDate();
const exp = (over: Partial<NewExpense> = {}, tenant = A, user = uA) =>
  createExpense({ tenantId: tenant, userId: user, canManage: true, category: "OPERATING_SUPPLIES", source: "CASH_DRAWER", amountCents: 1000, description: "Gasto de prueba", idempotencyKey: key(), ...over });
const session = (t = A) => db.cashRegisterSession.findFirstOrThrow({ where: { tenantId: t, status: "OPEN" } });
const product = (tenantId: string, priceCents: number) => db.product.create({ data: { tenantId, name: `P${++seq}`, stock: 1000, priceCents } });
const sell = async (tenantId: string, userId: string, productId: string, method: "EFECTIVO" | "TARJETA" = "EFECTIVO") =>
  posSale({ tenantId, userId, lines: [{ productId, quantity: 1 }], pay: { first: method, firstAmountCents: null }, idempotencyKey: key() });
const wipe = async (ids: string[]) => {
  const w = { where: { tenantId: { in: ids } } };
  for (const m of ["expense", "saleItem", "sale", "stockMovement", "product", "cashRegisterSession", "auditLog", "user"] as const) await (db[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany(w);
};

run("Fase 14: gastos, caja y reportes (Turso remoto)", () => {
  beforeAll(async () => {
    planId = (await db.plan.create({ data: { name: tag, modules: [] } })).id;
    A = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId, modules: [] } })).id;
    B = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId, modules: [] } })).id;
    uA = (await db.user.create({ data: { email: `${tag}-a@example.test`, name: "a", role: "ADMIN", tenantId: A, passwordHash: "x" } })).id;
    uB = (await db.user.create({ data: { email: `${tag}-b@example.test`, name: "b", role: "ADMIN", tenantId: B, passwordHash: "x" } })).id;
  }, 120000);
  afterAll(async () => { await wipe([A, B]); await db.tenant.deleteMany({ where: { id: { in: [A, B] } } }); await db.plan.deleteMany({ where: { id: planId } }); }, 120000);

  it("sin turno abierto no se paga del cajón, pero sí por otros medios (sin tocar la caja)", async () => {
    await expect(exp()).rejects.toThrow(/No hay turno de caja abierto/);
    expect(await db.expense.count({ where: { tenantId: A } })).toBe(0);
    for (const source of ["CASH_OTHER", "YAPE_PLIN", "CARD", "TRANSFER"] as const) {
      const r = await exp({ source, category: "RENT_UTILITIES", amountCents: 50_000 });
      const e = await db.expense.findFirstOrThrow({ where: { id: r.id } });
      expect([e.source, e.cashRegisterSessionId, e.amountCents, e.expenseDate]).toEqual([source, null, 50_000, today()]);
    }
  }, 120000);

  it("el gasto del cajón se liga al turno, baja el efectivo esperado y el cierre cuadra", async () => {
    await openCashSession(A, uA, 5000);
    const p = await product(A, 20_000); await sell(A, uA, p.id);                 // +S/200.00 en efectivo
    await sell(A, uA, p.id, "TARJETA");                                          // la tarjeta NO entra al cajón
    const r = await exp({ amountCents: 3000, description: "Compra de pañales" });
    const s = await session();
    expect(s.cashExpensesCents).toBe(3000);
    expect((await db.expense.findFirstOrThrow({ where: { id: r.id } })).cashRegisterSessionId).toBe(s.id);
    const closed = await closeCashSession(A, uA, 5000 + 20_000 - 3000);          // el cajero cuenta lo que realmente hay
    expect(closed.expectedCashCents).toBe(22_000);
    expect(closed.differenceCents).toBe(0);
    const row = await db.cashRegisterSession.findFirstOrThrow({ where: { id: closed.sessionId } });
    expect([row.cashExpensesCents, row.expectedCashCents, row.cashSalesCents]).toEqual([3000, 22_000, 20_000]);
    await expect(exp()).rejects.toThrow(/No hay turno de caja abierto/);        // tras cerrar ya no entra ningún gasto del cajón
  }, 240000);

  it("no se puede pagar más de lo que hay en el cajón y 5 gastos simultáneos no lo dejan en negativo", async () => {
    await openCashSession(A, uA, 10_000);                                        // cajón: S/100.00
    await expect(exp({ amountCents: 10_001 })).rejects.toThrow(/No hay suficiente efectivo/);
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => exp({ amountCents: 3000 })));
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(3);         // 3 × 30 = 90 ≤ 100; el cuarto ya no cabe
    expect(res.filter((x) => x.status === "rejected").every((x) => /No hay suficiente efectivo/.test(String((x as PromiseRejectedResult).reason?.message)))).toBe(true);
    const s = await session();
    expect(s.cashExpensesCents).toBe(9000);
    const rows = await db.expense.aggregate({ where: { tenantId: A, cashRegisterSessionId: s.id }, _sum: { amountCents: true }, _count: true });
    expect([rows._sum.amountCents, rows._count]).toEqual([9000, 3]);              // la suma de gastos = lo descontado del turno
    // un cobro en efectivo vuelve a darle margen al cajón
    const p = await product(A, 5000); await sell(A, uA, p.id);
    await expect(exp({ amountCents: 6000 })).resolves.toBeTruthy();
    expect((await session()).cashExpensesCents).toBe(15_000);
  }, 300000);

  it("anular: devuelve el efectivo al cajón con el turno abierto, es único y exige motivo", async () => {
    const p0 = await product(A, 5000); await sell(A, uA, p0.id);                 // el cajón quedó en cero: entra efectivo
    const s0 = (await session()).cashExpensesCents;
    const r = await exp({ amountCents: 500 });
    expect((await session()).cashExpensesCents).toBe(s0 + 500);
    await expect(voidExpense(A, uA, r.id, " ")).rejects.toThrow(/motivo/);
    await voidExpense(A, uA, r.id, "Se registró dos veces");
    expect((await session()).cashExpensesCents).toBe(s0);
    const e = await db.expense.findFirstOrThrow({ where: { id: r.id } });
    expect([e.voidReason, e.voidedById, e.voidedAt !== null]).toEqual(["Se registró dos veces", uA, true]);
    await expect(voidExpense(A, uA, r.id, "otra vez")).rejects.toThrow(/ya está anulado/);
    expect((await session()).cashExpensesCents).toBe(s0);                         // la segunda anulación no devolvió dinero de nuevo
    const dos = await exp({ amountCents: 700 });
    const res = await Promise.allSettled([voidExpense(A, uA, dos.id, "a"+"bc"), voidExpense(A, uA, dos.id, "xyz")]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);          // anulaciones simultáneas: solo una
    expect((await session()).cashExpensesCents).toBe(s0);
  }, 300000);

  it("un gasto del cajón de un turno CERRADO no se puede anular (y nada cambia); los demás sí", async () => {
    const p1 = await product(A, 10_000); await sell(A, uA, p1.id);
    const r = await exp({ amountCents: 1200 });
    const other = await exp({ source: "TRANSFER", category: "PERSONNEL", amountCents: 80_000 });
    const closed = await closeCashSession(A, uA, 0);
    const before = await db.cashRegisterSession.findFirstOrThrow({ where: { id: closed.sessionId } });
    await expect(voidExpense(A, uA, r.id, "intento tardío")).rejects.toThrow(/ya fue cerrado/);
    expect((await db.expense.findFirstOrThrow({ where: { id: r.id } })).voidedAt).toBeNull();   // la transacción se revirtió completa
    expect((await db.cashRegisterSession.findFirstOrThrow({ where: { id: closed.sessionId } })).cashExpensesCents).toBe(before.cashExpensesCents);
    await voidExpense(A, uA, other.id, "Pago duplicado por transferencia");                      // sin caja: se puede anular siempre
    expect((await db.expense.findFirstOrThrow({ where: { id: other.id } })).voidedAt).not.toBeNull();
  }, 300000);

  it("reglas del cajero en el servidor: solo insumos del cajón de hoy, hasta S/ 100.00", async () => {
    await openCashSession(A, uA, 100_000);
    const c = (o: Partial<NewExpense>) => exp({ canManage: false, ...o });
    await expect(c({ category: "PERSONNEL" })).rejects.toThrow(/propietario/);
    await expect(c({ source: "TRANSFER" })).rejects.toThrow(/cajón/);
    await expect(c({ amountCents: 10_001 })).rejects.toThrow(/mayores/);
    await expect(c({ expenseDate: "2026-01-01" })).rejects.toThrow(/de hoy/);
    await expect(c({ description: "ab" })).rejects.toThrow(/descripción/i);
    await expect(c({ amountCents: 10_000 })).resolves.toBeTruthy();
    await expect(exp({ expenseDate: "2999-01-01" })).rejects.toThrow(/futura/);
    expect(await db.expense.count({ where: { tenantId: A, amountCents: { in: [10_001] } } })).toBe(0);
  }, 240000);

  it("idempotencia: la misma clave (incluso simultánea) crea un solo gasto y un solo descuento de caja", async () => {
    const s0 = (await session()).cashExpensesCents, k = key();
    const res = await Promise.all([exp({ amountCents: 1100, idempotencyKey: k }), exp({ amountCents: 1100, idempotencyKey: k }), exp({ amountCents: 1100, idempotencyKey: k })]);
    expect(new Set(res.map((r) => r.id)).size).toBe(1);
    expect(res.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await db.expense.count({ where: { tenantId: A, idempotencyKey: k } })).toBe(1);
    expect((await session()).cashExpensesCents).toBe(s0 + 1100);
  }, 300000);

  it("la BD rechaza gastos incoherentes", async () => {
    const raw = (src: string, sess: string | null, amount: number) => db.$executeRaw`INSERT INTO "Expense" ("id","tenantId","category","description","amountCents","source","cashRegisterSessionId","expenseDate","createdById") VALUES (${`${tag}-raw-${++seq}`}, ${A}, 'PERSONNEL', 'x', ${amount}, ${src}, ${sess}, ${today()}, ${uA})`;
    const s = await session();
    await expect(raw("CASH_DRAWER", null, 100)).rejects.toThrow();               // cajón sin turno
    await expect(raw("TRANSFER", s.id, 100)).rejects.toThrow();                  // turno en un pago que no es del cajón
    await expect(raw("TRANSFER", null, 0)).rejects.toThrow();                    // monto 0
    await expect(raw("TRANSFER", null, -50)).rejects.toThrow();                  // monto negativo
    await expect(raw("BITCOIN", null, 100)).rejects.toThrow();                   // origen inválido
    await expect(db.$executeRaw`UPDATE "CashRegisterSession" SET "cashExpensesCents" = -1 WHERE "id" = ${s.id}`).rejects.toThrow();
    const r = await exp({ source: "CARD", amountCents: 100 });
    await expect(db.$executeRaw`UPDATE "Expense" SET "voidedAt" = ${new Date().toISOString()} WHERE "id" = ${r.id}`).rejects.toThrow();  // anulado sin motivo
  }, 240000);

  it("aislamiento entre establecimientos: no se ven, no se anulan, no suman en reportes", async () => {
    const mine = await exp({ source: "TRANSFER", category: "RENT_UTILITIES", amountCents: 123_456, description: "Alquiler local A" });
    await expect(voidExpense(B, uB, mine.id, "intento cruzado")).rejects.toThrow(/no encontrado/);
    expect((await db.expense.findFirstOrThrow({ where: { id: mine.id } })).voidedAt).toBeNull();
    expect(await listExpenses(B)).toEqual([]);
    expect((await listExpenses(A)).some((e) => e.id === mine.id)).toBe(true);
    await createExpense({ tenantId: B, userId: uB, canManage: true, category: "PERSONNEL", source: "TRANSFER", amountCents: 777, description: "Sueldo de B" });
    const rb = await getReport(B, today(), today(), "DAY");
    expect(rb.expenses.totalCents).toBe(777); expect(rb.expenses.byCategory.RENT_UTILITIES).toBe(0);
    expect(JSON.stringify(rb)).not.toContain("123456");
    expect((await listExpenses(A)).some((e) => e.description === "Sueldo de B")).toBe(false);
  }, 240000);

  it("reporte: ingresos, egresos, utilidad, margen, periodos y fronteras de día en hora de Lima", async () => {
    await wipe([B]);                                                              // B queda vacío; el reporte se prueba en un tenant limpio
    const T = B;
    await db.user.create({ data: { email: `${tag}-b2@example.test`, name: "b2", role: "ADMIN", tenantId: T, passwordHash: "x" } }).then((u) => (uB = u.id));
    await openCashSession(T, uB, 0);
    const cs = await db.cashRegisterSession.findFirstOrThrow({ where: { tenantId: T } });
    const mk = (iso: string, total: number, cash: number, card: number, discount = 0) =>
      db.sale.create({ data: { tenantId: T, cashRegisterSessionId: cs.id, kind: "POS", totalCents: total, cashCents: cash, cardCents: card, discountCents: discount, createdById: uB, createdAt: new Date(iso) } });
    // 15/09 23:30 Lima = 16/09 04:30Z → día 15;  16/09 00:30 Lima = 16/09 05:30Z → día 16
    await mk("2026-09-16T04:30:00.000Z", 10_000, 10_000, 0);
    await mk("2026-09-16T05:30:00.000Z", 20_000, 5000, 15_000, 500);
    await mk("2026-09-22T15:00:00.000Z", 30_000, 30_000, 0);
    await mk("2026-10-02T15:00:00.000Z", 99_999, 99_999, 0);                      // fuera del rango
    const ex = (date: string, category: "OPERATING_SUPPLIES" | "PERSONNEL" | "RENT_UTILITIES" | "MARKETING_MISC", amountCents: number) =>
      createExpense({ tenantId: T, userId: uB, canManage: true, category, source: "TRANSFER", amountCents, description: `g ${date}`, expenseDate: date });
    await ex("2026-09-15", "PERSONNEL", 4000); await ex("2026-09-16", "RENT_UTILITIES", 6000); await ex("2026-09-28", "MARKETING_MISC", 2500);
    await ex("2026-10-05", "PERSONNEL", 888);                                     // fuera del rango
    const anulado = await ex("2026-09-16", "OPERATING_SUPPLIES", 9999); await voidExpense(T, uB, anulado.id, "error de digitación");
    const r = await getReport(T, "2026-09-15", "2026-09-28", "DAY");
    expect(r.income.totalCents).toBe(60_000); expect(r.income.salesCount).toBe(3);
    expect(r.income.byMethod).toEqual({ cash: 45_000, yapePlin: 0, card: 15_000, transfer: 0 });
    expect(r.income.discountsCents).toBe(500); expect(r.income.byKind).toEqual({ POS: 60_000 });
    expect(r.expenses.totalCents).toBe(12_500);                                   // el anulado y los de fuera del rango no cuentan
    expect(r.expenses.byCategory).toEqual({ OPERATING_SUPPLIES: 0, PERSONNEL: 4000, RENT_UTILITIES: 6000, MARKETING_MISC: 2500 });
    expect(r.expenses.bySource.TRANSFER).toBe(12_500);
    expect(r.profitCents).toBe(47_500); expect(r.marginBp).toBe(7917);
    const day = new Map(r.periods.map((p) => [p.key, p]));
    expect([day.get("2026-09-15")!.incomeCents, day.get("2026-09-15")!.expenseCents]).toEqual([10_000, 4000]);   // frontera de Lima
    expect([day.get("2026-09-16")!.incomeCents, day.get("2026-09-16")!.expenseCents]).toEqual([20_000, 6000]);
    expect(r.periods).toHaveLength(14);
    expect(r.periods.reduce((n, p) => n + p.incomeCents, 0)).toBe(r.income.totalCents);       // los periodos suman el total
    expect(r.periods.reduce((n, p) => n + p.profitCents, 0)).toBe(r.profitCents);
    const w = await getReport(T, "2026-09-15", "2026-09-28", "WEEK");
    expect(w.periods.map((p) => [p.key, p.incomeCents, p.expenseCents])).toEqual([["2026-09-14", 30_000, 10_000], ["2026-09-21", 30_000, 0], ["2026-09-28", 0, 2500]]);
    const m = await getReport(T, "2026-09-01", "2026-10-31", "MONTH");
    expect(m.periods.map((p) => [p.key, p.incomeCents, p.expenseCents])).toEqual([["2026-09", 60_000, 12_500], ["2026-10", 99_999, 888]]);
    await expect(getReport(T, "2026-09-30", "2026-09-01", "DAY")).rejects.toThrow(/anterior/);
    await expect(getReport(T, "2020-01-01", "2026-09-01", "DAY")).rejects.toThrow(/máximo/);
    // exportaciones coherentes con el reporte
    const csv = summaryCsv(r, "Centro; \"Prueba\""); expect(csv).toContain("Utilidad,475.00"); expect(csv).toContain("Margen,79.17 %"); expect(csv).toContain("2026-09-15,100.00,40.00,60.00,60.00 %");
    const detail = expensesCsv(await listExpenses(T, { from: "2026-09-01", to: "2026-09-30", includeVoided: true }), "2026-09-01", "2026-09-30"); expect(detail).toContain("ANULADO"); expect(detail).toContain("Total vigente,125.00");
    expect(summaryPdf(r, "Centro").subarray(0, 8).toString()).toBe("%PDF-1.4");
  }, 400000);
});
