"use server";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requirePermission } from "@/lib/rbac";
import { done, doneOk } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";
import { parseSoles } from "@/lib/billing/money";
import { CouponError, createCoupon, setCouponActive, updateCoupon } from "@/lib/marketing/coupons";
import { saveLoyaltyConfig } from "@/lib/marketing/loyalty";
import { CampaignError, cancelCampaign, createCampaign, sendBatch, startCampaign } from "@/lib/marketing/campaigns";
import { ConsentError, setMarketingConsent } from "@/lib/marketing/consent";

const num = (v: FormDataEntryValue | null) => { const s = String(v ?? "").trim(); return s === "" ? null : Number(s); };
const fail = (back: string, e: unknown): never => {
  if (e instanceof ZodError) done(back, e.issues[0]?.message ?? "Datos inválidos");
  if (e instanceof CouponError || e instanceof CampaignError || e instanceof ConsentError) done(back, e.message);
  throw e;
};

function couponFromForm(form: FormData) {
  const min = parseSoles(String(form.get("minPurchase") ?? "") || "0");
  if (min === null) done("/marketing/coupons", "Compra mínima inválida (S/, máx. 2 decimales)");
  const type = String(form.get("type") ?? "") === "FIXED_CENTS" ? "FIXED_CENTS" : "PERCENTAGE";
  const raw = num(form.get("value"));
  const value = type === "FIXED_CENTS" ? (parseSoles(String(form.get("value") ?? "")) ?? NaN) : raw ?? NaN;
  if (!Number.isInteger(value) || value <= 0) done("/marketing/coupons", type === "FIXED_CENTS" ? "Monto de descuento inválido" : "El porcentaje debe ser un entero entre 1 y 100");
  const day = (k: string, end: boolean) => { const v = String(form.get(k) ?? "").trim(); return v ? new Date(`${v}T${end ? "23:59:59.999" : "00:00:00.000"}-05:00`).toISOString() : undefined; };
  return {
    code: String(form.get("code") ?? ""), description: String(form.get("description") ?? ""), type: type as "PERCENTAGE" | "FIXED_CENTS", value: value as number,
    validFrom: day("validFrom", false), validUntil: day("validUntil", true),
    maxUses: num(form.get("maxUses")), maxUsesPerGuardian: num(form.get("maxUsesPerGuardian")), minPurchaseCents: min as number,
  };
}

// Solo OWNER y ADMIN (coupons:manage). RECEPTION únicamente consulta y aplica en caja.
export async function createCouponAction(form: FormData) {
  const { user, tenantId } = await requirePermission("coupons:manage");
  try {
    const c = await createCoupon(tenantId, user.id, couponFromForm(form));
    await audit({ tenantId, actorId: user.id, action: "coupon.create", entity: "Coupon", entityId: c.id, metadata: { code: c.code } });
  } catch (e) { fail("/marketing/coupons", e); }
  revalidatePath("/marketing/coupons"); doneOk("/marketing/coupons", "Cupón creado");
}

export async function updateCouponAction(form: FormData) {
  const { user, tenantId } = await requirePermission("coupons:manage");
  const id = String(form.get("id") ?? "");
  try {
    await updateCoupon(tenantId, id, couponFromForm(form));
    await audit({ tenantId, actorId: user.id, action: "coupon.update", entity: "Coupon", entityId: id });
  } catch (e) { fail("/marketing/coupons", e); }
  revalidatePath("/marketing/coupons"); doneOk("/marketing/coupons", "Cupón actualizado");
}

export async function toggleCouponAction(form: FormData) {
  const { user, tenantId } = await requirePermission("coupons:manage");
  const id = String(form.get("id") ?? ""), active = form.get("active") === "1";
  try {
    await setCouponActive(tenantId, id, active);
    await audit({ tenantId, actorId: user.id, action: active ? "coupon.activate" : "coupon.deactivate", entity: "Coupon", entityId: id });
  } catch (e) { fail("/marketing/coupons", e); }
  revalidatePath("/marketing/coupons"); done("/marketing/coupons");
}

