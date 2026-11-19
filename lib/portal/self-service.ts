import "server-only";
import { db } from "@/lib/db";
import { PortalError, issueAccessCode } from "./auth";
import { FAIL_WINDOW_MS, MAX_REQUESTS_PER_IDENTIFIER, MAX_REQUESTS_PER_PORTAL, REQUEST_COOLDOWN_MS, normalizeIdentifier, normalizePortalCode, requestKeys } from "./identity";
import { canDeliverPortalCode, notifyPortalCode } from "@/lib/whatsapp/notify";
import type { Fetch } from "@/lib/whatsapp/service";

export const REQUEST_MESSAGE = "Si los datos coinciden y el establecimiento tiene WhatsApp activo, recibirás un código en el teléfono registrado. Si no te llega, pídelo en recepción.";

/**
 * Autoservicio: el apoderado pide su código y se envía por WhatsApp SOLO al teléfono registrado del apoderado (nunca a un número
 * dado por quien solicita). La respuesta es siempre la misma (no revela si el apoderado existe). Cada solicitud cuenta contra el
 * límite (por identificador y por portal), exista o no el apoderado, para impedir abuso del WhatsApp del establecimiento.
 */
export async function requestCodeViaWhatsApp(i: { portalCode: string; identifier: string; fetchImpl?: Fetch }): Promise<{ limited: boolean }> {
  const portalCode = normalizePortalCode(i.portalCode);
  const id = normalizeIdentifier(i.identifier);
  const keys = requestKeys(portalCode, id ? id.value : i.identifier.trim().slice(0, 40));
  const since = new Date(Date.now() - FAIL_WINDOW_MS);
  const [a, b] = await Promise.all([
    db.parentAuthEvent.count({ where: { key: keys.perIdentifier, createdAt: { gte: since } } }),
    db.parentAuthEvent.count({ where: { key: keys.perPortal, createdAt: { gte: since } } }),
  ]);
  if (a >= MAX_REQUESTS_PER_IDENTIFIER || b >= MAX_REQUESTS_PER_PORTAL) return { limited: true };
  await db.parentAuthEvent.createMany({ data: [{ key: keys.perIdentifier }, { key: keys.perPortal }] });
  if (!id || portalCode.length < 6) return { limited: false };

  const tenant = await db.tenant.findUnique({ where: { portalCode } });
  if (!tenant || !tenant.portalEnabled || tenant.status === "SUSPENDED") return { limited: false };
  const wa = await db.whatsAppConfig.findUnique({ where: { tenantId: tenant.id }, select: { enabled: true } });
  if (!wa?.enabled) return { limited: false };

  const guardians = await db.guardian.findMany({
    where: { tenantId: tenant.id, portalBlocked: false, phoneDigits: { not: null }, ...(id.kind === "dni" ? { dni: id.value } : { phoneDigits: id.value }) },
    select: { id: true }, take: 3,
  });
  for (const g of guardians) {
    const recent = await db.parentAccessCode.findFirst({ where: { tenantId: tenant.id, guardianId: g.id, createdAt: { gt: new Date(Date.now() - REQUEST_COOLDOWN_MS) } }, select: { id: true } });
    if (recent) continue; // enfriamiento por apoderado
    if (!(await canDeliverPortalCode(tenant.id, g.id))) continue; // sin plantilla ni ventana abierta no se puede entregar: no se emite el código
    try {
      const r = await issueAccessCode({ tenantId: tenant.id, guardianId: g.id, createdById: "self-service" });
      await notifyPortalCode({ tenantId: tenant.id, guardianId: g.id, code: r.code, minutes: 15, fetchImpl: i.fetchImpl });
    } catch (e) { if (!(e instanceof PortalError)) throw e; }
  }
  return { limited: false };
}
