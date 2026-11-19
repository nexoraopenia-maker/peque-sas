import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { retryBusy } from "@/lib/billing/service";
import { deliver, loadActive, type Fetch } from "@/lib/whatsapp/service";
import { limaDate } from "@/lib/utils/date";
import { normalizeCouponCode } from "./pure";

/**
 * Campañas por WhatsApp con plantillas APROBADAS por Meta. REGLAS (Ley 29733):
 *  - Solo reciben apoderados con consentimiento comercial vigente (marketingConsent = true y sin revocación) y teléfono registrado.
 *  - El consentimiento se vuelve a comprobar al ENVIAR (puede haberse revocado entre la vista previa y el envío).
 *  - Máximo una campaña por apoderado cada 7 días y una sola vez por campaña (índice único).
 *  - Los datos del menor se limitan al nombre de pila, solo para personalizar el mensaje al apoderado.
 */
export class CampaignError extends Error {}
export const FREQUENCY_DAYS = 7;
export const SEGMENT_LABEL = { BIRTHDAY_MONTH: "Cumpleaños del menor este mes", INACTIVE: "Clientes inactivos", PREPAID_LOW: "Cuponera por agotarse" } as const;
type Segment = keyof typeof SEGMENT_LABEL;

export const campaignSchema = z.object({
  name: z.string().trim().min(3).max(80),
  segment: z.enum(["BIRTHDAY_MONTH", "INACTIVE", "PREPAID_LOW"]),
  templateName: z.string().trim().regex(/^[a-z0-9_]{1,200}$/, "Nombre de plantilla inválido (minúsculas, números y guion bajo)"),
  couponCode: z.string().optional().transform((v) => (v ? normalizeCouponCode(v) : null)),
  inactiveDays: z.number().int().min(7).max(730).default(30),
  prepaidMinutesBelow: z.number().int().min(1).max(5000).default(60),
});

export type Audience = { guardianId: string; fullName: string; phoneDigits: string; childFirstName?: string; extraValue?: string };
export type AudienceResult = { eligible: Audience[]; excludedNoConsent: number; excludedNoPhone: number; candidates: number };
const first = (s: string) => s.trim().split(/\s+/)[0] ?? s;