export async function saveLoyaltyAction(form: FormData) {
  const { user, tenantId } = await requirePermission("loyalty:configure");
  const centsPerPoint = parseSoles(String(form.get("pointValue") ?? ""));
  if (centsPerPoint === null || centsPerPoint < 1) done("/marketing/loyalty", "Valor del punto inválido (S/, mínimo S/ 0.01)");
  try {
    await saveLoyaltyConfig(tenantId, user.id, {
      enabled: form.get("enabled") === "on", pointsPerSol: num(form.get("pointsPerSol")) ?? NaN, expiryDays: num(form.get("expiryDays")) ?? NaN,
      centsPerPoint: centsPerPoint as number, maxRedeemPercent: num(form.get("maxRedeemPercent")) ?? NaN,
    });
    await audit({ tenantId, actorId: user.id, action: "loyalty.configure", entity: "LoyaltyConfig", entityId: tenantId });
  } catch (e) { fail("/marketing/loyalty", e); }
  revalidatePath("/marketing/loyalty"); doneOk("/marketing/loyalty", "Programa de puntos actualizado");
}

export async function createCampaignAction(form: FormData) {
  const { user, tenantId } = await requirePermission("marketing:manage");
  let id: string;
  try {
    const c = await createCampaign(tenantId, user.id, {
      name: String(form.get("name") ?? ""), segment: String(form.get("segment") ?? "") as "INACTIVE", templateName: String(form.get("templateName") ?? ""),
      couponCode: String(form.get("couponCode") ?? "").trim() || undefined, inactiveDays: num(form.get("inactiveDays")) ?? 30, prepaidMinutesBelow: num(form.get("prepaidMinutesBelow")) ?? 60,
    });
    id = c.id;
    await audit({ tenantId, actorId: user.id, action: "campaign.create", entity: "Campaign", entityId: id });
  } catch (e) { return fail("/marketing/campaigns", e); }
  revalidatePath("/marketing/campaigns"); done(`/marketing/campaigns/${id}`);
}

export async function startCampaignAction(form: FormData) {
  const { user, tenantId } = await requirePermission("marketing:manage");
  const id = String(form.get("id") ?? ""), back = `/marketing/campaigns/${id}`;
  try {
    const r = await startCampaign(tenantId, id);
    await audit({ tenantId, actorId: user.id, action: "campaign.start", entity: "Campaign", entityId: id, metadata: { recipients: r.recipients, excludedNoConsent: r.excludedNoConsent } });
    await sendBatch(tenantId, id, { limit: 15 });
  } catch (e) { fail(back, e); }
  revalidatePath(back); done(back);
}

export async function sendBatchAction(form: FormData) {
  const { tenantId } = await requirePermission("marketing:manage");
  const id = String(form.get("id") ?? ""), back = `/marketing/campaigns/${id}`;
  try { await sendBatch(tenantId, id, { limit: 15 }); } catch (e) { fail(back, e); }
  revalidatePath(back); done(back);
}

export async function cancelCampaignAction(form: FormData) {
  const { user, tenantId } = await requirePermission("marketing:manage");
  const id = String(form.get("id") ?? ""), back = `/marketing/campaigns/${id}`;
  try { await cancelCampaign(tenantId, id); await audit({ tenantId, actorId: user.id, action: "campaign.cancel", entity: "Campaign", entityId: id }); } catch (e) { fail(back, e); }
  revalidatePath(back); done(back);
}

/** Consentimiento comercial registrado por el personal: exige constancia de cómo se obtuvo (Ley 29733). */
export async function setConsentAction(form: FormData) {
  const { user, tenantId } = await requirePermission("families:write");
  const guardianId = String(form.get("guardianId") ?? ""), granted = form.get("granted") === "1";
  const back = String(form.get("back") ?? "/families").startsWith("/") ? String(form.get("back") ?? "/families") : "/families";
  try {
    const changed = await setMarketingConsent({ tenantId, guardianId, granted, source: String(form.get("source") ?? "") === "FORM" ? "FORM" : "STAFF", evidence: String(form.get("evidence") ?? ""), recordedById: user.id });
    if (changed) await audit({ tenantId, actorId: user.id, action: granted ? "consent.grant" : "consent.revoke", entity: "Guardian", entityId: guardianId });
  } catch (e) { fail(back, e); }
  revalidatePath(back); done(back);
}
