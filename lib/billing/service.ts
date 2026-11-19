import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { buildSplit, cashDifference, expectedCash, splitTotal, type Method, type Split } from "./money";
import { settleTime } from "./money";
import { extraMinutes } from "@/lib/playground/time";


/**
 * Servicio de cobros. Reglas:
 *  - Importes siempre en céntimos (enteros).
 *  - Cada operación es UNA transacción: o se aplica completa o no se aplica nada.
 *  - La venta se inserta con una sola sentencia condicionada a que haya un turno OPEN (no se puede cobrar sin caja abierta,
 *    ni "colar" una venta mientras se cierra el turno).
 *  - Se usa el cliente `db` con tenantId explícito en cada consulta; las FK compuestas impiden cruces entre tenants.
 */
import { BillingError } from "./errors";
import { preparePromos, recordPromos, type PromoInput } from "./promos";
import { pointsForPayment } from "@/lib/marketing/pure";
export { BillingError };
export type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;
const TX = { maxWait: 10_000, timeout: 30_000 } as const;
const isBusy = (e: unknown) => /SQLITE_BUSY|database is locked/i.test(e instanceof Error ? e.message : String(e));

/**
 * Turso/SQLite admite un solo escritor a la vez: una transacción que choca con otra recibe SQLITE_BUSY.
 * Como la transacción fallida se revierte completa, reintentar es seguro (las claves únicas y las actualizaciones
 * condicionadas evitan duplicados). Solo se reintenta BUSY; cualquier otro error se propaga.
 */
export async function retryBusy<T>(fn: () => Promise<T>, attempts = 12): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isBusy(e)) throw e;
      // Presupuesto agotado: mensaje claro para el usuario (nada quedó a medias: la transacción se revirtió)
      if (i >= attempts - 1) throw new BillingError("El sistema está ocupado procesando otras operaciones. Inténtalo de nuevo en unos segundos.");
      await new Promise((r) => setTimeout(r, Math.min(2000, 60 * 2 ** i) * (0.5 + Math.random())));
    }
  }
}
const transact = <T>(fn: (tx: Tx) => Promise<T>) => retryBusy(() => db.$transaction(fn, TX));
const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : "");

export type Payment = { first: Method; firstAmountCents: number | null; second?: Method | null };

// ---------- Turno de caja ----------
export const getOpenSession = (tenantId: string) => db.cashRegisterSession.findFirst({ where: { tenantId, status: "OPEN" } });

export async function openCashSession(tenantId: string, userId: string, openingBalanceCents: number) {
  if (!Number.isSafeInteger(openingBalanceCents) || openingBalanceCents < 0) throw new BillingError("Sencillo inválido");
  try {
    return await retryBusy(() => db.cashRegisterSession.create({ data: { tenantId, openedById: userId, openingBalanceCents } }));
  } catch (e) {
    throw isUnique(e) ? new BillingError("Ya hay un turno de caja abierto") : e;
  }
}

export async function sessionTotals(tenantId: string, sessionId: string) {
  const a = await db.sale.aggregate({
    where: { tenantId, cashRegisterSessionId: sessionId },
    _sum: { cashCents: true, yapePlinCents: true, cardCents: true, transferCents: true, totalCents: true },
    _count: true,
  });
  return {
    cash: a._sum.cashCents ?? 0, yapePlin: a._sum.yapePlinCents ?? 0, card: a._sum.cardCents ?? 0,
    transfer: a._sum.transferCents ?? 0, total: a._sum.totalCents ?? 0, count: a._count,
  };
}

