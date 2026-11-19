"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { BillingError } from "@/lib/billing/service";
import { parseSoles } from "@/lib/billing/money";
import { createExpense, setCashierLimit, voidExpense } from "@/lib/expenses/service";
import { CATEGORIES, SOURCES, type ExpenseCategory, type ExpenseSource } from "@/lib/expenses/pure";
import { done, doneOk } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";

const safeBack = (v: FormDataEntryValue | null) => (v === "/cash-register" ? "/cash-register" : "/expenses");

// Registrar: OWNER/ADMIN/RECEPTION (expenses:record). Lo que puede registrar cada rol lo decide `checkExpenseRules` en el servidor.
export async function createExpenseAction(form: FormData) {
  const { user, tenantId } = await requirePermission("expenses:record");
  const back = safeBack(form.get("back"));
  const amount = parseSoles(String(form.get("amount") ?? ""));
  if (amount === null) done(back, "Monto inválido (S/, máx. 2 decimales)");
  const category = String(form.get("category") ?? "") as ExpenseCategory, source = String(form.get("source") ?? "") as ExpenseSource;
  if (!CATEGORIES.includes(category) || !SOURCES.includes(source)) done(back, "Categoría u origen inválido");
  const canManage = hasPermission(user.role, "expenses:manage");
  // Quien no administra no puede elegir la fecha: si la envía (formulario manipulado) se rechaza en vez de ignorarla en silencio
  if (!canManage && String(form.get("date") ?? "").trim()) done(back, "Los cajeros solo registran gastos de hoy");
  try {
    const r = await createExpense({
      tenantId, userId: user.id, canManage, category, source, amountCents: amount as number, description: String(form.get("description") ?? ""),
      expenseDate: canManage ? String(form.get("date") ?? "") || undefined : undefined, supplier: String(form.get("supplier") ?? ""), reference: String(form.get("reference") ?? ""),
      idempotencyKey: String(form.get("key") ?? "").slice(0, 64) || undefined,
    });
    if (!r.duplicate) await audit({ tenantId, actorId: user.id, action: "expense.create", entity: "Expense", entityId: r.id, metadata: { category, source, amountCents: amount as number } });
  } catch (e) {
    if (e instanceof BillingError) done(back, e.message);
    throw e;
  }
  revalidatePath("/expenses"); revalidatePath("/cash-register"); doneOk(back, "Gasto registrado");
}

/** Tope por gasto del cajero (solo el propietario). */
export async function setCashierLimitAction(form: FormData) {
  const { user, tenantId } = await requirePermission("settings:manage");
  const cents = parseSoles(String(form.get("limit") ?? ""));
  if (cents === null) done("/expenses", "Monto inválido (S/, máx. 2 decimales)");
  try {
    await setCashierLimit(tenantId, cents as number);
    await audit({ tenantId, actorId: user.id, action: "expense.cashier_limit", entity: "Tenant", entityId: tenantId, metadata: { limitCents: cents as number } });
  } catch (e) {
    if (e instanceof BillingError) done("/expenses", e.message);
    throw e;
  }
  revalidatePath("/expenses"); revalidatePath("/cash-register"); doneOk("/expenses", "Tope del cajero actualizado");
}

export async function voidExpenseAction(form: FormData) {
  const { user, tenantId } = await requirePermission("expenses:manage");
  const id = String(form.get("id") ?? "");
  try {
    await voidExpense(tenantId, user.id, id, String(form.get("reason") ?? ""));
    await audit({ tenantId, actorId: user.id, action: "expense.void", entity: "Expense", entityId: id });
  } catch (e) {
    if (e instanceof BillingError) done("/expenses", e.message);
    throw e;
  }
  revalidatePath("/expenses"); revalidatePath("/cash-register"); doneOk("/expenses", "Gasto anulado");
}
