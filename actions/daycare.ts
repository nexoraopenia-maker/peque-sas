"use server";
import { revalidatePath } from "next/cache";
import { requireModule, requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { daycareIncidentSchema, daycareProfileSchema, enrollmentSchema } from "@/lib/validation/schemas";
import { limaDate } from "@/lib/utils/date";
import { lateMinutes } from "@/lib/daycare/time";
import { parsePickup, resolvePickupName } from "@/lib/safety/pickup";
import { checkOutSchema } from "@/lib/validation/schemas";
import { done } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";

const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : "");

export async function createEnrollmentAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:manage");
  const p = enrollmentSchema.safeParse(Object.fromEntries(form));
  if (!p.success) done("/daycare/enrollments", p.error.issues[0]?.message ?? "Revisa los datos");
  const tdb = tenantDb(tenantId);
  if (!(await tdb.child.findFirst({ where: { id: p.data.childId } }))) done("/daycare/enrollments", "Menor no válido");
  try {
    const e = await tdb.enrollment.create({ data: { ...p.data, createdById: user.id } as never });
    await audit({ tenantId, actorId: user.id, action: "daycare.enrollment.create", entity: "Enrollment", entityId: e.id });
  } catch (e) {
    done("/daycare/enrollments", isUnique(e) ? "El menor ya tiene una matrícula activa" : "No se pudo matricular");
  }
  revalidatePath("/daycare");
  done("/daycare/enrollments");
}

export async function closeEnrollmentAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:manage");
  const id = String(form.get("id") ?? "");
  const status = form.get("status") === "CANCELLED" ? "CANCELLED" : "ENDED";
  const r = await tenantDb(tenantId).enrollment.updateMany({
    where: { id, status: "ACTIVE" }, data: { status, endDate: limaDate() },
  });
  if (r.count) await audit({ tenantId, actorId: user.id, action: `daycare.enrollment.${status.toLowerCase()}`, entity: "Enrollment", entityId: id });
  revalidatePath("/daycare");
  done("/daycare/enrollments");
}

export async function checkInAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:attendance");
  const childId = String(form.get("childId") ?? "");
  const tdb = tenantDb(tenantId);
  const enrollment = await tdb.enrollment.findFirst({ where: { childId, status: "ACTIVE" } });
  if (!enrollment) done("/daycare", "El menor no tiene matrícula activa");
  const date = limaDate();
  const now = new Date();
  const late = lateMinutes(enrollment.entryTime, now);
  const existing = await tdb.daycareAttendance.findFirst({ where: { childId, date } });
  if (existing?.checkInAt) done("/daycare", "Ya se registró el ingreso de hoy");
  try {
    if (existing) {
      // Estaba marcado como ausente y llegó: se corrige (condicionado a que siga ausente)
      await tdb.daycareAttendance.updateMany({
        where: { id: existing.id, status: "ABSENT" },
        data: { status: "PRESENT", checkInAt: now, lateMinutes: late, checkedInById: user.id },
      });
    } else {
      await tdb.daycareAttendance.create({
        data: { childId, enrollmentId: enrollment.id, date, status: "PRESENT", checkInAt: now, lateMinutes: late, checkedInById: user.id } as never,
      });
    }
  } catch (e) {
    done("/daycare", isUnique(e) ? "Ya existe un registro de hoy" : "No se pudo registrar el ingreso");
  }
  await audit({ tenantId, actorId: user.id, action: "daycare.checkin", entity: "Child", entityId: childId, metadata: { late } });
  revalidatePath("/daycare");
  done("/daycare");
}

