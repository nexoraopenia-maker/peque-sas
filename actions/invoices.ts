"use server";
import { revalidatePath } from "next/cache";
import { requireModule, requirePermission } from "@/lib/rbac";
import { BillingError, generateInvoices, payInvoice } from "@/lib/billing/service";
import { voucherFromForm, toSale } from "@/lib/sunat/form";
import { issueAfterSale } from "@/lib/sunat/service";
import { parsePayment } from "@/lib/billing/form";
import { isMonthString } from "@/lib/utils/date";
import { done } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";

export async function generateInvoicesAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:manage");
  const period = String(form.get("period") ?? "");
  if (!isMonthString(period)) done("/subscriptions", "Periodo inválido");
  const r = await generateInvoices(tenantId, period);
  await audit({ tenantId, actorId: user.id, action: "daycare.invoices.generate", metadata: { period, created: r.created } });
  revalidatePath("/subscriptions");
  done(`/subscriptions?month=${period}`);
}

export async function payInvoiceAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("cash:use");
  const pay = parsePayment(form);
  if ("error" in pay) done("/subscriptions", pay.error);
  let saleId: string;
  try {
    ({ saleId } = await payInvoice({ tenantId, userId: user.id, pay, idempotencyKey: String(form.get("key") ?? ""), invoiceId: String(form.get("invoiceId") ?? "") }));
    await audit({ tenantId, actorId: user.id, action: "daycare.invoice.pay", entity: "Sale", entityId: saleId });
  } catch (e) {
    if (e instanceof BillingError) done("/subscriptions", e.message);
    throw e;
  }
  const warn = await issueAfterSale({ tenantId, userId: user.id, saleId, choice: voucherFromForm(form) });
  revalidatePath("/subscriptions");
  toSale(saleId, warn);
}
