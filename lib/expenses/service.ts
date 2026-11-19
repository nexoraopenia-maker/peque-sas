import "server-only";
import { db } from "@/lib/db";
import { BillingError, retryBusy, type Tx } from "@/lib/billing/service";
import { limaDate } from "@/lib/utils/date";
import { CASHIER_LIMIT_CENTS, MAX_CASHIER_LIMIT_CENTS, checkExpenseRules, type ExpenseCategory, type ExpenseSource } from "./pure";

/**
 * Gastos y egresos. Reglas:
 *  - tenantId siempre explícito; el gasto del cajón se liga al turno ABIERTO y suma a `cashExpensesCents` con UNA sentencia
 *    condicionada (turno abierto y efectivo suficiente en el cajón): dos gastos simultáneos no pueden dejar el cajón en negativo.
 *  - Si algo falla se revierte todo (gasto y turno). Los gastos no se borran: se anulan con motivo; un gasto del cajón solo se
 *    anula mientras su turno siga abierto (un turno cerrado ya está arqueado).
 *  - El cajero (sin `canManage`) solo registra insumos operativos del cajón de hoy hasta el tope; ver `checkExpenseRules`.
 */
const TX = { maxWait: 10_000, timeout: 30_000 } as const;
const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e));

export type NewExpense = {
  tenantId: string; userId: string; canManage: boolean; category: ExpenseCategory; source: ExpenseSource; amountCents: number;
  description: string; expenseDate?: string; supplier?: string | null; reference?: string | null; idempotencyKey?: string; now?: Date;
};

export async function createExpense(i: NewExpense): Promise<{ id: string; duplicate: boolean }> {
  const today = limaDate(i.now);
  const description = i.description.trim(), supplier = i.supplier?.trim() || null, reference = i.reference?.trim() || null;
  if (description.length < 3 || description.length > 200) throw new BillingError("La descripción debe tener entre 3 y 200 caracteres");
  if ((supplier?.length ?? 0) > 120 || (reference?.length ?? 0) > 120) throw new BillingError("Proveedor o referencia demasiado largos");
  const expenseDate = i.expenseDate || today;
  // Tope del cajero configurable por establecimiento (solo se consulta cuando aplica)
  const cashierLimitCents = i.canManage ? undefined : (await db.tenant.findFirst({ where: { id: i.tenantId }, select: { cashierExpenseLimitCents: true } }))?.cashierExpenseLimitCents;
  const rule = checkExpenseRules({ canManage: i.canManage, category: i.category, source: i.source, amountCents: i.amountCents, expenseDate, today, cashierLimitCents });
  if (rule) throw new BillingError(rule);
  if (i.idempotencyKey) {
    const prev = await db.expense.findFirst({ where: { tenantId: i.tenantId, idempotencyKey: i.idempotencyKey }, select: { id: true } });
    if (prev) return { id: prev.id, duplicate: true };
  }
  try {
    const id = await retryBusy(() => db.$transaction(async (tx: Tx) => {
      let sessionId: string | null = null;
      if (i.source === "CASH_DRAWER") {
        const n = await tx.$executeRaw`
          UPDATE "CashRegisterSession" SET "cashExpensesCents" = "cashExpensesCents" + ${i.amountCents}
          WHERE "tenantId" = ${i.tenantId} AND "status" = 'OPEN'
            AND ("openingBalanceCents" + COALESCE((SELECT SUM(s."cashCents") FROM "Sale" s WHERE s."tenantId" = ${i.tenantId} AND s."cashRegisterSessionId" = "CashRegisterSession"."id"), 0)
                 - "cashRefundsCents" - "cashExpensesCents") >= ${i.amountCents}`;
        const open = await tx.cashRegisterSession.findFirst({ where: { tenantId: i.tenantId, status: "OPEN" }, select: { id: true } });
        if (!open) throw new BillingError("No hay turno de caja abierto: abre el turno para pagar un gasto con el efectivo del cajón");
        if (n !== 1) throw new BillingError("No hay suficiente efectivo en el cajón para este gasto");
        sessionId = open.id;
      }
      const e = await tx.expense.create({
        data: { tenantId: i.tenantId, category: i.category, description, amountCents: i.amountCents, source: i.source, cashRegisterSessionId: sessionId, expenseDate, supplier, reference, idempotencyKey: i.idempotencyKey ?? null, createdById: i.userId },
        select: { id: true },
      });
      return e.id;
    }, TX));
    return { id, duplicate: false };
  } catch (e) {
    if (i.idempotencyKey && isUnique(e)) { // otra solicitud con la misma clave ganó la carrera: devolver su resultado
      const prev = await db.expense.findFirst({ where: { tenantId: i.tenantId, idempotencyKey: i.idempotencyKey }, select: { id: true } });
      if (prev) return { id: prev.id, duplicate: true };
    }
    throw e;
  }
}

/** Solo OWNER/ADMIN (se exige en la acción). Un gasto del cajón se anula únicamente con su turno abierto y devuelve el efectivo al cajón. */
export async function voidExpense(tenantId: string, userId: string, id: string, reason: string) {
  const why = reason.trim();
  if (why.length < 3 || why.length > 200) throw new BillingError("Indica el motivo de la anulación (3 a 200 caracteres)");
  await retryBusy(() => db.$transaction(async (tx: Tx) => {
    const e = await tx.expense.findFirst({ where: { id, tenantId } });
    if (!e) throw new BillingError("Gasto no encontrado");
    const flip = await tx.expense.updateMany({ where: { id, tenantId, voidedAt: null }, data: { voidedAt: new Date(), voidedById: userId, voidReason: why } });
    if (flip.count !== 1) throw new BillingError("El gasto ya está anulado");
    if (e.source === "CASH_DRAWER") {
      const n = await tx.$executeRaw`UPDATE "CashRegisterSession" SET "cashExpensesCents" = "cashExpensesCents" - ${e.amountCents}
        WHERE "id" = ${e.cashRegisterSessionId} AND "tenantId" = ${tenantId} AND "status" = 'OPEN' AND "cashExpensesCents" >= ${e.amountCents}`;
      if (n !== 1) throw new BillingError("El turno de caja de este gasto ya fue cerrado: no se puede anular");
    }
  }, TX));
}

export async function getCashierLimit(tenantId: string): Promise<number> {
  return (await db.tenant.findFirst({ where: { id: tenantId }, select: { cashierExpenseLimitCents: true } }))?.cashierExpenseLimitCents ?? CASHIER_LIMIT_CENTS;
}

/** Solo el propietario (settings:manage, se exige en la acción). 0 = los cajeros no pueden registrar gastos. */
export async function setCashierLimit(tenantId: string, cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CASHIER_LIMIT_CENTS) throw new BillingError(`El tope debe estar entre S/ 0.00 y S/ ${(MAX_CASHIER_LIMIT_CENTS / 100).toFixed(2)}`);
  await retryBusy(() => db.tenant.updateMany({ where: { id: tenantId }, data: { cashierExpenseLimitCents: cents } }));
}

export type ExpenseFilter = { from?: string; to?: string; category?: ExpenseCategory; sessionId?: string; includeVoided?: boolean };
export const listExpenses = (tenantId: string, f: ExpenseFilter = {}, take = 300) =>
  db.expense.findMany({
    where: {
      tenantId, ...(f.category ? { category: f.category } : {}), ...(f.sessionId ? { cashRegisterSessionId: f.sessionId } : {}),
      ...(f.includeVoided ? {} : { voidedAt: null }),
      ...(f.from || f.to ? { expenseDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    },
    orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }], take,
  });
