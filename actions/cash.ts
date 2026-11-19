"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { BillingError, closeCashSession, openCashSession, posSale } from "@/lib/billing/service";
import { voucherFromForm, toSale } from "@/lib/sunat/form";
import { issueAfterSale } from "@/lib/sunat/service";
import { parsePayment, promoFromForm } from "@/lib/billing/form";
import { parseSoles } from "@/lib/billing/money";
import { done } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";
import { notifyCashAlert } from "@/lib/whatsapp/notify";

const BACK = "/cash-register";

export async function openCashAction(form: FormData) {
  const { user, tenantId } = await requirePermission("cash:use");
  const cents = parseSoles(String(form.get("opening") ?? "0") || "0");
  if (cents === null) done(BACK, "Sencillo inválido");
  try {
    const s = await openCashSession(tenantId, user.id, cents);
    await audit({ tenantId, actorId: user.id, action: "cash.open", entity: "CashRegisterSession", entityId: s.id, metadata: { openingCents: cents } });
  } catch (e) {
    if (e instanceof BillingError) done(BACK, e.message);
    throw e;
  }
  revalidatePath(BACK);
  done(BACK);
}

export async function closeCashAction(form: FormData) {
  const { user, tenantId } = await requirePermission("cash:use");
  const declared = parseSoles(String(form.get("declared") ?? ""));
  if (declared === null) done(BACK, "Indica el efectivo contado (S/, máx. 2 decimales)");
  try {
    const r = await closeCashSession(tenantId, user.id, declared);
    await audit({ tenantId, actorId: user.id, action: "cash.close", entity: "CashRegisterSession", entityId: r.sessionId, metadata: { differenceCents: r.differenceCents } });
    // Aviso al propietario si el descuadre supera S/ 5.00. El cierre ya está guardado: un fallo del aviso NUNCA lo deshace (queda registrado en el historial de WhatsApp)
    await notifyCashAlert({ tenantId, sessionId: r.sessionId, differenceCents: r.differenceCents, expectedCents: r.expectedCashCents, declaredCents: r.declaredCashCents }).catch(() => undefined);
  } catch (e) {
    if (e instanceof BillingError) done(BACK, e.message);
    throw e;
  }
  revalidatePath(BACK);
  done(BACK);
}

export async function posSaleAction(form: FormData) {
  const { user, tenantId } = await requirePermission("cash:use");
  const pay = parsePayment(form);
  if ("error" in pay) done(BACK, pay.error);
  const quantity = Number(form.get("quantity"));
  let saleId: string;
  try {
    ({ saleId } = await posSale({
      tenantId, userId: user.id, pay, idempotencyKey: String(form.get("key") ?? ""),
      lines: [{ productId: String(form.get("productId") ?? ""), quantity }],
      promo: promoFromForm(form),
    }));
    await audit({ tenantId, actorId: user.id, action: "sale.pos", entity: "Sale", entityId: saleId });
  } catch (e) {
    if (e instanceof BillingError) done(BACK, e.message);
    throw e;
  }
  const warn = await issueAfterSale({ tenantId, userId: user.id, saleId, choice: voucherFromForm(form) });
  revalidatePath(BACK);
  toSale(saleId, warn);
}
