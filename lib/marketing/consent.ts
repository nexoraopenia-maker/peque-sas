import "server-only";
import { db } from "@/lib/db";

/**
 * Consentimiento comercial (Ley 29733): explícito, previo, informado y REVOCABLE. Cada otorgamiento o revocación deja una fila inmutable en
 * ConsentEvent (fuente + evidencia + quién lo registró) y el estado vigente en Guardian. Sin consentimiento vigente NO se envía ningún mensaje
 * promocional (lo vuelve a comprobar el envío, no solo la segmentación).
 */
export class ConsentError extends Error {}
export type ConsentSource = "STAFF" | "FORM" | "PORTAL" | "WHATSAPP";

export async function setMarketingConsent(i: { tenantId: string; guardianId: string; granted: boolean; source: ConsentSource; evidence?: string; recordedById?: string }): Promise<boolean> {
  const evidence = i.evidence?.trim().slice(0, 300);
  // Quien registra un consentimiento en nombre del titular debe dejar constancia de CÓMO se obtuvo
  if (i.granted && i.source !== "PORTAL" && (!evidence || evidence.length < 3)) throw new ConsentError("Indica cómo se obtuvo el consentimiento (p. ej. «formulario firmado en recepción»)");
  const now = new Date();
  return db.$transaction(async (tx) => {
    const g = await tx.guardian.findFirst({ where: { id: i.guardianId, tenantId: i.tenantId }, select: { marketingConsent: true } });
    if (!g) throw new ConsentError("Apoderado no encontrado");
    if (g.marketingConsent === i.granted) return false;               // sin cambio: no se duplica la prueba
    const r = await tx.guardian.updateMany({
      where: { id: i.guardianId, tenantId: i.tenantId, marketingConsent: g.marketingConsent },
      data: i.granted
        ? { marketingConsent: true, marketingConsentAt: now, marketingConsentSource: i.source, marketingConsentById: i.recordedById ?? null, marketingRevokedAt: null }
        : { marketingConsent: false, marketingRevokedAt: now },
    });
    if (r.count !== 1) return false;                                   // otro proceso lo cambió a la vez
    await tx.consentEvent.create({ data: { tenantId: i.tenantId, guardianId: i.guardianId, granted: i.granted, source: i.source, evidence: evidence ?? null, recordedById: i.recordedById ?? null } });
    return true;
  }, { maxWait: 10_000, timeout: 30_000 });
}

/** Baja por WhatsApp: revoca a los apoderados del establecimiento cuyo teléfono coincide con el del mensaje. Devuelve cuántos. */
export async function revokeByPhone(tenantId: string, waId: string): Promise<number> {
  const digits = waId.replace(/\D/g, "");
  if (digits.length < 9) return 0;
  const guardians = await db.guardian.findMany({ where: { tenantId, phoneDigits: digits.slice(-9), marketingConsent: true }, select: { id: true } });
  let n = 0;
  for (const g of guardians) if (await setMarketingConsent({ tenantId, guardianId: g.id, granted: false, source: "WHATSAPP", evidence: "Mensaje de baja recibido por WhatsApp" })) n++;
  return n;
}

export const consentHistory = (tenantId: string, guardianId: string) =>
  db.consentEvent.findMany({ where: { tenantId, guardianId }, orderBy: { createdAt: "desc" }, take: 20 });
