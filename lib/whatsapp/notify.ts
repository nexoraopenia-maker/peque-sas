import "server-only";
import { db } from "@/lib/db";
import { formatSoles } from "@/lib/billing/money";
import { limaDate } from "@/lib/utils/date";
import { addDays } from "@/lib/reservations/calendar";
import { SERVICE_LABEL, balanceCents } from "@/lib/reservations/status";
import type { TemplateComponent } from "./graph";
import { deliver, loadActive, type Fetch, type SendResult } from "./service";
import { inServiceWindow, toWaId } from "./phone";

/**
 * Puntos de disparo reales. Solo envían si el establecimiento tiene WhatsApp configurado, probado y ACTIVO; si no, devuelven
 * un resultado explícito (NOT_CONFIGURED, NO_TEMPLATE, …) y nunca fingen un envío. Ninguna función lanza.
 * Los parámetros de plantilla no admiten saltos de línea ni espacios repetidos: se limpian.
 */
const clean = (s: string, max = 100) => s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
const body = (...texts: string[]): TemplateComponent => ({ type: "body", parameters: texts.map((t) => ({ type: "text" as const, text: clean(t) })) });

/**
 * ¿Se podrá entregar el código del portal a este apoderado? Con plantilla aprobada sí; sin plantilla solo si el apoderado escribió
 * en las últimas 24 h. Sirve para NO emitir códigos que luego no se pueden entregar.
 */
export async function canDeliverPortalCode(tenantId: string, guardianId: string): Promise<boolean> {
  const cfg = await loadActive(tenantId);
  if (!cfg) return false;
  const g = await db.guardian.findFirst({ where: { id: guardianId, tenantId }, select: { phoneDigits: true, phone: true } });
  const waId = toWaId(g?.phoneDigits ?? g?.phone, cfg.countryCode);
  if (!waId) return false;
  if (cfg.tplPortalCode) return true;
  const conv = await db.whatsAppConversation.findFirst({ where: { tenantId, waId }, select: { lastInboundAt: true } });
  return inServiceWindow(conv?.lastInboundAt);
}

// a) Código de acceso del portal de padres
export async function notifyPortalCode(i: { tenantId: string; guardianId: string; code: string; minutes: number; sentById?: string; fetchImpl?: Fetch }): Promise<SendResult> {
  const cfg = await loadActive(i.tenantId);
  if (!cfg) return { ok: false, reason: "NOT_CONFIGURED" };
  const g = await db.guardian.findFirst({ where: { id: i.guardianId, tenantId: i.tenantId }, select: { phoneDigits: true, phone: true } });
  const t = await db.tenant.findUnique({ where: { id: i.tenantId }, select: { name: true } });
  const common = { tenantId: i.tenantId, to: g?.phoneDigits ?? g?.phone, purpose: "PORTAL_CODE", relatedType: "Guardian", relatedId: i.guardianId, sentById: i.sentById, fetchImpl: i.fetchImpl,
    storedBody: "Código de acceso al portal (omitido por seguridad)" };
  if (cfg.tplPortalCode) {
    // Plantilla de AUTENTICACIÓN: el código va en el cuerpo y en el botón (copiar código). UTILIDAD: código y minutos de vigencia.
    const components: TemplateComponent[] = cfg.portalCodeTplKind === "AUTHENTICATION"
      ? [body(i.code), { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: i.code }] }]
      : [body(i.code, String(i.minutes))];
    return deliver({ ...common, template: { name: cfg.tplPortalCode, components } });
  }
  return deliver({ ...common, text: `Tu código de acceso al portal de padres de ${t?.name ?? "tu centro"} es ${i.code}. Vence en ${i.minutes} minutos y sirve una sola vez. No lo compartas.` });
}

// b) Recordatorio de reserva
export async function notifyReservationReminder(i: { tenantId: string; reservationId: string; sentById?: string; fetchImpl?: Fetch }): Promise<SendResult> {
  const cfg = await loadActive(i.tenantId);
  if (!cfg) return { ok: false, reason: "NOT_CONFIGURED" };
  const r = await db.reservation.findFirst({ where: { id: i.reservationId, tenantId: i.tenantId } });
  if (!r) return { ok: false, reason: "ERROR", detail: "Reserva no encontrada" };
  const base = { tenantId: i.tenantId, to: r.contactPhone, purpose: "RESERVATION_REMINDER", relatedType: "Reservation", relatedId: r.id, sentById: i.sentById, fetchImpl: i.fetchImpl };
  const saldo = formatSoles(balanceCents(r));
  if (cfg.tplReservationReminder) return deliver({ ...base, template: { name: cfg.tplReservationReminder, components: [body(r.contactName, r.date, r.startTime, saldo)] } });
  return deliver({ ...base, text: `Hola ${r.contactName}, te recordamos tu reserva de ${SERVICE_LABEL[r.serviceType]} el ${r.date} a las ${r.startTime}. Saldo pendiente: ${saldo}.` });
}