/** Cierre transaccional: primero se marca CLOSED (ya no entran ventas) y recién después se suman los totales. */
export async function closeCashSession(tenantId: string, userId: string, declaredCashCents: number) {
  if (!Number.isSafeInteger(declaredCashCents) || declaredCashCents < 0) throw new BillingError("Efectivo declarado inválido");
  return transact(async (tx) => {
    const open = await tx.cashRegisterSession.findFirst({ where: { tenantId, status: "OPEN" } });
    if (!open) throw new BillingError("No hay turno abierto");
    const flip = await tx.cashRegisterSession.updateMany({
      where: { id: open.id, tenantId, status: "OPEN" }, data: { status: "CLOSED", closedAt: new Date(), closedById: userId },
    });
    if (flip.count !== 1) throw new BillingError("El turno ya fue cerrado");
    const a = await tx.sale.aggregate({
      where: { tenantId, cashRegisterSessionId: open.id },
      _sum: { cashCents: true, yapePlinCents: true, cardCents: true, transferCents: true },
    });
    const cash = a._sum.cashCents ?? 0;
    // Releer tras el cierre: un gasto del cajón que entró entre la lectura y el cierre ya está contado (después del cierre no entran más)
    const fin = await tx.cashRegisterSession.findFirstOrThrow({ where: { id: open.id, tenantId } });
    const expected = expectedCash(open.openingBalanceCents, cash, fin.cashRefundsCents, fin.cashExpensesCents);
    const diff = cashDifference(declaredCashCents, expected);
    await tx.cashRegisterSession.updateMany({
      where: { id: open.id, tenantId },
      data: {
        cashSalesCents: cash, yapePlinSalesCents: a._sum.yapePlinCents ?? 0, cardSalesCents: a._sum.cardCents ?? 0,
        transferSalesCents: a._sum.transferCents ?? 0, expectedCashCents: expected, declaredCashCents, differenceCents: diff,
      },
    });
    return { sessionId: open.id, expectedCashCents: expected, declaredCashCents, differenceCents: diff };
  });
}

// ---------- Venta (núcleo) ----------
export type ItemInput = { kind: "COUPON_DISCOUNT" | "POINTS_DISCOUNT" | "RESERVATION_PAYMENT" | "BASE_RATE" | "EXTRA_MINUTES" | "PREPAID_CREDIT" | "PRODUCT" | "PREPAID_PACKAGE" | "MONTHLY_FEE"; description: string; quantity: number; unitPriceCents: number; totalCents: number; productId?: string };

async function insertSale(tx: Tx, p: {
  tenantId: string; userId: string; kind: "PLAYGROUND" | "PREPAID_PACKAGE" | "DAYCARE_FEE" | "POS" | "RESERVATION_PAYMENT"; split: Split; items: ItemInput[];
  childId?: string; reservationId?: string; playgroundSessionId?: string; idempotencyKey?: string; notes?: string;
  promo?: { discountCents: number; couponId: string | null; pointsRedeemed: number; pointsEarned: number; loyaltyGuardianId: string | null };
}): Promise<string> {
  const total = splitTotal(p.split);
  if (p.items.reduce((n, i) => n + i.totalCents, 0) !== total) throw new BillingError("Los ítems no suman el total");
  const id = randomUUID();
  let affected: number;
  try {
    affected = await tx.$executeRaw`
      INSERT INTO "Sale" ("id","tenantId","cashRegisterSessionId","kind","totalCents","cashCents","yapePlinCents","cardCents","transferCents",
                          "childId","reservationId","playgroundSessionId","idempotencyKey","notes","createdById","createdAt",
                          "discountCents","couponId","pointsRedeemed","pointsEarned","loyaltyGuardianId")
      SELECT ${id}, ${p.tenantId}, s."id", ${p.kind}, ${total}, ${p.split.cash}, ${p.split.yapePlin}, ${p.split.card}, ${p.split.transfer},
             ${p.childId ?? null}, ${p.reservationId ?? null}, ${p.playgroundSessionId ?? null}, ${p.idempotencyKey ?? null}, ${p.notes ?? null}, ${p.userId}, ${new Date().toISOString()},
             ${p.promo?.discountCents ?? 0}, ${p.promo?.couponId ?? null}, ${p.promo?.pointsRedeemed ?? 0}, ${p.promo?.pointsEarned ?? 0}, ${p.promo?.loyaltyGuardianId ?? null}
      FROM "CashRegisterSession" s WHERE s."tenantId" = ${p.tenantId} AND s."status" = 'OPEN'`;
  } catch (e) {
    throw isUnique(e) ? new BillingError("Operación duplicada: ya fue registrada") : e;
  }
  if (affected !== 1) throw new BillingError("No hay un turno de caja abierto: abre el turno para cobrar");
  await tx.saleItem.createMany({ data: p.items.map((i) => ({ ...i, tenantId: p.tenantId, saleId: id })) });
  return id;
}

/**
 * ÚNICO punto de creación de ventas con cupón, canje y puntos: calcula el descuento en el servidor, inserta la venta (condicionada al turno
 * abierto), registra el canje del cupón y de los puntos y acredita los puntos ganados por lo realmente pagado. Todo dentro de la misma
 * transacción del llamador: si algo falla, se revierte la venta completa.
 */
