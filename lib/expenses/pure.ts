// Lógica pura de gastos (sin BD) para poder probarla.
export type ExpenseCategory = "OPERATING_SUPPLIES" | "PERSONNEL" | "RENT_UTILITIES" | "MARKETING_MISC";
export type ExpenseSource = "CASH_DRAWER" | "CASH_OTHER" | "YAPE_PLIN" | "CARD" | "TRANSFER";
export const CATEGORIES: ExpenseCategory[] = ["OPERATING_SUPPLIES", "PERSONNEL", "RENT_UTILITIES", "MARKETING_MISC"];
export const SOURCES: ExpenseSource[] = ["CASH_DRAWER", "CASH_OTHER", "YAPE_PLIN", "CARD", "TRANSFER"];
export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  OPERATING_SUPPLIES: "Operativos / Insumos", PERSONNEL: "Personal", RENT_UTILITIES: "Alquiler / Servicios", MARKETING_MISC: "Marketing / Varios",
};
export const SOURCE_LABEL: Record<ExpenseSource, string> = {
  CASH_DRAWER: "Efectivo del cajón (turno)", CASH_OTHER: "Efectivo fuera de caja", YAPE_PLIN: "Yape/Plin", CARD: "Tarjeta", TRANSFER: "Transferencia",
};
/** Tope por defecto por gasto para quien NO administra (cajero): S/ 100.00. Cada establecimiento lo configura (Tenant.cashierExpenseLimitCents). */
export const CASHIER_LIMIT_CENTS = 10_000;
/** Máximo configurable: S/ 10,000.00 (coincide con el CHECK de la base de datos). */
export const MAX_CASHIER_LIMIT_CENTS = 1_000_000;
/** Un gasto no puede fecharse más de un año atrás (evita errores de digitación que distorsionan reportes). */
export const MAX_BACKDATE_DAYS = 366;

export type ExpenseRuleInput = { canManage: boolean; category: ExpenseCategory; source: ExpenseSource; amountCents: number; expenseDate: string; today: string; cashierLimitCents?: number };

const dayNum = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** Devuelve un mensaje de error o null. Reglas de roles: el cajero solo registra egresos operativos del turno, pagados del cajón, hasta el tope y con fecha de hoy. */
export function checkExpenseRules(i: ExpenseRuleInput): string | null {
  if (!Number.isSafeInteger(i.amountCents) || i.amountCents <= 0) return "El monto debe ser mayor a cero";
  if (!CATEGORIES.includes(i.category)) return "Categoría inválida";
  if (!SOURCES.includes(i.source)) return "Origen del pago inválido";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.expenseDate) || isNaN(Date.parse(i.expenseDate))) return "Fecha inválida";
  const delta = dayNum(i.today) - dayNum(i.expenseDate);
  if (delta < 0) return "La fecha del gasto no puede ser futura";
  if (delta > MAX_BACKDATE_DAYS) return "La fecha del gasto es demasiado antigua";
  if (!i.canManage) {
    if (i.category !== "OPERATING_SUPPLIES") return "Solo el propietario o un administrador puede registrar gastos de esta categoría";
    if (i.source !== "CASH_DRAWER") return "Los cajeros solo registran gastos pagados con el efectivo del cajón";
    const limit = i.cashierLimitCents ?? CASHIER_LIMIT_CENTS;
    if (i.amountCents > limit) return `Los gastos mayores a S/ ${(limit / 100).toFixed(2)} los registra el propietario o un administrador`;
    if (i.expenseDate !== i.today) return "Los cajeros solo registran gastos de hoy";
  }
  return null;
}
