"use server";
import { revalidatePath } from "next/cache";
import { requireModule, requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { tenantDb } from "@/lib/db/tenant";
import { checkInSchema, incidentSchema, rateSchema } from "@/lib/validation/schemas";
import { insertSessionIfCapacity } from "@/lib/playground/checkin";
import { parsePickup, resolvePickupName } from "@/lib/safety/pickup";
import { audit } from "@/lib/audit";
import { BillingError, addConsumption, checkoutPlayground } from "@/lib/billing/service";
import { voucherFromForm, toSale } from "@/lib/sunat/form";
import { issueAfterSale } from "@/lib/sunat/service";
import { parsePayment, promoFromForm } from "@/lib/billing/form";
import { done } from "@/lib/utils/flow";

type State = { error?: string; ok?: boolean } | undefined;

export async function createRateAction(_p: State, form: FormData): Promise<State> {
  await requireModule("PLAYGROUND");
  const { user, tenantId } = await requirePermission("settings:limited");
  const parsed = rateSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Revisa los datos del formulario" };
  const rate = await tenantDb(tenantId).playgroundRate.create({ data: parsed.data as never });
  await audit({ tenantId, actorId: user.id, action: "playground.rate.create", entity: "PlaygroundRate", entityId: rate.id });
  revalidatePath("/playground");
  return { ok: true };
}

export async function checkInAction(_p: State, form: FormData): Promise<State> {
  await requireModule("PLAYGROUND");
  const { user, tenantId } = await requirePermission("playground:use");
  const parsed = checkInSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Revisa los datos del formulario" };
  const { childId, rateId, braceletCode } = parsed.data;
  const tdb = tenantDb(tenantId);

  // Verifica pertenencia al tenant de menor y tarifa (nunca se confía en ids del navegador)
  const [child, rate] = await Promise.all([
    tdb.child.findFirst({ where: { id: childId } }),
    tdb.playgroundRate.findFirst({ where: { id: rateId, isActive: true } }),
  ]);
  if (!child || !rate) return { error: "Menor o tarifa no válidos" };

  try {
    const id = await insertSessionIfCapacity(db, {
      tenantId, childId, rateId, braceletCode, userId: user.id,
      contractedMinutes: rate.minutes, basePriceCents: rate.priceCents, extraMinuteCents: rate.extraMinuteCents,
    });
    if (!id) return { error: "Aforo completo" };
    await audit({ tenantId, actorId: user.id, action: "playground.checkin", entity: "PlaygroundSession", entityId: id });
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e instanceof Error ? e.message : "")) {
      return { error: "El menor ya tiene una sesión abierta o la pulsera está en uso" };
    }
    return { error: "No se pudo registrar el ingreso" };
  }
  revalidatePath("/playground/live");
  return { ok: true };
}

export async function checkOutAction(form: FormData) {
  await requireModule("PLAYGROUND");
  // Cobrar exige además permiso de caja: las profesoras no manejan dinero
  const { user, tenantId } = await requirePermission("playground:use");
  await requirePermission("cash:use");
  const LIVE = "/playground/live";
  const sessionId = String(form.get("sessionId") ?? "");
  const choice = parsePickup(String(form.get("pickup") ?? ""));
  if (!choice) done(LIVE, "Selecciona quién retira al menor");
  const pay = parsePayment(form);
  if ("error" in pay) done(LIVE, pay.error);
  const tdb = tenantDb(tenantId);
  const session = await tdb.playgroundSession.findFirst({ where: { id: sessionId, status: "OPEN" } });
  if (!session) done(LIVE, "Sesión no encontrada o ya cerrada");
  // Solo apoderados con permiso de recoger o personas autorizadas activas de ESTE menor
  const name = await resolvePickupName(tenantId, session.childId, choice);
  if (!name) done(LIVE, "La persona no está autorizada para retirar a este menor");
  let saleId: string;
  try {
    ({ saleId } = await checkoutPlayground({ tenantId, userId: user.id, sessionId, pay, pickup: { kind: choice.kind, refId: choice.id, name }, promo: promoFromForm(form) }));
  } catch (e) {
    if (e instanceof BillingError) done(LIVE, e.message);
    throw e;
  }
  await audit({ tenantId, actorId: user.id, action: "playground.checkout", entity: "PlaygroundSession", entityId: sessionId, metadata: { pickupKind: choice.kind, saleId } });
  const warn = await issueAfterSale({ tenantId, userId: user.id, saleId, choice: voucherFromForm(form) });
  revalidatePath(LIVE);
  toSale(saleId, warn);
}

export async function addConsumptionAction(form: FormData) {
  await requireModule("PLAYGROUND");
  const { user, tenantId } = await requirePermission("playground:use");
  const LIVE = "/playground/live";
  try {
    await addConsumption({ tenantId, userId: user.id, sessionId: String(form.get("sessionId") ?? ""), productId: String(form.get("productId") ?? ""), quantity: Number(form.get("quantity")) });
  } catch (e) {
    if (e instanceof BillingError) done(LIVE, e.message);
    throw e;
  }
  revalidatePath(LIVE);
  done(LIVE);
}

export async function createIncidentAction(_p: State, form: FormData): Promise<State> {
  await requireModule("PLAYGROUND");
  const { user, tenantId } = await requirePermission("playground:use");
  const parsed = incidentSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Describe la incidencia (mínimo 3 caracteres)" };
  const { childId, sessionId, type, description } = parsed.data;
  const tdb = tenantDb(tenantId);

  if (!(await tdb.child.findFirst({ where: { id: childId } }))) return { error: "Menor no válido" };
  if (sessionId && !(await tdb.playgroundSession.findFirst({ where: { id: sessionId, childId } }))) return { error: "Sesión no válida" };

  const inc = await tdb.playgroundIncident.create({ data: { childId, sessionId, type, description, reportedById: user.id } as never });
  // Sin texto de la incidencia en auditoría: contiene datos de un menor
  await audit({ tenantId, actorId: user.id, action: "playground.incident.create", entity: "PlaygroundIncident", entityId: inc.id, metadata: { type } });
  revalidatePath("/playground/live");
  revalidatePath("/playground/history");
  return { ok: true };
}
