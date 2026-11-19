import "server-only";
import { db } from "@/lib/db";
import { retryBusy } from "@/lib/billing/service";
import { OUTBOUND_MEDIA } from "./graph";
import { markInboundHandled } from "./bot/handoff";
import { deliver, type Fetch, type SendResult } from "./service";
import { hasPermission } from "@/lib/rbac/permissions";
import { limaDate } from "@/lib/utils/date";

/**
 * Operaciones de la bandeja. Toda lectura/escritura lleva tenantId explícito (viene de la sesión del personal).
 * REGLA CLAVE: cualquier acción de una persona sobre el chat (tomarlo, asignarlo, escribir) apaga el bot de ESE chat de inmediato
 * y marca como atendidos los mensajes pendientes, para que el bot no conteste después.
 */
export class InboxError extends Error {}
const must = (n: number, msg: string) => { if (n !== 1) throw new InboxError(msg); };
const scope = (tenantId: string, id: string) => ({ id, tenantId });

export async function claimConversation(tenantId: string, userId: string, id: string) {
  const r = await retryBusy(() => db.whatsAppConversation.updateMany({ where: { ...scope(tenantId, id) }, data: { assignedToId: userId, botEnabled: false, needsHuman: false, status: "OPEN", staffSeenAt: new Date(), botLockedUntil: null } }));
  must(r.count, "Conversación no encontrada");
  await markInboundHandled(tenantId, id);
}

export async function assignConversation(tenantId: string, id: string, assigneeId: string | null) {
  if (assigneeId) {
    const u = await db.user.findFirst({ where: { id: assigneeId, tenantId, isActive: true }, select: { role: true } });
    if (!u || !hasPermission(u.role, "whatsapp:use")) throw new InboxError("Ese usuario no puede atender WhatsApp");
  }
  const r = await retryBusy(() => db.whatsAppConversation.updateMany({ where: scope(tenantId, id), data: assigneeId ? { assignedToId: assigneeId, botEnabled: false, needsHuman: false, botLockedUntil: null } : { assignedToId: null } }));
  must(r.count, "Conversación no encontrada");
  if (assigneeId) await markInboundHandled(tenantId, id);
}

/** Devuelve el chat al bot: solo atenderá mensajes NUEVOS (los pendientes se marcan como atendidos). */
export async function releaseToBot(tenantId: string, id: string) {
  const r = await retryBusy(() => db.whatsAppConversation.updateMany({ where: scope(tenantId, id), data: { botEnabled: true, assignedToId: null, needsHuman: false, handoffReason: null } }));
  must(r.count, "Conversación no encontrada");
  await markInboundHandled(tenantId, id);
}

export async function setBotEnabled(tenantId: string, id: string, enabled: boolean) {
  const r = await retryBusy(() => db.whatsAppConversation.updateMany({ where: scope(tenantId, id), data: { botEnabled: enabled, ...(enabled ? { needsHuman: false, handoffReason: null } : { botLockedUntil: null }) } }));
  must(r.count, "Conversación no encontrada");
  if (enabled) await markInboundHandled(tenantId, id);
}

/** Cerrar re-activa el bot para futuras consultas (un mensaje nuevo reabre la conversación y la atiende el bot). */
export async function closeConversation(tenantId: string, id: string) {
  const r = await retryBusy(() => db.whatsAppConversation.updateMany({ where: scope(tenantId, id), data: { status: "CLOSED", assignedToId: null, needsHuman: false, botEnabled: true, handoffReason: null } }));
  must(r.count, "Conversación no encontrada");
  await markInboundHandled(tenantId, id);
}
export async function reopenConversation(tenantId: string, id: string) {
  must((await db.whatsAppConversation.updateMany({ where: scope(tenantId, id), data: { status: "OPEN" } })).count, "Conversación no encontrada");
}

export const markSeen = (tenantId: string, id: string) => db.whatsAppConversation.updateMany({ where: scope(tenantId, id), data: { staffSeenAt: new Date() } });

export async function addNote(tenantId: string, userId: string, id: string, body: string) {
  const text = body.trim();
  if (text.length < 2 || text.length > 2000) throw new InboxError("La nota debe tener entre 2 y 2000 caracteres");
  const conv = await db.whatsAppConversation.findFirst({ where: scope(tenantId, id), select: { id: true } });
  if (!conv) throw new InboxError("Conversación no encontrada");
  await db.conversationNote.create({ data: { tenantId, conversationId: id, authorId: userId, body: text } });
}

/** Una persona se hace cargo (si nadie lo estaba) y apaga el bot ANTES de enviar. */
async function takeOver(tenantId: string, userId: string, id: string) {
  const conv = await db.whatsAppConversation.findFirst({ where: scope(tenantId, id) });
  if (!conv) throw new InboxError("Conversación no encontrada");
  await retryBusy(() => db.whatsAppConversation.updateMany({ where: scope(tenantId, id), data: { botEnabled: false, needsHuman: false, status: "OPEN", botLockedUntil: null, ...(conv.assignedToId ? {} : { assignedToId: userId }), staffSeenAt: new Date() } }));
  await markInboundHandled(tenantId, id);
  return conv;
}

