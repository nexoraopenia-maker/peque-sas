import "server-only";
import { db } from "@/lib/db";
import { retryBusy } from "@/lib/billing/service";
import { deliver, type Fetch } from "@/lib/whatsapp/service";

export const DEFAULT_HANDOFF = "Te comunico con una persona del equipo para ayudarte mejor. En unos minutos te responden.";

/** Marca como atendidos (por el bot o por una persona) los mensajes entrantes pendientes: el bot no los volverá a responder. */
export const markInboundHandled = (tenantId: string, conversationId: string) =>
  db.whatsAppMessage.updateMany({ where: { tenantId, conversationId, direction: "IN", botHandledAt: null }, data: { botHandledAt: new Date() } });

/**
 * Traspaso a atención humana: el bot se apaga en ESTE chat de inmediato, la conversación queda marcada para el equipo y (opcional)
 * se avisa al cliente UNA sola vez. Es idempotente: repetirlo no vuelve a escribirle al cliente.
 */
export async function handoff(i: { tenantId: string; conversationId: string; reason: string; notifyCustomer: boolean; message?: string | null; fetchImpl?: Fetch }) {
  const conv = await db.whatsAppConversation.findFirst({ where: { id: i.conversationId, tenantId: i.tenantId } });
  if (!conv) return { notified: false };
  const already = conv.needsHuman && !conv.botEnabled;
  await retryBusy(() => db.whatsAppConversation.updateMany({
    where: { id: conv.id, tenantId: i.tenantId },
    data: { needsHuman: true, botEnabled: false, handoffReason: i.reason.slice(0, 200), handoffAt: already ? conv.handoffAt : new Date(), botLockedUntil: null },
  }));
  await markInboundHandled(i.tenantId, conv.id);
  if (!already) await db.conversationNote.create({ data: { tenantId: i.tenantId, conversationId: conv.id, authorId: "bot", body: `Pasó a atención humana. Motivo: ${i.reason.slice(0, 200)}` } });
  if (!i.notifyCustomer || already) return { notified: false };
  const r = await deliver({ tenantId: i.tenantId, to: conv.waId, text: i.message || DEFAULT_HANDOFF, purpose: "BOT_HANDOFF", authorKind: "BOT", fetchImpl: i.fetchImpl });
  return { notified: r.ok };
}