async function createSaleWithPromos(tx: Tx, p: {
  tenantId: string; userId: string; kind: "PLAYGROUND" | "PREPAID_PACKAGE" | "DAYCARE_FEE" | "POS" | "RESERVATION_PAYMENT"; items: ItemInput[]; pay: Payment;
  childId?: string; reservationId?: string; playgroundSessionId?: string; idempotencyKey?: string; promo?: PromoInput; preferredGuardianId?: string | null; now?: Date;
}): Promise<{ saleId: string; totalCents: number }> {
  const now = p.now ?? new Date();
  const subtotal = p.items.reduce((n, x) => n + x.totalCents, 0);
  const plan = await preparePromos(tx, { tenantId: p.tenantId, subtotalCents: subtotal, input: { ...p.promo, childId: p.childId ?? null, preferredGuardianId: p.preferredGuardianId ?? null }, now });
  const total = subtotal - plan.discountCents;
  const earned = plan.guardianId ? pointsForPayment(total, plan.cfg) : 0;
  const saleId = await insertSale(tx, {
    tenantId: p.tenantId, userId: p.userId, kind: p.kind, split: splitFor(total, p.pay), items: [...p.items, ...plan.items], childId: p.childId, reservationId: p.reservationId,
    playgroundSessionId: p.playgroundSessionId, idempotencyKey: p.idempotencyKey,
    promo: { discountCents: plan.discountCents, couponId: plan.couponId, pointsRedeemed: plan.pointsUsed, pointsEarned: earned, loyaltyGuardianId: plan.guardianId },
  });
  await recordPromos(tx, { tenantId: p.tenantId, userId: p.userId, saleId, plan, earned, now });
  return { saleId, totalCents: total };
}

function splitFor(total: number, pay: Payment): Split {
  const s = buildSplit(total, pay.first, pay.firstAmountCents, pay.second);
  if (!s) throw new BillingError("Define cómo se paga el total (monto parcial requiere segundo método)");
  return s;
}

async function takeStock(tx: Tx, tenantId: string, userId: string, productId: string, quantity: number, reason: string) {
  const r = await tx.product.updateMany({ where: { id: productId, tenantId, isActive: true, stock: { gte: quantity } }, data: { stock: { decrement: quantity } } });
  if (r.count !== 1) throw new BillingError("Stock insuficiente");
  const after = await tx.product.findFirstOrThrow({ where: { id: productId, tenantId } });
  await tx.stockMovement.create({ data: { tenantId, productId, type: "OUT", quantity, stockAfter: after.stock, reason, createdById: userId } });
}

async function creditPrepaid(tx: Tx, p: { tenantId: string; userId: string; childId: string; minutes: number; type: "PURCHASE" | "CONSUME"; packageId?: string; saleId?: string; playgroundSessionId?: string }) {
  if (!Number.isSafeInteger(p.minutes) || p.minutes <= 0) throw new BillingError("Minutos inválidos");
  const delta = p.type === "PURCHASE" ? p.minutes : -p.minutes;
  // Actualización condicional: nunca deja saldo negativo ni siquiera con operaciones simultáneas (además hay CHECK en BD)
  const n = await tx.$executeRaw`UPDATE "Child" SET "prepaidMinutes" = "prepaidMinutes" + ${delta}
    WHERE "id" = ${p.childId} AND "tenantId" = ${p.tenantId} AND "prepaidMinutes" + ${delta} >= 0`;
  if (n !== 1) throw new BillingError("Saldo de cuponera insuficiente o menor no válido");
  const child = await tx.child.findFirstOrThrow({ where: { id: p.childId, tenantId: p.tenantId } });
  try {
    await tx.prepaidLedger.create({
      data: { tenantId: p.tenantId, childId: p.childId, type: p.type, minutes: delta, balanceAfter: child.prepaidMinutes,
        packageId: p.packageId, saleId: p.saleId, playgroundSessionId: p.playgroundSessionId, createdById: p.userId },
    });
  } catch (e) {
    throw isUnique(e) ? new BillingError("Esta sesión ya consumió saldo de cuponera") : e;
  }
  return child.prepaidMinutes;
}