/**
 * Reclama el recordatorio (reminderSentAt) ANTES de enviar: dos ejecuciones simultáneas (cron + botón) no duplican el aviso.
 * Si el envío falla, se libera el reclamo para poder reintentar.
 */
export async function sendReminderClaimed(i: { tenantId: string; reservationId: string; sentById?: string; fetchImpl?: Fetch }): Promise<SendResult | { ok: false; reason: "ALREADY_SENT" }> {
  const claim = await db.reservation.updateMany({ where: { id: i.reservationId, tenantId: i.tenantId, reminderSentAt: null, status: { in: ["PENDING", "CONFIRMED"] } }, data: { reminderSentAt: new Date(), reminderSentById: i.sentById ?? null } });
  if (claim.count !== 1) return { ok: false, reason: "ALREADY_SENT" };
  const r = await notifyReservationReminder(i);
  if (!r.ok && r.reason !== "DUPLICATE") await db.reservation.updateMany({ where: { id: i.reservationId, tenantId: i.tenantId }, data: { reminderSentAt: null, reminderSentById: null } });
  return r;
}

/** Cron diario: recordatorios de las reservas de MAÑANA (hora de Lima) con teléfono de contacto, en cada establecimiento con WhatsApp activo. */
export async function runReservationReminders(now = new Date(), fetchImpl?: Fetch) {
  const date = addDays(limaDate(now), 1);
  const tenants = await db.whatsAppConfig.findMany({ where: { enabled: true }, select: { tenantId: true } });
  const out = { date, tenants: tenants.length, sent: 0, failed: 0, skipped: 0 };
  for (const t of tenants) {
    const list = await db.reservation.findMany({
      where: { tenantId: t.tenantId, date, status: { in: ["PENDING", "CONFIRMED"] }, reminderSentAt: null, contactPhone: { not: null } }, select: { id: true }, take: 200,
    });
    for (const r of list) {
      const res = await sendReminderClaimed({ tenantId: t.tenantId, reservationId: r.id, fetchImpl });
      if (res.ok) out.sent++; else if (res.reason === "ALREADY_SENT" || res.reason === "DUPLICATE") out.skipped++; else out.failed++;
    }
  }
  return out;
}

// c) Alerta de descuadre de caja (> S/ 5.00) al propietario
export const CASH_ALERT_THRESHOLD_CENTS = 500;
export async function notifyCashAlert(i: { tenantId: string; sessionId: string; differenceCents: number; expectedCents: number; declaredCents: number; fetchImpl?: Fetch }): Promise<SendResult | { ok: false; reason: "BELOW_THRESHOLD" }> {
  if (Math.abs(i.differenceCents) <= CASH_ALERT_THRESHOLD_CENTS) return { ok: false, reason: "BELOW_THRESHOLD" };
  const cfg = await loadActive(i.tenantId);
  if (!cfg) return { ok: false, reason: "NOT_CONFIGURED" };
  const base = { tenantId: i.tenantId, to: cfg.ownerAlertPhone, purpose: "CASH_ALERT", relatedType: "CashRegisterSession", relatedId: i.sessionId, fetchImpl: i.fetchImpl };
  const kind = i.differenceCents < 0 ? "faltante" : "sobrante";
  if (cfg.tplCashAlert) return deliver({ ...base, template: { name: cfg.tplCashAlert, components: [body(formatSoles(i.differenceCents), formatSoles(i.expectedCents), formatSoles(i.declaredCents), limaDate())] } });
  return deliver({ ...base, text: `Alerta de caja: cierre con ${kind} de ${formatSoles(Math.abs(i.differenceCents))}. Esperado ${formatSoles(i.expectedCents)}, contado ${formatSoles(i.declaredCents)}.` });
}

/** Texto en español para mostrar al personal cuando un envío no salió. */
export function describeSendFailure(r: { ok: false; reason: string; detail?: string }): string {
  switch (r.reason) {
    case "NOT_CONFIGURED": return "WhatsApp no está configurado o activo en este establecimiento";
    case "INVALID_PHONE": return "No hay un teléfono válido registrado";
    case "OUTSIDE_WINDOW": return "Fuera de la ventana de 24 h y sin plantilla aprobada configurada";
    case "NO_TEMPLATE": return "Falta configurar la plantilla";
    case "DUPLICATE": return "Ya se envió antes";
    case "ALREADY_SENT": return "Ya se envió un recordatorio";
    case "BELOW_THRESHOLD": return "El descuadre no supera el umbral";
    default: return r.detail ? `Meta respondió: ${r.detail}` : "No se pudo enviar";
  }
}
