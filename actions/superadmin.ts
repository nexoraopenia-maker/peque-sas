"use server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/rbac";
import { BillingError } from "@/lib/billing/service";
import { changeTenantPlan, createPlan, reactivateTenant, resetOwnerPassword, setDemoExpiry, suspendTenant } from "@/lib/superadmin/service";
import { confirmReportedPayment, registerPayment, rejectReportedPayment } from "@/lib/subscriptions/service";
import { createDemoTenant, type DemoResult } from "@/lib/superadmin/demo";
import { MODULE_KEYS } from "@/lib/superadmin/pure";
import { done, doneOk } from "@/lib/utils/flow";

// REGLA: toda acción empieza con requireSuperAdmin(). Las funciones del servicio vuelven a verificar el rol en la base de datos.
const DASH = "/superadmin/dashboard";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const id = (f: FormData) => text(f, "tenantId").replace(/[^\w-]/g, "");
const detail = (tenantId: string) => `/superadmin/tenants/${tenantId}`;
async function guard<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof BillingError) done(path, e.message); throw e; }
}

export async function suspendTenantAction(form: FormData) {
  const admin = await requireSuperAdmin(); const t = id(form);
  await guard(detail(t), () => suspendTenant({ actorId: admin.id, tenantId: t, reason: text(form, "reason") }));
  revalidatePath(DASH); revalidatePath(detail(t)); doneOk(detail(t), "Establecimiento suspendido y sesiones cerradas");
}
export async function reactivateTenantAction(form: FormData) {
  const admin = await requireSuperAdmin(); const t = id(form);
  await guard(detail(t), () => reactivateTenant({ actorId: admin.id, tenantId: t }));
  revalidatePath(DASH); revalidatePath(detail(t)); doneOk(detail(t), "Establecimiento reactivado");
}
export async function changePlanAction(form: FormData) {
  const admin = await requireSuperAdmin(); const t = id(form);
  await guard(detail(t), () => changeTenantPlan({ actorId: admin.id, tenantId: t, planId: text(form, "planId").replace(/[^\w-]/g, "") }));
  revalidatePath(DASH); revalidatePath(detail(t)); doneOk(detail(t), "Plan actualizado (los datos históricos se conservan)");
}
export async function setDemoExpiryAction(form: FormData) {
  const admin = await requireSuperAdmin(); const t = id(form);
  await guard(detail(t), () => setDemoExpiry({ actorId: admin.id, tenantId: t, day: text(form, "day") }));
  revalidatePath(DASH); revalidatePath(detail(t)); doneOk(detail(t), "Vencimiento actualizado");
}
export async function createPlanAction(form: FormData) {
  const admin = await requireSuperAdmin();
  await guard(DASH, () => createPlan({ actorId: admin.id, raw: {
    name: text(form, "name"), modules: form.getAll("modules").map(String).filter((m) => (MODULE_KEYS as readonly string[]).includes(m)), maxUsers: text(form, "maxUsers"), storageMb: text(form, "storageMb"),
    botMonthlyReplies: text(form, "botMonthlyReplies"), price: text(form, "price") || "0", billingPeriodDays: text(form, "billingPeriodDays") || "30", automationsEnabled: form.get("automationsEnabled") === "on", reportsEnabled: form.get("reportsEnabled") === "on",
  } }));
  revalidatePath(DASH); doneOk(DASH, "Plan creado");
}

export async function confirmPaymentAction(form: FormData) {
  const admin = await requireSuperAdmin(); const t = id(form);
  await guard(detail(t), () => confirmReportedPayment({ actorId: admin.id, invoiceId: text(form, "invoiceId").replace(/[^\w-]/g, "") }));
  revalidatePath(DASH); revalidatePath(detail(t)); doneOk(detail(t), "Pago confirmado y suscripción extendida");
}
export async function rejectPaymentAction(form: FormData) {
  const admin = await requireSuperAdmin(); const t = id(form);
  await guard(detail(t), () => rejectReportedPayment({ actorId: admin.id, invoiceId: text(form, "invoiceId").replace(/[^\w-]/g, ""), reason: text(form, "reason") }));
  revalidatePath(DASH); revalidatePath(detail(t)); doneOk(detail(t), "Pago rechazado");
}
export async function registerPaymentAction(form: FormData) {
  const admin = await requireSuperAdmin(); const t = id(form);
  const method = text(form, "method");
  if (!["YAPE", "PLIN", "TRANSFER", "CARD", "OTHER"].includes(method)) done(detail(t), "Medio de pago inválido");
  await guard(detail(t), () => registerPayment({ actorId: admin.id, invoiceId: text(form, "invoiceId").replace(/[^\w-]/g, ""), method: method as "YAPE", ref: text(form, "ref") }));
  revalidatePath(DASH); revalidatePath(detail(t)); doneOk(detail(t), "Pago registrado y suscripción extendida");
}

type CredState = { error?: string; reset?: { email: string; tempPassword: string } } | undefined;
/** Restablecimiento seguro del propietario: la contraseña temporal se muestra una sola vez. */
export async function resetOwnerPasswordAction(_p: CredState, form: FormData): Promise<CredState> {
  const admin = await requireSuperAdmin();
  try { return { reset: await resetOwnerPassword({ actorId: admin.id, tenantId: id(form) }) }; }
  catch (e) { if (e instanceof BillingError) return { error: e.message }; throw e; }
}

type DemoState = { error?: string; created?: DemoResult } | undefined;
export async function createDemoAction(_p: DemoState, form: FormData): Promise<DemoState> {
  const admin = await requireSuperAdmin();
  try {
    const created = await createDemoTenant(admin.id, {
      name: text(form, "name"), businessType: text(form, "businessType"), adminEmail: text(form, "adminEmail"), adminName: text(form, "adminName"), password: text(form, "password"),
      modules: form.getAll("modules").map(String).filter((m) => (MODULE_KEYS as readonly string[]).includes(m)), expiresAt: text(form, "expiresAt"), maxUsers: text(form, "maxUsers"),
      storageMb: text(form, "storageMb"), botMonthlyReplies: text(form, "botMonthlyReplies"), whatsappEnabled: form.get("whatsappEnabled") === "on", automationsEnabled: form.get("automationsEnabled") === "on",
    });
    revalidatePath(DASH);
    return { created };
  } catch (e) {
    if (e instanceof BillingError) return { error: e.message };
    throw e;
  }
}