/** Calcula el público de un segmento. SOLO entran apoderados con consentimiento vigente y teléfono; el resto se cuenta como excluido. */
export async function segmentAudience(tenantId: string, c: { segment: Segment; inactiveDays: number; prepaidMinutesBelow: number }, now = new Date()): Promise<AudienceResult> {
  let pairs: { guardianId: string; childFirstName?: string; extraValue?: string }[] = [];
  const links = (childIds: string[]) => (childIds.length ? db.childGuardian.findMany({ where: { tenantId, childId: { in: childIds } }, select: { guardianId: true, childId: true } }) : Promise.resolve([]));

  if (c.segment === "BIRTHDAY_MONTH") {
    const month = Number(limaDate(now).slice(5, 7)) - 1;
    const kids = (await db.child.findMany({ where: { tenantId, birthDate: { not: null } }, select: { id: true, fullName: true, birthDate: true }, take: 5000 })).filter((k) => k.birthDate!.getUTCMonth() === month);
    const byKid = new Map(kids.map((k) => [k.id, k]));
    pairs = (await links(kids.map((k) => k.id))).map((l) => ({ guardianId: l.guardianId, childFirstName: first(byKid.get(l.childId)!.fullName) }));
  } else if (c.segment === "PREPAID_LOW") {
    const kids = await db.child.findMany({ where: { tenantId, prepaidMinutes: { gt: 0, lte: c.prepaidMinutesBelow } }, select: { id: true, fullName: true, prepaidMinutes: true }, take: 5000 });
    const byKid = new Map(kids.map((k) => [k.id, k]));
    pairs = (await links(kids.map((k) => k.id))).map((l) => ({ guardianId: l.guardianId, childFirstName: first(byKid.get(l.childId)!.fullName), extraValue: String(byKid.get(l.childId)!.prepaidMinutes) }));
  } else {
    // Inactivo: tuvo actividad alguna vez, la última fue hace más de N días y no tiene matrícula activa
    const since = new Date(now.getTime() - c.inactiveDays * 86_400_000);
    const [sales, sessions, enrolled] = await Promise.all([
      db.sale.groupBy({ by: ["childId"], where: { tenantId, childId: { not: null } }, _max: { createdAt: true } }),
      db.playgroundSession.groupBy({ by: ["childId"], where: { tenantId }, _max: { checkInAt: true } }),
      db.enrollment.findMany({ where: { tenantId, status: "ACTIVE" }, select: { childId: true } }),
    ]);
    const last = new Map<string, Date>();
    for (const s of sales) if (s.childId && s._max.createdAt) last.set(s.childId, s._max.createdAt);
    for (const s of sessions) if (s._max.checkInAt && (!last.has(s.childId) || last.get(s.childId)! < s._max.checkInAt)) last.set(s.childId, s._max.checkInAt);
    const active = new Set(enrolled.map((e) => e.childId));
    const inactiveKids = [...last].filter(([id, d]) => d < since && !active.has(id)).map(([id]) => id);
    const kidNames = new Map((await db.child.findMany({ where: { tenantId, id: { in: inactiveKids.slice(0, 5000) } }, select: { id: true, fullName: true } })).map((k) => [k.id, k.fullName]));
    const ls = await links(inactiveKids.slice(0, 5000));
    // Un apoderado solo es "inactivo" si TODOS sus hijos con actividad lo están
    const allKidsOf = new Map<string, string[]>();
    for (const l of await db.childGuardian.findMany({ where: { tenantId, guardianId: { in: [...new Set(ls.map((x) => x.guardianId))] } }, select: { guardianId: true, childId: true } })) allKidsOf.set(l.guardianId, [...(allKidsOf.get(l.guardianId) ?? []), l.childId]);
    const inactiveSet = new Set(inactiveKids);
    pairs = ls.filter((l) => (allKidsOf.get(l.guardianId) ?? []).every((k) => inactiveSet.has(k) || !last.has(k) && !active.has(k))).map((l) => ({ guardianId: l.guardianId, childFirstName: first(kidNames.get(l.childId) ?? "") || undefined }));
  }

  // un mensaje por apoderado (el primer hijo que cumpla)
  const unique = new Map<string, (typeof pairs)[number]>();
  for (const p of pairs) if (!unique.has(p.guardianId)) unique.set(p.guardianId, p);
  const guardians = await db.guardian.findMany({ where: { tenantId, id: { in: [...unique.keys()] } }, select: { id: true, fullName: true, phoneDigits: true, marketingConsent: true, marketingRevokedAt: true } });
  const out: AudienceResult = { eligible: [], excludedNoConsent: 0, excludedNoPhone: 0, candidates: guardians.length };
  for (const g of guardians) {
    if (!g.marketingConsent || g.marketingRevokedAt) { out.excludedNoConsent++; continue; }   // Ley 29733: sin consentimiento vigente NO se contacta
    if (!g.phoneDigits) { out.excludedNoPhone++; continue; }
    const p = unique.get(g.id)!;
    out.eligible.push({ guardianId: g.id, fullName: g.fullName, phoneDigits: g.phoneDigits, childFirstName: p.childFirstName, extraValue: p.extraValue });
  }
  return out;
}

export async function createCampaign(tenantId: string, userId: string, input: z.input<typeof campaignSchema>) {
  const d = campaignSchema.parse(input);
  if (d.couponCode) {
    const c = await db.coupon.findFirst({ where: { tenantId, code: d.couponCode, isActive: true } });
    if (!c) throw new CampaignError("El cupón indicado no existe o está desactivado");
  }
  return db.campaign.create({ data: { tenantId, createdById: userId, ...d } });
}

/** Pasa a SENDING (una sola vez) y fija los destinatarios con el consentimiento vigente EN ESTE MOMENTO. */
export async function startCampaign(tenantId: string, id: string, now = new Date()) {
  const c = await db.campaign.findFirst({ where: { id, tenantId } });
  if (!c) throw new CampaignError("Campaña no encontrada");
  if (!(await loadActive(tenantId))) throw new CampaignError("WhatsApp no está activo en este establecimiento");
  const claim = await retryBusy(() => db.campaign.updateMany({ where: { id, tenantId, status: "DRAFT" }, data: { status: "SENDING" } }));
  if (claim.count !== 1) throw new CampaignError("La campaña ya se inició");
  const aud = await segmentAudience(tenantId, c, now);
  for (const a of aud.eligible) {
    try { await db.campaignRecipient.create({ data: { tenantId, campaignId: id, guardianId: a.guardianId, childFirstName: a.childFirstName ?? null, extraValue: a.extraValue ?? null } }); }
    catch (e) { if (!/UNIQUE|constraint/i.test(String(e))) throw e; }
  }
  return { recipients: aud.eligible.length, excludedNoConsent: aud.excludedNoConsent, excludedNoPhone: aud.excludedNoPhone };
}