// ---------- Cuponeras ----------
export async function sellPrepaidPackage(i: { tenantId: string; userId: string; childId: string; packageId: string; pay: Payment; idempotencyKey: string }) {
  return transact(async (tx) => {
    const [child, pkg] = await Promise.all([
      tx.child.findFirst({ where: { id: i.childId, tenantId: i.tenantId } }),
      tx.prepaidPackage.findFirst({ where: { id: i.packageId, tenantId: i.tenantId, isActive: true } }),
    ]);
    if (!child || !pkg) throw new BillingError("Menor o paquete no válidos");
    const { saleId } = await createSaleWithPromos(tx, {
      tenantId: i.tenantId, userId: i.userId, kind: "PREPAID_PACKAGE", pay: i.pay, childId: child.id, idempotencyKey: i.idempotencyKey,
      items: [{ kind: "PREPAID_PACKAGE", description: `Cuponera ${pkg.name} (${pkg.minutes} min)`, quantity: 1, unitPriceCents: pkg.priceCents, totalCents: pkg.priceCents }],
    });
    const balance = await creditPrepaid(tx, { tenantId: i.tenantId, userId: i.userId, childId: child.id, minutes: pkg.minutes, type: "PURCHASE", packageId: pkg.id, saleId });
    return { saleId, balance };
  });
}

// ---------- Mensualidades de guardería ----------
export async function generateInvoices(tenantId: string, period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new BillingError("Periodo inválido");
  const first = `${period}-01`, last = `${period}-31`;
  const enrollments = await db.enrollment.findMany({
    where: { tenantId, status: "ACTIVE", startDate: { lte: last }, OR: [{ endDate: null }, { endDate: { gte: first } }] },
  });
  let created = 0;
  for (const e of enrollments) {
    try {
      await retryBusy(() => db.daycareInvoice.create({ data: { tenantId, enrollmentId: e.id, childId: e.childId, period, amountCents: e.monthlyFeeCents, dueDate: `${period}-05` } }));
      created++;
    } catch (err) {
      if (!isUnique(err)) throw err; // ya existía: idempotente
    }
  }
  return { created, total: enrollments.length };
}

export async function payInvoice(i: { tenantId: string; userId: string; invoiceId: string; pay: Payment; idempotencyKey: string }) {
  return transact(async (tx) => {
    const inv = await tx.daycareInvoice.findFirst({ where: { id: i.invoiceId, tenantId: i.tenantId, status: "PENDING" } });
    if (!inv) throw new BillingError("Mensualidad no encontrada o ya pagada");
    const { saleId } = await createSaleWithPromos(tx, {
      tenantId: i.tenantId, userId: i.userId, kind: "DAYCARE_FEE", pay: i.pay, childId: inv.childId, idempotencyKey: i.idempotencyKey,
      items: [{ kind: "MONTHLY_FEE", description: `Mensualidad ${inv.period}`, quantity: 1, unitPriceCents: inv.amountCents, totalCents: inv.amountCents }],
    });
    // condicionado a PENDING: dos cobros simultáneos no pagan dos veces
    const r = await tx.daycareInvoice.updateMany({ where: { id: inv.id, tenantId: i.tenantId, status: "PENDING" }, data: { status: "PAID", paidAt: new Date(), saleId } });
    if (r.count !== 1) throw new BillingError("La mensualidad ya fue pagada");
    return { saleId };
  });
}

// ---------- POS ----------
export async function posSale(i: { tenantId: string; userId: string; lines: { productId: string; quantity: number }[]; pay: Payment; idempotencyKey: string; promo?: PromoInput }) {
  if (!i.lines.length || i.lines.some((l) => !Number.isSafeInteger(l.quantity) || l.quantity <= 0)) throw new BillingError("Cantidades inválidas");
  return transact(async (tx) => {
    const items: ItemInput[] = [];
    for (const l of i.lines) {
      const p = await tx.product.findFirst({ where: { id: l.productId, tenantId: i.tenantId, isActive: true } });
      if (!p) throw new BillingError("Producto no válido");
      items.push({ kind: "PRODUCT", description: p.name, quantity: l.quantity, unitPriceCents: p.priceCents, totalCents: p.priceCents * l.quantity, productId: p.id });
    }
    const { saleId, totalCents: total } = await createSaleWithPromos(tx, { tenantId: i.tenantId, userId: i.userId, kind: "POS", pay: i.pay, items, idempotencyKey: i.idempotencyKey, promo: i.promo });
    for (const l of i.lines) await takeStock(tx, i.tenantId, i.userId, l.productId, l.quantity, `Venta ${saleId.slice(0, 8)}`);
    return { saleId, totalCents: total };
  });
}

