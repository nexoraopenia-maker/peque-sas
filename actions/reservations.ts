"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { tenantHasModule } from "@/lib/plans/modules";
import { BillingError, payReservation } from "@/lib/billing/service";
import { voucherFromForm, toSale } from "@/lib/sunat/form";
import { issueAfterSale } from "@/lib/sunat/service";
import { parsePayment } from "@/lib/billing/form";
import { parseSoles } from "@/lib/billing/money";
import {
  cancelReservation, completeReservation, confirmReservation, createReservation, markNoShow, markReminderSent,
} from "@/lib/reservations/service";
import { isDate, isTime } from "@/lib/reservations/calendar";
import { done } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";
import { describeSendFailure, sendReminderClaimed } from "@/lib/whatsapp/notify";

const SERVICES = ["LUDOTECA", "CUMPLEANOS", "GUARDERIA", "EVENTO"] as const;
const text = (f: FormData, k: string, max = 300) => String(f.get(k) ?? "").trim().slice(0, max);

/** Cada servicio exige el módulo contratado (comprobación en servidor). */
function serviceAllowed(modules: unknown, s: (typeof SERVICES)[number]) {
  return s === "GUARDERIA" ? tenantHasModule(modules, "DAYCARE") : tenantHasModule(modules, "PLAYGROUND");
}

async function run<T>(back: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BillingError) done(back, e.message);
    throw e;
  }
}

export async function createReservationAction(form: FormData) {
  const { user, tenantId } = await requirePermission("reservations:write");
  const NEW = "/reservations/new";
  const serviceType = text(form, "serviceType") as (typeof SERVICES)[number];
  if (!SERVICES.includes(serviceType) || !serviceAllowed(user.tenant?.modules, serviceType)) done(NEW, "Servicio no disponible en tu plan");
  const total = parseSoles(text(form, "total") || "0");
  const required = parseSoles(text(form, "advanceRequired") || "0");
  if (total === null || required === null) done(NEW, "Importe inválido (máx. 2 decimales)");
  const id = await run(NEW, () => createReservation({
    tenantId, userId: user.id, serviceType, childId: text(form, "childId", 64) || null, spaceId: text(form, "spaceId", 64) || null,
    contactName: text(form, "contactName", 120), contactPhone: text(form, "contactPhone", 20), date: text(form, "date", 10),
    startTime: text(form, "startTime", 5), endTime: text(form, "endTime", 5), attendees: Number(form.get("attendees")),
    packageName: text(form, "packageName", 80), details: text(form, "details", 1000), notes: text(form, "notes", 500),
    totalAmountCents: total, advanceRequiredCents: required,
  }));
  await audit({ tenantId, actorId: user.id, action: "reservation.create", entity: "Reservation", entityId: id, metadata: { serviceType } });
  revalidatePath("/reservations");
  done(`/reservations/${id}`);
}

const detail = (id: string) => `/reservations/${encodeURIComponent(id)}`;

export async function reservationStatusAction(form: FormData) {
  const { user, tenantId } = await requirePermission("reservations:write");
  const id = text(form, "id", 64);
  const op = text(form, "op", 20);
  await run(detail(id), async () => {
    if (op === "confirm") await confirmReservation(tenantId, id);
    else if (op === "cancel") await cancelReservation(tenantId, id, form.get("retain") === "on");
    else if (op === "noshow") await markNoShow(tenantId, id);
    else if (op === "complete") await completeReservation(tenantId, id);
    else if (op === "remind") await markReminderSent(tenantId, user.id, id);
    else throw new BillingError("Operación no válida");
  });
  await audit({ tenantId, actorId: user.id, action: `reservation.${op}`, entity: "Reservation", entityId: id });
  revalidatePath("/reservations");
  done(form.get("back") === "reminders" ? "/reservations/reminders" : detail(id));
}