const params = (c: { segment: Segment; couponCode: string | null }, name: string, r: { childFirstName: string | null; extraValue: string | null }) => {
  const base = [first(name)];
  const seg = c.segment === "BIRTHDAY_MONTH" ? [r.childFirstName ?? "tu hijo/a"] : c.segment === "PREPAID_LOW" ? [r.childFirstName ?? "tu hijo/a", r.extraValue ?? ""] : [];
  return [...base, ...seg, ...(c.couponCode ? [c.couponCode] : [])];
};

/** Envía un lote (apto para serverless). Cada destinatario se reclama antes de enviarse: sin duplicados ni aunque se ejecute dos veces a la vez. */
export async function sendBatch(tenantId: string, id: string, o: { limit?: number; now?: Date; fetchImpl?: Fetch } = {}) {
  const now = o.now ?? new Date();
  const c = await db.campaign.findFirst({ where: { id, tenantId } });
  if (!c || c.status !== "SENDING") return { sent: 0, failed: 0, skipped: 0, remaining: 0, finished: c?.status === "SENT" };
  const pending = await db.campaignRecipient.findMany({ where: { tenantId, campaignId: id, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: o.limit ?? 15, include: { guardian: { select: { fullName: true, phoneDigits: true, marketingConsent: true, marketingRevokedAt: true } } } });
  const out = { sent: 0, failed: 0, skipped: 0, remaining: 0, finished: false };
  const cfg = await loadActive(tenantId);
  const since = new Date(now.getTime() - FREQUENCY_DAYS * 86_400_000);
  for (const r of pending) {
    const claim = await db.campaignRecipient.updateMany({ where: { id: r.id, tenantId, status: "PENDING" }, data: { status: "SENT", reason: "enviando" } });
    if (claim.count !== 1) continue;
    const finish = (status: "SENT" | "FAILED" | "SKIPPED", reason: string | null, messageId?: string) => db.campaignRecipient.updateMany({ where: { id: r.id, tenantId }, data: { status, reason, messageId: messageId ?? null } });
    if (!r.guardian.marketingConsent || r.guardian.marketingRevokedAt) { await finish("SKIPPED", "Sin consentimiento comercial vigente"); out.skipped++; continue; }
    if (!r.guardian.phoneDigits) { await finish("SKIPPED", "Sin teléfono registrado"); out.skipped++; continue; }
    const recent = await db.campaignRecipient.count({ where: { tenantId, guardianId: r.guardianId, status: "SENT", messageId: { not: null }, campaignId: { not: id }, createdAt: { gte: since } } });
    if (recent > 0) { await finish("SKIPPED", `Ya recibió una campaña en los últimos ${FREQUENCY_DAYS} días`); out.skipped++; continue; }
    if (!cfg) { await db.campaignRecipient.updateMany({ where: { id: r.id, tenantId }, data: { status: "PENDING", reason: "WhatsApp inactivo" } }); continue; }
    const res = await deliver({
      tenantId, to: r.guardian.phoneDigits, purpose: "CAMPAIGN", relatedType: "Campaign", relatedId: id, fetchImpl: o.fetchImpl, authorKind: "SYSTEM",
      template: { name: c.templateName, components: [{ type: "body", parameters: params(c, r.guardian.fullName, r).map((t) => ({ type: "text" as const, text: t.replace(/[\r\n\t]+/g, " ").slice(0, 100) })) }] },
    });
    if (res.ok) { await finish("SENT", null, res.messageId); out.sent++; } else { await finish("FAILED", res.detail ?? res.reason); out.failed++; }
  }
  out.remaining = await db.campaignRecipient.count({ where: { tenantId, campaignId: id, status: "PENDING" } });
  if (out.remaining === 0 && cfg) { await db.campaign.updateMany({ where: { id, tenantId, status: "SENDING" }, data: { status: "SENT", sentAt: now } }); out.finished = true; }
  return out;
}

export async function cancelCampaign(tenantId: string, id: string) {
  const r = await db.campaign.updateMany({ where: { id, tenantId, status: { in: ["DRAFT", "SENDING"] } }, data: { status: "CANCELLED" } });
  if (r.count !== 1) throw new CampaignError("La campaña no se puede cancelar");
  await db.campaignRecipient.updateMany({ where: { tenantId, campaignId: id, status: "PENDING" }, data: { status: "SKIPPED", reason: "Campaña cancelada" } });
}

/** Tarea diaria: continúa las campañas que quedaron a medias. */
export async function continueCampaigns(now = new Date(), fetchImpl?: Fetch) {
  const sending = await db.campaign.findMany({ where: { status: "SENDING" }, select: { id: true, tenantId: true }, take: 20 });
  let sent = 0;
  for (const c of sending) sent += (await sendBatch(c.tenantId, c.id, { now, fetchImpl })).sent;
  return { campaigns: sending.length, sent };
}
