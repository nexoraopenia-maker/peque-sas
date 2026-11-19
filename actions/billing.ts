"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireBillingUser } from "@/lib/rbac";
import { BillingError } from "@/lib/billing/errors";
import { applyPaymentEvent, reportManualPayment, startCheckout } from "@/lib/subscriptions/service";
import { paymentProvider } from "@/lib/env";
import { db } from "@/lib/db";
import { done, doneOk } from "@/lib/utils/flow";

// Solo el PROPIETARIO (requireBillingUser). Funciona también con el acceso bloqueado por impago.
const BACK = "/billing";
const clean = (s: FormDataEntryValue | null) => String(s ?? "").replace(/[^\w-]/g, "");

export async function startCheckoutAction(form: FormData) {
  const { tenantId } = await requireBillingUser();
  let url: string;
  try { ({ url } = await startCheckout({ tenantId, invoiceId: clean(form.get("invoiceId")) })); }
  catch (e) { if (e instanceof BillingError) done(BACK, e.message); throw e; }
  // La pasarela debe devolver una URL https (en el sandbox es una ruta propia)
  if (!/^https:\/\//.test(url) && !url.startsWith(`${(process.env.APP_URL ?? "").replace(/\/+$/, "")}/billing/sandbox`)) done(BACK, "La pasarela devolvió una dirección no válida");
  redirect(url);
}

export async function reportPaymentAction(form: FormData) {
  const { user, tenantId } = await requireBillingUser();
  try { await reportManualPayment({ tenantId, userId: user.id, invoiceId: clean(form.get("invoiceId")), method: String(form.get("method") ?? ""), ref: String(form.get("ref") ?? "") }); }
  catch (e) { if (e instanceof BillingError) done(BACK, e.message); throw e; }
  revalidatePath(BACK); doneOk(BACK, "Pago reportado. Se activará cuando el equipo de soporte lo confirme.");
}

/** SOLO sandbox (PAYMENT_PROVIDER=MOCK fuera de producción): simula el aviso de pago aprobado de la pasarela. */
export async function sandboxPayAction(form: FormData) {
  const { tenantId } = await requireBillingUser();
  if (paymentProvider() !== "MOCK" || process.env.NODE_ENV === "production") done(BACK, "El sandbox de pagos no está disponible");
  const inv = await db.saasInvoice.findFirst({ where: { id: clean(form.get("invoiceId")), tenantId, status: "PENDING" } });
  if (!inv) done(BACK, "Cobro no encontrado o ya pagado");
  const r = await applyPaymentEvent("MOCK", { eventId: `sandbox-${inv!.id}`, invoiceId: inv!.id, amountCents: inv!.amountCents, currency: "PEN", providerRef: `sandbox-${inv!.id}`, status: "APPROVED", method: "CARD" });
  revalidatePath(BACK);
  if (r.status !== "APPLIED") done(BACK, `El pago simulado no se aplicó (${r.status}${r.detail ? `: ${r.detail}` : ""})`);
  doneOk(BACK, "Pago simulado aprobado");
}
