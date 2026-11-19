import "server-only";
import { db } from "@/lib/db";
import { limaDate } from "@/lib/utils/date";
import { buildPeriods, marginBp, rangeBounds, validateRange, type Granularity, type Period } from "./pure";
import type { ExpenseCategory, ExpenseSource } from "@/lib/expenses/pure";

/**
 * Reporte financiero por rango (hora de Lima). Criterios (base caja):
 *  - Ingresos = ventas cobradas del periodo (total ya neto de cupones y puntos). En este sistema todo cobro es inmediato: cobros = ingresos.
 *  - Egresos = gastos NO anulados por su fecha contable.
 *  - Utilidad = ingresos − egresos. Margen = utilidad / ingresos.
 *  - Las mensualidades pendientes NO son ingresos hasta cobrarse (se muestran aparte como por cobrar).
 */
export type Report = {
  from: string; to: string; granularity: Granularity;
  income: { totalCents: number; salesCount: number; discountsCents: number; byKind: Record<string, number>; byMethod: { cash: number; yapePlin: number; card: number; transfer: number } };
  expenses: { totalCents: number; count: number; byCategory: Record<ExpenseCategory, number>; bySource: Record<ExpenseSource, number> };
  profitCents: number; marginBp: number | null; periods: Period[]; receivableCents: number;
};

export async function getReport(tenantId: string, from: string, to: string, granularity: Granularity): Promise<Report> {
  const bad = validateRange(from, to); if (bad) throw new Error(bad);
  const { start, end } = rangeBounds(from, to);
  const [sales, expenses, receivable] = await Promise.all([
    db.sale.findMany({ where: { tenantId, createdAt: { gte: start, lte: end } }, select: { createdAt: true, kind: true, totalCents: true, cashCents: true, yapePlinCents: true, cardCents: true, transferCents: true, discountCents: true }, take: 200_000 }),
    db.expense.findMany({ where: { tenantId, voidedAt: null, expenseDate: { gte: from, lte: to } }, select: { expenseDate: true, category: true, source: true, amountCents: true } }),
    db.daycareInvoice.aggregate({ where: { tenantId, status: "PENDING" }, _sum: { amountCents: true } }),
  ]);
  const byKind: Record<string, number> = {}; const m = { cash: 0, yapePlin: 0, card: 0, transfer: 0 };
  const byDay = new Map<string, { i: number; e: number }>(); const slot = (d: string) => { let v = byDay.get(d); if (!v) byDay.set(d, (v = { i: 0, e: 0 })); return v; };
  let income = 0, discounts = 0;
  for (const s of sales) {
    income += s.totalCents; discounts += s.discountCents; byKind[s.kind] = (byKind[s.kind] ?? 0) + s.totalCents;
    m.cash += s.cashCents; m.yapePlin += s.yapePlinCents; m.card += s.cardCents; m.transfer += s.transferCents;
    slot(limaDate(s.createdAt)).i += s.totalCents;
  }
  const byCategory = { OPERATING_SUPPLIES: 0, PERSONNEL: 0, RENT_UTILITIES: 0, MARKETING_MISC: 0 } as Record<ExpenseCategory, number>;
  const bySource = { CASH_DRAWER: 0, CASH_OTHER: 0, YAPE_PLIN: 0, CARD: 0, TRANSFER: 0 } as Record<ExpenseSource, number>;
  let spent = 0;
  for (const e of expenses) { spent += e.amountCents; byCategory[e.category] += e.amountCents; bySource[e.source] += e.amountCents; slot(e.expenseDate).e += e.amountCents; }
  const periods = buildPeriods([...byDay].map(([day, v]) => ({ day, incomeCents: v.i, expenseCents: v.e })), from, to, granularity);
  const profit = income - spent;
  return {
    from, to, granularity, income: { totalCents: income, salesCount: sales.length, discountsCents: discounts, byKind, byMethod: m },
    expenses: { totalCents: spent, count: expenses.length, byCategory, bySource }, profitCents: profit, marginBp: marginBp(income, profit), periods,
    receivableCents: receivable._sum.amountCents ?? 0,
  };
}
