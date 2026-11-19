import "server-only";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { limaDate } from "@/lib/utils/date";
import { describeLog, type LogKind } from "@/lib/daycare/log";

/**
 * Datos del portal de padres. REGLA DE SEGURIDAD: toda función que lee datos de un menor recibe un `MyChild`, y la ÚNICA
 * forma de obtenerlo es `requireMyChild`, que verifica en `ChildGuardian` que el apoderado de la sesión esté vinculado a ese
 * menor dentro de SU establecimiento. El tenantId y el apoderado salen de la sesión, nunca del navegador.
 * Se devuelven solo los campos que el apoderado debe ver (sin nombres de trabajadores ni DNI de terceros).
 */
export type Me = { id: string; tenantId: string };
export type MyChild = { readonly __brand: "MyChild"; readonly tenantId: string; readonly childId: string; readonly guardianId: string; readonly fullName: string };

export async function myChildren(g: Me) {
  const links = await db.childGuardian.findMany({
    where: { tenantId: g.tenantId, guardianId: g.id },
    include: { child: { select: { id: true, fullName: true, allergies: true, medicalAlerts: true, prepaidMinutes: true } } },
    orderBy: { child: { fullName: "asc" } },
  });
  return links.map((l) => l.child);
}

export async function requireMyChild(g: Me, childId: string): Promise<MyChild> {
  const link = await db.childGuardian.findFirst({
    where: { tenantId: g.tenantId, guardianId: g.id, childId: String(childId).slice(0, 64) },
    include: { child: { select: { fullName: true } } },
  });
  if (!link) notFound(); // mismo 404 que un id inexistente: no revela si el menor existe
  return { __brand: "MyChild", tenantId: g.tenantId, childId, guardianId: g.id, fullName: link.child.fullName };
}

const W = (c: MyChild) => ({ tenantId: c.tenantId, childId: c.childId });

export async function childOverview(c: MyChild) {
  const today = limaDate();
  const [child, attendance, open, enrollment, profile, pickups] = await Promise.all([
    db.child.findFirstOrThrow({ where: { id: c.childId, tenantId: c.tenantId }, select: { fullName: true, birthDate: true, allergies: true, medicalAlerts: true, prepaidMinutes: true } }),
    db.daycareAttendance.findFirst({ where: { ...W(c), date: today }, select: { status: true, checkInAt: true, checkOutAt: true, lateMinutes: true } }),
    db.playgroundSession.findFirst({ where: { ...W(c), status: "OPEN" }, select: { checkInAt: true, contractedMinutes: true } }),
    db.enrollment.findFirst({ where: { ...W(c), status: "ACTIVE" }, select: { entryTime: true, exitTime: true, schoolYear: true } }),
    db.daycareProfile.findFirst({ where: W(c), select: { bloodType: true, pediatrician: true, pediatricianPhone: true, insurance: true, medications: true, dietaryNotes: true, emergencyContactName: true, emergencyContactPhone: true, photoConsent: true } }),
    db.authorizedPickup.findMany({ where: { ...W(c), isActive: true }, select: { fullName: true, relationship: true } }),
  ]);
  return { child, attendance, openPlayground: open, enrollment, profile, pickups };
}

/** Bitácora de la pizarra: SOLO registros marcados como visibles para los padres. */
export async function dayLog(c: MyChild, date: string) {
  const logs = await db.daycareLog.findMany({ where: { ...W(c), date, visibleToParents: true }, orderBy: { occurredAt: "asc" }, select: { id: true, kind: true, subtype: true, level: true, notes: true, occurredAt: true, endedAt: true } });
  return logs.map((l) => ({ id: l.id, at: l.occurredAt, text: describeLog({ ...l, kind: l.kind as LogKind }) }));
}

export const recentNews = (c: MyChild) =>
  db.daycareNotification.findMany({ where: W(c), orderBy: { createdAt: "desc" }, take: 20, select: { id: true, message: true, createdAt: true } });

export async function attendanceMonth(c: MyChild, month: string) {
  return db.daycareAttendance.findMany({
    where: { ...W(c), date: { gte: `${month}-01`, lte: `${month}-31` } }, orderBy: { date: "asc" },
    select: { date: true, status: true, checkInAt: true, checkOutAt: true, lateMinutes: true },
  });
}

export const playgroundHistory = (c: MyChild) =>
  db.playgroundSession.findMany({ where: W(c), orderBy: { checkInAt: "desc" }, take: 20, select: { id: true, status: true, checkInAt: true, checkOutAt: true, contractedMinutes: true, amountCents: true } });

export async function incidents(c: MyChild) {
  const [daycare, playground] = await Promise.all([
    db.daycareIncident.findMany({ where: W(c), orderBy: { createdAt: "desc" }, take: 20, select: { id: true, date: true, type: true, description: true, parentNotified: true } }),
    db.playgroundIncident.findMany({ where: W(c), orderBy: { createdAt: "desc" }, take: 20, select: { id: true, createdAt: true, type: true, description: true } }),
  ]);
  return [
    ...daycare.map((i) => ({ id: i.id, date: i.date, area: "Guardería" as const, type: i.type, description: i.description })),
    ...playground.map((i) => ({ id: i.id, date: limaDate(i.createdAt), area: "Ludoteca" as const, type: i.type, description: i.description })),
  ].sort((a, b) => b.date.localeCompare(a.date));
}

export async function finances(c: MyChild) {
  const today = limaDate();
  const [child, ledger, invoices, sales] = await Promise.all([
    db.child.findFirstOrThrow({ where: { id: c.childId, tenantId: c.tenantId }, select: { prepaidMinutes: true } }),
    db.prepaidLedger.findMany({ where: W(c), orderBy: { createdAt: "desc" }, take: 30, select: { id: true, type: true, minutes: true, balanceAfter: true, createdAt: true } }),
    db.daycareInvoice.findMany({ where: W(c), orderBy: { period: "desc" }, select: { id: true, period: true, amountCents: true, dueDate: true, status: true, paidAt: true } }),
    db.sale.findMany({ where: W(c), orderBy: { createdAt: "desc" }, take: 20, select: { id: true, kind: true, totalCents: true, createdAt: true } }),
  ]);
  const pending = invoices.filter((i) => i.status === "PENDING");
  const overdue = pending.filter((i) => i.dueDate < today);
  return {
    prepaidMinutes: child.prepaidMinutes, ledger, invoices, sales,
    pendingCents: pending.reduce((n, i) => n + i.amountCents, 0), overdueCents: overdue.reduce((n, i) => n + i.amountCents, 0), overdueCount: overdue.length,
  };
}

export async function reservations(c: MyChild) {
  const today = limaDate();
  const rows = await db.reservation.findMany({
    where: { tenantId: c.tenantId, childId: c.childId }, orderBy: [{ date: "desc" }, { startTime: "asc" }], take: 40,
    select: { id: true, serviceType: true, date: true, startTime: true, endTime: true, status: true, attendees: true, packageName: true, totalAmountCents: true, advancePaidCents: true },
  });
  return { upcoming: rows.filter((r) => r.date >= today && (r.status === "PENDING" || r.status === "CONFIRMED")).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)), past: rows.filter((r) => !(r.date >= today && (r.status === "PENDING" || r.status === "CONFIRMED"))) };
}