export async function markAbsentAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:attendance");
  const childId = String(form.get("childId") ?? "");
  const tdb = tenantDb(tenantId);
  const enrollment = await tdb.enrollment.findFirst({ where: { childId, status: "ACTIVE" } });
  if (!enrollment) done("/daycare", "El menor no tiene matrícula activa");
  try {
    await tdb.daycareAttendance.create({
      data: { childId, enrollmentId: enrollment.id, date: limaDate(), status: "ABSENT", checkedInById: user.id } as never,
    });
  } catch (e) {
    done("/daycare", isUnique(e) ? "Ya existe un registro de hoy" : "No se pudo registrar");
  }
  await audit({ tenantId, actorId: user.id, action: "daycare.absent", entity: "Child", entityId: childId });
  revalidatePath("/daycare");
  done("/daycare");
}

export async function checkOutAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:attendance");
  const attendanceId = String(form.get("attendanceId") ?? "");
  const parsed = checkOutSchema.safeParse({ sessionId: attendanceId, pickup: form.get("pickup") });
  const choice = parsed.success ? parsePickup(parsed.data.pickup) : null;
  if (!choice) done("/daycare", "Selecciona quién retira al menor");
  const tdb = tenantDb(tenantId);
  const att = await tdb.daycareAttendance.findFirst({ where: { id: attendanceId, date: limaDate(), status: "PRESENT", checkOutAt: null } });
  if (!att) done("/daycare", "Registro no encontrado o ya con salida");
  const name = await resolvePickupName(tenantId, att.childId, choice);
  if (!name) done("/daycare", "La persona no está autorizada para retirar a este menor");
  const now = new Date();
  const r = await tdb.daycareAttendance.updateMany({
    where: { id: att.id, checkOutAt: null },
    data: { checkOutAt: now, pickedUpBy: name, pickupKind: choice.kind, pickupRefId: choice.id, checkedOutById: user.id },
  });
  if (r.count !== 1) done("/daycare", "La salida ya estaba registrada");
  // Si quedó una siesta abierta, se cierra con la salida
  await tdb.daycareLog.updateMany({ where: { childId: att.childId, kind: "NAP", endedAt: null }, data: { endedAt: now } });
  await audit({ tenantId, actorId: user.id, action: "daycare.checkout", entity: "Child", entityId: att.childId, metadata: { pickupKind: choice.kind } });
  revalidatePath("/daycare");
  done("/daycare");
}

export async function createIncidentAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:attendance");
  const p = daycareIncidentSchema.safeParse(Object.fromEntries(form));
  if (!p.success) done("/daycare/incidents", "Describe la incidencia (mínimo 3 caracteres)");
  const tdb = tenantDb(tenantId);
  if (!(await tdb.child.findFirst({ where: { id: p.data.childId } }))) done("/daycare/incidents", "Menor no válido");
  const inc = await tdb.daycareIncident.create({ data: { ...p.data, date: limaDate(), reportedById: user.id } as never });
  // Sin el texto de la incidencia en la auditoría (dato de un menor)
  await audit({ tenantId, actorId: user.id, action: "daycare.incident.create", entity: "DaycareIncident", entityId: inc.id, metadata: { type: p.data.type } });
  revalidatePath("/daycare/incidents");
  done("/daycare/incidents");
}

export async function saveProfileAction(form: FormData) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:manage");
  const p = daycareProfileSchema.safeParse(Object.fromEntries(form));
  const back = `/daycare/children/${String(form.get("childId") ?? "")}`;
  if (!p.success) done(back, "Revisa los datos");
  const tdb = tenantDb(tenantId);
  if (!(await tdb.child.findFirst({ where: { id: p.data.childId } }))) done("/daycare", "Menor no válido");
  const { childId, ...data } = p.data;
  const existing = await tdb.daycareProfile.findFirst({ where: { childId } });
  if (existing) await tdb.daycareProfile.updateMany({ where: { id: existing.id }, data: { ...data, updatedById: user.id } });
  else await tdb.daycareProfile.create({ data: { childId, ...data, updatedById: user.id } as never });
  await audit({ tenantId, actorId: user.id, action: "daycare.profile.save", entity: "Child", entityId: childId });
  revalidatePath(back);
  done(back);
}
