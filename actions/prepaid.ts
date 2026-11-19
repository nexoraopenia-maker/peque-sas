"use server";
import { revalidatePath } from "next/cache";
import { requireModule, requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { BillingError, sellPrepaidPackage } from "@/lib/billing/service";
import { voucherFromForm, toSale } from "@/lib/sunat/form";
import { issueAfterSale } from "@/lib/sunat/service";
import { parsePayment } from "@/lib/billing/form";
import { parseSoles } from "@/lib/billing/money";
import { done } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";

export async function createPackageAction(form: FormData) {
  await requireModule("PLAYGROUND");
  const { user, tenantId } = await requirePermission("settings:limited");
  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  const minutes = Number(form.get("minutes"));
  const price = parseSoles(String(form.get("price") ?? ""));
  if (!name || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 100000 || price === null) done("/playground", "Datos del paquete inválidos");
  const p = await tenantDb(tenantId).prepaidPackage.create({ data: { name, minutes, priceCents: price } as never });
  await audit({ tenantId, actorId: user.id, action: "prepaid.package.create", entity: "PrepaidPackage", entityId: p.id });
  revalidatePath("/playground");
  done("/playground");
}

export async function sellPackageAction(form: FormData) {
  await requireModule("PLAYGROUND");
  const { user, tenantId } = await requirePermission("cash:use");
  const pay = parsePayment(form);
  if ("error" in pay) done("/families", pay.error);
  let saleId: string;
  try {
    ({ saleId } = await sellPrepaidPackage({
      tenantId, userId: user.id, pay, idempotencyKey: String(form.get("key") ?? ""),
      childId: String(form.get("childId") ?? ""), packageId: String(form.get("packageId") ?? ""),
    }));
    await audit({ tenantId, actorId: user.id, action: "prepaid.sell", entity: "Sale", entityId: saleId });
  } catch (e) {
    if (e instanceof BillingError) done("/families", e.message);
    throw e;
  }
  const warn = await issueAfterSale({ tenantId, userId: user.id, saleId, choice: voucherFromForm(form) });
  revalidatePath("/families");
  toSale(saleId, warn);
}