// ---------- Ludoteca ----------
export async function addConsumption(i: { tenantId: string; userId: string; sessionId: string; productId: string; quantity: number }) {
  if (!Number.isSafeInteger(i.quantity) || i.quantity <= 0) throw new BillingError("Cantidad inválida");
  return transact(async (tx) => {
    const session = await tx.playgroundSession.findFirst({ where: { id: i.sessionId, tenantId: i.tenantId, status: "OPEN" } });
    const product = await tx.product.findFirst({ where: { id: i.productId, tenantId: i.tenantId, isActive: true } });
    if (!session || !product) throw new BillingError("Sesión abierta o producto no válidos");
    await takeStock(tx, i.tenantId, i.userId, product.id, i.quantity, `Consumo sesión ${session.id.slice(0, 8)}`);
    await tx.playgroundConsumption.create({ data: { tenantId: i.tenantId, sessionId: session.id, productId: product.id, quantity: i.quantity, unitPriceCents: product.priceCents, createdById: i.userId } });
  });
}

export type PlaygroundQuote = {
  items: ItemInput[]; totalCents: number; prepaidMinutesUsed: number; prepaidBalance: number; extraMinutes: number;
};

async function quote(tx: Tx, tenantId: string, sessionId: string, now: Date) {
  const session = await tx.playgroundSession.findFirst({ where: { id: sessionId, tenantId, status: "OPEN" } });
  if (!session) throw new BillingError("Sesión no encontrada o ya cerrada");
  const child = await tx.child.findFirstOrThrow({ where: { id: session.childId, tenantId } });
  const consumptions = await tx.playgroundConsumption.findMany({ where: { tenantId, sessionId } });
  const products = await tx.product.findMany({ where: { tenantId, id: { in: consumptions.map((c) => c.productId) } } });
  const name = new Map(products.map((p) => [p.id, p.name]));
  const extra = extraMinutes(session, now);
  const t = settleTime({ contractedMinutes: session.contractedMinutes, extraMinutes: extra, basePriceCents: session.basePriceCents, extraMinuteCents: session.extraMinuteCents, prepaidBalance: child.prepaidMinutes });
  const items: ItemInput[] = [{ kind: "BASE_RATE", description: `Tarifa ${session.contractedMinutes} min`, quantity: 1, unitPriceCents: t.baseCents, totalCents: t.baseCents }];
  if (extra > 0) items.push({ kind: "EXTRA_MINUTES", description: `Minutos excedidos`, quantity: extra, unitPriceCents: session.extraMinuteCents, totalCents: t.extraCents });
  if (t.prepaidCreditCents > 0) items.push({ kind: "PREPAID_CREDIT", description: `Cuponera: ${t.prepaidMinutesUsed} min`, quantity: t.prepaidMinutesUsed, unitPriceCents: 0, totalCents: -t.prepaidCreditCents });
  for (const c of consumptions) items.push({ kind: "PRODUCT", description: name.get(c.productId) ?? "Producto", quantity: c.quantity, unitPriceCents: c.unitPriceCents, totalCents: c.quantity * c.unitPriceCents, productId: c.productId });
  const totalCents = items.reduce((n, x) => n + x.totalCents, 0);
  return { session, child, quote: { items, totalCents, prepaidMinutesUsed: t.prepaidMinutesUsed, prepaidBalance: child.prepaidMinutes, extraMinutes: extra } satisfies PlaygroundQuote };
}

/** Cotización de solo lectura (para mostrar el desglose antes de cobrar). */
export const quotePlayground = (tenantId: string, sessionId: string, now = new Date()) =>
  transact((tx) => quote(tx, tenantId, sessionId, now).then((r) => r.quote));

/**
 * Salida + cobro en un solo paso y una sola transacción: venta, consumo de cuponera, ítems y cierre de la sesión.
 * La sesión tiene como máximo UNA venta (único tenantId+playgroundSessionId): imposible cobrarla dos veces.
 */