export async function sendAgentText(tenantId: string, userId: string, id: string, text: string, fetchImpl?: Fetch): Promise<SendResult> {
  const body = text.trim();
  if (!body) throw new InboxError("Escribe un mensaje");
  if (body.length > 4096) throw new InboxError("El mensaje supera los 4096 caracteres");
  const conv = await takeOver(tenantId, userId, id);
  return deliver({ tenantId, to: conv.waId, text: body, purpose: "AGENT", authorKind: "AGENT", sentById: userId, fetchImpl });
}

/** Firma real del archivo: evita que un archivo se haga pasar por otro tipo (p. ej. un ejecutable "image/png"). */
export function sniffMime(b: Uint8Array): string | null {
  const s = (o: number, ...v: number[]) => v.every((x, i) => b[o + i] === x);
  if (s(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (s(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (s(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (s(0, 0x49, 0x44, 0x33) || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  if (s(0, 0x4f, 0x67, 0x67, 0x53)) return "audio/ogg";
  if (s(4, 0x66, 0x74, 0x79, 0x70)) return "video/mp4";
  return null;
}

export async function sendAgentFile(tenantId: string, userId: string, id: string, file: { bytes: Uint8Array; mime: string; name: string }, caption: string, fetchImpl?: Fetch): Promise<SendResult> {
  const rule = OUTBOUND_MEDIA[file.mime];
  if (!rule) throw new InboxError("Tipo de archivo no permitido (JPG, PNG, PDF, MP3, OGG o MP4)");
  if (file.bytes.length === 0 || file.bytes.length > rule.maxBytes) throw new InboxError(`El archivo debe pesar menos de ${Math.floor(rule.maxBytes / 1048576)} MB`);
  if (sniffMime(file.bytes) !== file.mime) throw new InboxError("El contenido del archivo no coincide con su tipo");
  const conv = await takeOver(tenantId, userId, id);
  return deliver({ tenantId, to: conv.waId, purpose: "AGENT", authorKind: "AGENT", sentById: userId, media: { kind: rule.kind, bytes: file.bytes, mime: file.mime, filename: file.name, caption: caption.trim() || undefined }, fetchImpl });
}

// ---------- Panel del cliente ----------
/** Apoderados cuyo teléfono coincide con el de la conversación, con sus hijos, saldo de cuponera, deudas y reservas. Solo para el personal. */
export async function customerPanel(tenantId: string, waId: string) {
  const digits = waId.replace(/\D/g, "");
  const last9 = digits.length >= 9 ? digits.slice(-9) : null;
  const guardians = last9 ? await db.guardian.findMany({ where: { tenantId, phoneDigits: last9 }, select: { id: true, fullName: true, dni: true, email: true }, take: 5 }) : [];
  const links = guardians.length ? await db.childGuardian.findMany({ where: { tenantId, guardianId: { in: guardians.map((g) => g.id) } }, select: { guardianId: true, childId: true } }) : [];
  const childIds = [...new Set(links.map((l) => l.childId))];
  const today = limaDate();
  const [children, enrollments, invoices, reservations, contactReservations] = await Promise.all([
    childIds.length ? db.child.findMany({ where: { tenantId, id: { in: childIds } }, select: { id: true, fullName: true, allergies: true, medicalAlerts: true, prepaidMinutes: true } }) : [],
    childIds.length ? db.enrollment.findMany({ where: { tenantId, childId: { in: childIds }, status: "ACTIVE" }, select: { childId: true, entryTime: true, exitTime: true } }) : [],
    childIds.length ? db.daycareInvoice.findMany({ where: { tenantId, childId: { in: childIds }, status: "PENDING" }, select: { childId: true, period: true, amountCents: true, dueDate: true } }) : [],
    childIds.length ? db.reservation.findMany({ where: { tenantId, childId: { in: childIds }, date: { gte: today }, status: { in: ["PENDING", "CONFIRMED"] } }, orderBy: [{ date: "asc" }, { startTime: "asc" }], take: 10, select: { id: true, serviceType: true, date: true, startTime: true, endTime: true, status: true } }) : [],
    last9 ? db.reservation.findMany({ where: { tenantId, contactPhone: { not: null }, date: { gte: today }, status: { in: ["PENDING", "CONFIRMED"] } }, orderBy: [{ date: "asc" }], take: 100, select: { id: true, serviceType: true, date: true, startTime: true, endTime: true, status: true, contactPhone: true, childId: true } }) : [],
  ]);
  const byPhone = contactReservations.filter((r) => (r.contactPhone ?? "").replace(/\D/g, "").endsWith(last9 ?? "#")).filter((r) => !reservations.some((x) => x.id === r.id));
  return { guardians, children, enrollments, invoices, reservations: [...reservations, ...byPhone], overdue: invoices.filter((i) => i.dueDate < today), today };
}
