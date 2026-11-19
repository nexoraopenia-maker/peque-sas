import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { BillingError, retryBusy } from "@/lib/billing/service";
import { isDate, isTime } from "./calendar";
import { limaDate, limaMinutesOfDay } from "@/lib/utils/date";
import { canTransition, needsSpace, type ReservationService } from "./status";

/**
 * Reservas. La validación de disponibilidad y el INSERT ocurren en UNA sola sentencia SQL, por lo que dos reservas
 * simultáneas no pueden superar el aforo ni ocupar el mismo espacio a la vez (SQLite serializa las escrituras).
 * El aforo es conservador: suma los asistentes de TODAS las reservas activas que se solapan con la franja.
 */
export type NewReservation = {
  tenantId: string; userId: string; serviceType: ReservationService; childId?: string | null; spaceId?: string | null;
  contactName: string; contactPhone?: string; date: string; startTime: string; endTime: string; attendees: number;
  packageName?: string; details?: string; notes?: string; totalAmountCents: number; advanceRequiredCents: number;
};

const hhmmNow = () => { const m = limaMinutesOfDay(new Date()); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

/** Capacidad del pool compartido (ludoteca o guardería). */
export async function poolCapacity(tenantId: string, service: "LUDOTECA" | "GUARDERIA") {
  const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { playgroundCapacity: true, daycareCapacity: true } });
  return service === "LUDOTECA" ? t.playgroundCapacity : t.daycareCapacity;
}

/** Asistentes ya comprometidos en la franja (reservas activas que se solapan + menores presentes ahora, si aplica). */
export async function poolUsed(tenantId: string, service: "LUDOTECA" | "GUARDERIA", date: string, start: string, end: string) {
  const rows = await db.$queryRaw<{ n: bigint | number }[]>`
    SELECT COALESCE(SUM("attendees"),0) AS n FROM "Reservation"
    WHERE "tenantId" = ${tenantId} AND "date" = ${date} AND "serviceType" = ${service} AND "status" IN ('PENDING','CONFIRMED')
      AND "startTime" < ${end} AND "endTime" > ${start}`;
  let used = Number(rows[0]?.n ?? 0);
  if (service === "LUDOTECA" && date === limaDate() && start <= hhmmNow() && hhmmNow() < end) {
    used += await db.playgroundSession.count({ where: { tenantId, status: "OPEN" } });
  }
  return used;
}

export async function blockedBy(tenantId: string, date: string, start: string, end: string, spaceId: string | null) {
  return db.scheduleBlock.findFirst({
    where: { tenantId, date, startTime: { lt: end }, endTime: { gt: start }, OR: spaceId ? [{ spaceId: null }, { spaceId }] : [{ spaceId: null }] },
  });
}

async function explain(i: NewReservation): Promise<string> {
  const block = await blockedBy(i.tenantId, i.date, i.startTime, i.endTime, i.spaceId ?? null);
  if (block) return `Horario bloqueado: ${block.reason}`;
  if (needsSpace(i.serviceType)) return "El espacio ya está reservado en ese horario";
  const svc = i.serviceType as "LUDOTECA" | "GUARDERIA";
  const [cap, used] = await Promise.all([poolCapacity(i.tenantId, svc), poolUsed(i.tenantId, svc, i.date, i.startTime, i.endTime)]);
  return `Sin cupo suficiente: quedan ${Math.max(0, cap - used)} de ${cap} en ese horario`;
}

/** Cupos libres de un pool en una franja (para el calendario). */
export async function remaining(tenantId: string, service: "LUDOTECA" | "GUARDERIA", date: string, start: string, end: string) {
  const [cap, used] = await Promise.all([poolCapacity(tenantId, service), poolUsed(tenantId, service, date, start, end)]);
  return Math.max(0, cap - used);
}