export async function payReservationAction(form: FormData) {
  const { user, tenantId } = await requirePermission("cash:use");
  const id = text(form, "id", 64);
  const pay = parsePayment(form);
  if ("error" in pay) done(detail(id), pay.error);
  const cents = parseSoles(text(form, "payAmount"));
  if (cents === null || cents <= 0) done(detail(id), "Monto a cobrar inválido");
  const { saleId } = await run(detail(id), () => payReservation({ tenantId, userId: user.id, reservationId: id, amountCents: cents, pay, idempotencyKey: text(form, "key", 64) }));
  await audit({ tenantId, actorId: user.id, action: "reservation.pay", entity: "Sale", entityId: saleId });
  const warn = await issueAfterSale({ tenantId, userId: user.id, saleId, choice: voucherFromForm(form) });
  revalidatePath("/reservations");
  toSale(saleId, warn);
}

export async function addChecklistItemAction(form: FormData) {
  const { tenantId } = await requirePermission("reservations:write");
  const id = text(form, "id", 64), label = text(form, "label", 120);
  if (label.length < 2) done(detail(id), "Escribe la tarea");
  const tdb = tenantDb(tenantId);
  if (!(await tdb.reservation.findFirst({ where: { id } }))) done("/reservations", "Reserva no encontrada");
  await tdb.reservationChecklistItem.create({ data: { reservationId: id, label } as never });
  revalidatePath(detail(id));
  done(detail(id));
}

export async function toggleChecklistItemAction(form: FormData) {
  const { tenantId } = await requirePermission("reservations:write");
  const id = text(form, "id", 64), itemId = text(form, "itemId", 64);
  await tenantDb(tenantId).reservationChecklistItem.updateMany({ where: { id: itemId, reservationId: id }, data: { done: form.get("done") === "true" } });
  revalidatePath(detail(id));
  done(detail(id));
}

export async function createSpaceAction(form: FormData) {
  const { user, tenantId } = await requirePermission("settings:limited");
  const name = text(form, "name", 60), capacity = Number(form.get("capacity"));
  if (!name || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 2000) done("/reservations/settings", "Datos del espacio inválidos");
  const s = await tenantDb(tenantId).reservationSpace.create({ data: { name, capacity } as never });
  await audit({ tenantId, actorId: user.id, action: "reservation.space.create", entity: "ReservationSpace", entityId: s.id });
  revalidatePath("/reservations/settings");
  done("/reservations/settings");
}

export async function createBlockAction(form: FormData) {
  const { user, tenantId } = await requirePermission("settings:limited");
  const BACK = "/reservations/settings";
  const date = text(form, "date", 10), start = text(form, "startTime", 5), end = text(form, "endTime", 5), reason = text(form, "reason", 120);
  if (!isDate(date) || !isTime(start) || !isTime(end) || start >= end || reason.length < 2) done(BACK, "Datos del bloqueo inválidos");
  const tdb = tenantDb(tenantId);
  const spaceId = text(form, "spaceId", 64) || null;
  if (spaceId && !(await tdb.reservationSpace.findFirst({ where: { id: spaceId } }))) done(BACK, "Espacio no válido");
  const b = await tdb.scheduleBlock.create({ data: { date, startTime: start, endTime: end, spaceId, reason, createdById: user.id } as never });
  await audit({ tenantId, actorId: user.id, action: "reservation.block.create", entity: "ScheduleBlock", entityId: b.id });
  revalidatePath("/reservations");
  done(BACK);
}

export async function deleteBlockAction(form: FormData) {
  const { user, tenantId } = await requirePermission("settings:limited");
  const id = text(form, "id", 64);
  const r = await tenantDb(tenantId).scheduleBlock.deleteMany({ where: { id } });
  if (r.count) await audit({ tenantId, actorId: user.id, action: "reservation.block.delete", entity: "ScheduleBlock", entityId: id });
  revalidatePath("/reservations");
  done("/reservations/settings");
}


/** Recordatorio por WhatsApp (plantilla o texto en ventana). El reclamo atómico evita duplicados con el cron. */
export async function sendReservationReminderAction(form: FormData) {
  const { user, tenantId } = await requirePermission("reservations:write");
  const id = text(form, "id", 64);
  const r = await sendReminderClaimed({ tenantId, reservationId: id, sentById: user.id });
  if (!r.ok) done(detail(id), describeSendFailure(r));
  await audit({ tenantId, actorId: user.id, action: "reservation.remind.whatsapp", entity: "Reservation", entityId: id });
  revalidatePath("/reservations");
  done(detail(id));
}