export async function checkoutPlayground(i: {
  tenantId: string; userId: string; sessionId: string; pay: Payment; pickup: { kind: string; refId: string; name: string }; promo?: PromoInput;
}) {
  return transact(async (tx) => {
    const now = new Date();
    const { session, quote: q } = await quote(tx, i.tenantId, i.sessionId, now);
    const { saleId, totalCents } = await createSaleWithPromos(tx, {
      tenantId: i.tenantId, userId: i.userId, kind: "PLAYGROUND", pay: i.pay, items: q.items, childId: session.childId, playgroundSessionId: session.id,
      promo: i.promo, preferredGuardianId: i.pickup.kind === "GUARDIAN" ? i.pickup.refId : null, now,
    });
    if (q.prepaidMinutesUsed > 0) {
      await creditPrepaid(tx, { tenantId: i.tenantId, userId: i.userId, childId: session.childId, minutes: q.prepaidMinutesUsed, type: "CONSUME", saleId, playgroundSessionId: session.id });
    }
    const r = await tx.playgroundSession.updateMany({
      where: { id: session.id, tenantId: i.tenantId, status: "OPEN" },
      data: { status: "CLOSED", checkOutAt: now, amountCents: totalCents, pickedUpBy: i.pickup.name, pickupKind: i.pickup.kind, pickupRefId: i.pickup.refId, checkedOutById: i.userId },
    });
    if (r.count !== 1) throw new BillingError("La sesión ya estaba cerrada");
    return { saleId, totalCents, prepaidMinutesUsed: q.prepaidMinutesUsed };
  });
}

// ---------- Reservas: adelantos y saldos ----------
/**
 * Cobro a cuenta de una reserva (adelanto, abono o saldo). Entra a la caja del turno ABIERTO como una venta más.
 * Atómico: venta + aumento de lo pagado (condicionado a no superar el total) + vínculo con el turno + confirmación automática.
 */
export async function payReservation(i: { tenantId: string; userId: string; reservationId: string; amountCents: number; pay: Payment; idempotencyKey: string }) {
  if (!Number.isSafeInteger(i.amountCents) || i.amountCents <= 0) throw new BillingError("Monto inválido");
  return transact(async (tx) => {
    const r = await tx.reservation.findFirst({ where: { id: i.reservationId, tenantId: i.tenantId, status: { in: ["PENDING", "CONFIRMED"] } } });
    if (!r) throw new BillingError("Reserva no encontrada o ya no admite cobros");
    const balance = r.totalAmountCents - r.advancePaidCents;
    if (i.amountCents > balance) throw new BillingError(`El monto supera el saldo pendiente (${(balance / 100).toFixed(2)})`);
    const label = i.amountCents === balance ? (r.advancePaidCents === 0 ? "Pago total" : "Saldo") : r.advancePaidCents === 0 ? "Adelanto" : "Abono";
    const { saleId } = await createSaleWithPromos(tx, {
      tenantId: i.tenantId, userId: i.userId, kind: "RESERVATION_PAYMENT", pay: i.pay, reservationId: r.id, idempotencyKey: i.idempotencyKey,
      childId: r.childId ?? undefined,
      items: [{ kind: "RESERVATION_PAYMENT", description: `${label} reserva ${r.date} ${r.startTime}`, quantity: 1, unitPriceCents: i.amountCents, totalCents: i.amountCents }],
    });
    // Condicionado: dos cobros simultáneos no pueden sumar más que el total (además hay CHECK en BD)
    const now = new Date().toISOString();
    const n = await tx.$executeRaw`UPDATE "Reservation" SET "advancePaidCents" = "advancePaidCents" + ${i.amountCents}, "updatedAt" = ${now}
      WHERE "id" = ${r.id} AND "tenantId" = ${i.tenantId} AND "status" IN ('PENDING','CONFIRMED') AND "advancePaidCents" + ${i.amountCents} <= "totalAmountCents"`;
    if (n !== 1) throw new BillingError("El saldo cambió: revisa el monto e inténtalo de nuevo");
    const sale = await tx.sale.findFirstOrThrow({ where: { id: saleId, tenantId: i.tenantId } });
    await tx.reservation.updateMany({ where: { id: r.id, tenantId: i.tenantId, advanceCashSessionId: null }, data: { advanceCashSessionId: sale.cashRegisterSessionId } });
    await tx.reservation.updateMany({
      where: { id: r.id, tenantId: i.tenantId, status: "PENDING", advanceRequiredCents: { gt: 0 }, advancePaidCents: { gte: r.advanceRequiredCents } },
      data: { status: "CONFIRMED" },
    });
    return { saleId, balanceAfter: balance - i.amountCents };
  });
}