export async function createReservation(i: NewReservation): Promise<string> {
  const name = i.contactName.trim();
  if (!name || name.length > 120) throw new BillingError("Indica el nombre del contacto");
  if (!isDate(i.date) || !isTime(i.startTime) || !isTime(i.endTime)) throw new BillingError("Fecha u hora inválidas");
  if (i.startTime >= i.endTime) throw new BillingError("La hora de fin debe ser posterior a la de inicio");
  if (i.date < limaDate()) throw new BillingError("No se puede reservar en una fecha pasada");
  if (!Number.isSafeInteger(i.attendees) || i.attendees < 1 || i.attendees > 1000) throw new BillingError("Número de asistentes inválido");
  for (const c of [i.totalAmountCents, i.advanceRequiredCents]) if (!Number.isSafeInteger(c) || c < 0) throw new BillingError("Importe inválido");
  if (i.advanceRequiredCents > i.totalAmountCents) throw new BillingError("El adelanto requerido no puede superar el total");

  if (i.childId && !(await db.child.findFirst({ where: { id: i.childId, tenantId: i.tenantId }, select: { id: true } }))) throw new BillingError("Menor no válido");
  let spaceId: string | null = null;
  if (needsSpace(i.serviceType)) {
    const space = i.spaceId ? await db.reservationSpace.findFirst({ where: { id: i.spaceId, tenantId: i.tenantId, isActive: true } }) : null;
    if (!space) throw new BillingError("Selecciona un espacio para este servicio");
    if (i.attendees > space.capacity) throw new BillingError(`El espacio admite hasta ${space.capacity} personas`);
    spaceId = space.id;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const common = [id, i.tenantId, i.serviceType, i.childId ?? null, spaceId, name, i.contactPhone?.trim() || null, i.date, i.startTime, i.endTime, i.attendees,
    i.packageName?.trim() || null, i.details?.trim() || null, i.notes?.trim() || null, i.totalAmountCents, i.advanceRequiredCents, i.userId, now] as const;
  const [rid, tid, svc, child, space, cname, phone, date, st, en, att, pkg, det, notes, total, req, uid, ts] = common;
  let affected: number;

  if (needsSpace(i.serviceType)) {
    affected = await retryBusy(() => db.$executeRaw`
      INSERT INTO "Reservation" ("id","tenantId","serviceType","childId","spaceId","contactName","contactPhone","date","startTime","endTime","attendees","status",
        "packageName","details","notes","totalAmountCents","advanceRequiredCents","advancePaidCents","createdById","createdAt","updatedAt")
      SELECT ${rid}, ${tid}, ${svc}, ${child}, ${space}, ${cname}, ${phone}, ${date}, ${st}, ${en}, ${att}, 'PENDING', ${pkg}, ${det}, ${notes}, ${total}, ${req}, 0, ${uid}, ${ts}, ${ts}
      WHERE NOT EXISTS (SELECT 1 FROM "Reservation" WHERE "tenantId" = ${tid} AND "spaceId" = ${space} AND "date" = ${date}
                          AND "status" IN ('PENDING','CONFIRMED') AND "startTime" < ${en} AND "endTime" > ${st})
        AND NOT EXISTS (SELECT 1 FROM "ScheduleBlock" WHERE "tenantId" = ${tid} AND "date" = ${date} AND "startTime" < ${en} AND "endTime" > ${st}
                          AND ("spaceId" IS NULL OR "spaceId" = ${space}))`);
  } else {
    const svcPool = i.serviceType as "LUDOTECA" | "GUARDERIA";
    const capacity = await poolCapacity(i.tenantId, svcPool);
    const today = limaDate();
    const nowFlag = svcPool === "LUDOTECA" && date === today && st <= hhmmNow() && hhmmNow() < en ? 1 : 0;
    affected = await retryBusy(() => db.$executeRaw`
      INSERT INTO "Reservation" ("id","tenantId","serviceType","childId","spaceId","contactName","contactPhone","date","startTime","endTime","attendees","status",
        "packageName","details","notes","totalAmountCents","advanceRequiredCents","advancePaidCents","createdById","createdAt","updatedAt")
      SELECT ${rid}, ${tid}, ${svc}, ${child}, NULL, ${cname}, ${phone}, ${date}, ${st}, ${en}, ${att}, 'PENDING', ${pkg}, ${det}, ${notes}, ${total}, ${req}, 0, ${uid}, ${ts}, ${ts}
      WHERE (SELECT COALESCE(SUM("attendees"),0) FROM "Reservation" WHERE "tenantId" = ${tid} AND "date" = ${date} AND "serviceType" = ${svc}
                AND "status" IN ('PENDING','CONFIRMED') AND "startTime" < ${en} AND "endTime" > ${st})
            + (CASE WHEN ${nowFlag} = 1 THEN (SELECT COUNT(*) FROM "PlaygroundSession" WHERE "tenantId" = ${tid} AND "status" = 'OPEN') ELSE 0 END)
            + ${att} <= ${capacity}
        AND NOT EXISTS (SELECT 1 FROM "ScheduleBlock" WHERE "tenantId" = ${tid} AND "date" = ${date} AND "startTime" < ${en} AND "endTime" > ${st} AND "spaceId" IS NULL)`);
  }
  if (affected !== 1) throw new BillingError(await explain({ ...i, spaceId }));
  return id;
}

async function transition(tenantId: string, id: string, to: "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED", extraWhere: Record<string, unknown> = {}) {
  const r = await db.reservation.findFirst({ where: { id, tenantId } });
  if (!r) throw new BillingError("Reserva no encontrada");
  if (!canTransition(r.status, to)) throw new BillingError("Transición de estado no permitida");
  // Condicionado al estado leído: dos cambios simultáneos no pisan el resultado del otro
  const res = await retryBusy(() => db.reservation.updateMany({ where: { id, tenantId, status: r.status, ...extraWhere }, data: { status: to } }));
  return { count: res.count, reservation: r };
}

export const confirmReservation = async (tenantId: string, id: string) => {
  const { count } = await transition(tenantId, id, "CONFIRMED");
  if (count !== 1) throw new BillingError("La reserva cambió de estado");
};

export async function cancelReservation(tenantId: string, id: string, retainAdvance: boolean) {
  const r = await db.reservation.findFirst({ where: { id, tenantId } });
  if (!r) throw new BillingError("Reserva no encontrada");
  if (r.advancePaidCents > 0 && !retainAdvance) {
    throw new BillingError("Tiene un adelanto cobrado: confirma que no se devuelve (las devoluciones aún no están disponibles)");
  }
  const { count } = await transition(tenantId, id, "CANCELLED");
  if (count !== 1) throw new BillingError("La reserva cambió de estado");
}

export const markNoShow = async (tenantId: string, id: string) => {
  const { count } = await transition(tenantId, id, "NO_SHOW");
  if (count !== 1) throw new BillingError("La reserva cambió de estado");
};

/** Solo se completa con el saldo en cero (la condición va en el UPDATE para evitar carreras con un cobro). */
export async function completeReservation(tenantId: string, id: string) {
  const r = await db.reservation.findFirst({ where: { id, tenantId } });
  if (!r) throw new BillingError("Reserva no encontrada");
  if (r.advancePaidCents !== r.totalAmountCents) throw new BillingError("Hay saldo pendiente: liquídalo antes de completar la reserva");
  const { count } = await transition(tenantId, id, "COMPLETED", { advancePaidCents: r.totalAmountCents });
  if (count !== 1) throw new BillingError("La reserva cambió: revisa el saldo");
}

export async function markReminderSent(tenantId: string, userId: string, id: string) {
  const r = await db.reservation.updateMany({ where: { id, tenantId, status: { in: ["PENDING", "CONFIRMED"] } }, data: { reminderSentAt: new Date(), reminderSentById: userId } });
  if (r.count !== 1) throw new BillingError("Reserva no encontrada o ya cerrada");
}

export type AvailabilityQuery = { tenantId: string; serviceType: ReservationService; date: string; startTime: string; endTime: string; attendees: number };
export type Availability = { available: boolean; reason?: "INVALID" | "PAST" | "TOO_FAR" | "CLOSED" | "FULL" | "NO_SPACE"; remaining?: number; spaces?: { id: string; name: string; capacity: number }[] };

/** Consulta de SOLO LECTURA con la misma regla que el alta (aforo compartido o espacio exclusivo + bloqueos). No reserva nada. */
export async function checkAvailability(q: AvailabilityQuery): Promise<Availability> {
  if (!isDate(q.date) || !isTime(q.startTime) || !isTime(q.endTime) || q.startTime >= q.endTime || !Number.isSafeInteger(q.attendees) || q.attendees < 1 || q.attendees > 1000) return { available: false, reason: "INVALID" };
  const today = limaDate();
  if (q.date < today) return { available: false, reason: "PAST" };
  if (q.date > new Date(Date.parse(`${today}T00:00:00Z`) + 365 * 86_400_000).toISOString().slice(0, 10)) return { available: false, reason: "TOO_FAR" };
  if (await blockedBy(q.tenantId, q.date, q.startTime, q.endTime, null)) return { available: false, reason: "CLOSED" };
  if (!needsSpace(q.serviceType)) {
    const svc = q.serviceType as "LUDOTECA" | "GUARDERIA";
    const [cap, used] = await Promise.all([poolCapacity(q.tenantId, svc), poolUsed(q.tenantId, svc, q.date, q.startTime, q.endTime)]);
    const remaining = Math.max(0, cap - used);
    return remaining >= q.attendees ? { available: true, remaining } : { available: false, reason: "FULL", remaining };
  }
  const spaces = await db.reservationSpace.findMany({ where: { tenantId: q.tenantId, isActive: true, capacity: { gte: q.attendees } }, orderBy: { capacity: "asc" } });
  const free: { id: string; name: string; capacity: number }[] = [];
  for (const s of spaces) {
    const busy = await db.reservation.findFirst({ where: { tenantId: q.tenantId, spaceId: s.id, date: q.date, status: { in: ["PENDING", "CONFIRMED"] }, startTime: { lt: q.endTime }, endTime: { gt: q.startTime } }, select: { id: true } });
    if (!busy && !(await blockedBy(q.tenantId, q.date, q.startTime, q.endTime, s.id))) free.push({ id: s.id, name: s.name, capacity: s.capacity });
  }
  return free.length ? { available: true, spaces: free } : { available: false, reason: "NO_SPACE" };
}
