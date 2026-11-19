import "server-only";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { retryBusy } from "@/lib/billing/service";
import { decryptSecret, hashVerifyToken } from "./crypto";
import { verifySignature } from "./signature";
import { revokeByPhone } from "@/lib/marketing/consent";
import { isOptOut } from "@/lib/marketing/pure";

/**
 * Webhook de WhatsApp (URL única, enruta por phone_number_id).
 * Orden de seguridad: 1) tamaño, 2) se extraen SOLO los phone_number_id para elegir qué secretos probar (sin efectos),
 * 3) se valida X-Hub-Signature-256, 4) solo entonces se procesa. Cada cambio se atribuye a un tenant únicamente si el secreto
 * que firmó el cuerpo es el secreto efectivo de ESE tenant: un tenant con su propia app de Meta no puede inyectar eventos en otro.
 */
const MAX_BODY = 1_000_000;
const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e));

/** `jobs`: conversaciones con mensajes NUEVOS que el bot debe atender (se ejecutan después de responder 200 a Meta). */
export type BotJob = { tenantId: string; conversationId: string; optOutRevoked?: number };
export type WebhookResult = { status: number; body: string; jobs?: BotJob[] };

type Cfg = Awaited<ReturnType<typeof db.whatsAppConfig.findMany>>[number];
const effectiveSecret = (c: Cfg): string | null => {
  try { return c.appSecretEnc ? decryptSecret(c.appSecretEnc, c.tenantId, "appSecret") : process.env.META_APP_SECRET || null; } catch { return null; }
};

// ---------- GET: verificación del webhook ----------
export async function verifyWebhookChallenge(q: { mode?: string | null; token?: string | null; challenge?: string | null }): Promise<WebhookResult> {
  const denied = { status: 403, body: "Forbidden" };
  if (q.mode !== "subscribe" || !q.token || !q.challenge || !/^[\w-]{1,200}$/.test(q.challenge) || q.token.length > 300) return denied;
  const global = process.env.META_VERIFY_TOKEN;
  if (global && global.length === q.token.length && timingSafeEqual(Buffer.from(global), Buffer.from(q.token))) return { status: 200, body: q.challenge };
  const cfg = await db.whatsAppConfig.findUnique({ where: { verifyTokenHash: hashVerifyToken(q.token) }, select: { id: true } });
  return cfg ? { status: 200, body: q.challenge } : denied;
}

// ---------- Estados de entrega ----------
const RANK: Record<string, number> = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };
const STATUS_MAP: Record<string, "SENT" | "DELIVERED" | "READ" | "FAILED"> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

/**
 * Aplica un estado a un mensaje SALIENTE sin retroceder: READ no vuelve a DELIVERED, un duplicado no cambia nada,
 * FAILED solo desde PENDING/SENT. Devuelve true si cambió algo.
 */
export async function applyStatus(tenantId: string, waMessageId: string, next: "SENT" | "DELIVERED" | "READ" | "FAILED", at: Date, err?: { code?: number; detail?: string }) {
  const lower = Object.entries(RANK).filter(([, r]) => (next === "FAILED" ? r <= 1 : r < RANK[next]!)).map(([s]) => s) as ("PENDING" | "SENT" | "DELIVERED" | "READ")[];
  const r = await retryBusy(() => db.whatsAppMessage.updateMany({
    where: { tenantId, waMessageId, direction: "OUT", status: { in: lower } },
    data: { status: next, statusAt: at, ...(next === "FAILED" ? { errorCode: err?.code ?? null, errorDetail: err?.detail?.slice(0, 300) ?? null } : {}) },
  }));
  return r.count > 0;
}

async function ensureConversation(tenantId: string, waId: string, name?: string | null) {
  const find = () => db.whatsAppConversation.findFirst({ where: { tenantId, waId } });
  const found = await find();
  if (found) { if (name && name !== found.contactName) await db.whatsAppConversation.updateMany({ where: { id: found.id, tenantId }, data: { contactName: name.slice(0, 100) } }); return found; }
  try { return await db.whatsAppConversation.create({ data: { tenantId, waId, contactName: name?.slice(0, 100) ?? null } }); }
  catch (e) { if (!isUnique(e)) throw e; return (await find())!; } // otro evento la creó a la vez
}
export const conversationFor = ensureConversation;

const TYPES = { text: "TEXT", image: "IMAGE", document: "DOCUMENT", audio: "AUDIO", video: "VIDEO", sticker: "STICKER", location: "LOCATION" } as const;
const dateFromSeconds = (v: unknown) => { const n = Number(v); const d = new Date(n * 1000); return Number.isFinite(n) && n > 1e9 && d.getTime() < Date.now() + 86_400_000 ? d : new Date(); };

type Counts = { messages: number; duplicates: number; statuses: number; orphans: number; ignored: number };

async function processInbound(cfg: Cfg, value: any, m: any, c: Counts, jobs: Map<string, BotJob>) {
  const from = typeof m?.from === "string" ? m.from : typeof m?.from_user_id === "string" ? `u:${m.from_user_id}` : null;
  if (!from || typeof m?.id !== "string" || m.id.length > 200) { c.ignored++; return; }
  const type = (TYPES as Record<string, string>)[m.type] ?? "OTHER";
  const payload = m[m.type] ?? {};
  const body = (type === "TEXT" ? payload.body : type === "OTHER" ? (m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : payload.caption) as unknown;
  const contact = (value.contacts ?? []).find((x: any) => x?.wa_id === m.from);
  const conv = await ensureConversation(cfg.tenantId, from, contact?.profile?.name);
  const at = dateFromSeconds(m.timestamp);
  try {
    await retryBusy(() => db.whatsAppMessage.create({
      data: {
        tenantId: cfg.tenantId, conversationId: conv.id, waMessageId: m.id, direction: "IN", type: type as never, status: "RECEIVED", authorKind: "CUSTOMER",
        body: typeof body === "string" ? body.slice(0, 4096) : null, mediaId: typeof payload.id === "string" ? payload.id.slice(0, 100) : null,
        mediaMime: typeof payload.mime_type === "string" ? payload.mime_type.slice(0, 100) : null, createdAt: at,
      },
    }));
  } catch (e) {
    if (isUnique(e)) { c.duplicates++; return; } // Meta reintenta: mismo wamid → se ignora (idempotente)
    throw e;
  }
  c.messages++;
  // La ventana de 24 h solo puede avanzar
  await db.whatsAppConversation.updateMany({ where: { id: conv.id, tenantId: cfg.tenantId, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }] }, data: { lastInboundAt: at, lastMessageAt: at } });
  // Un mensaje nuevo reabre una conversación cerrada
  await db.whatsAppConversation.updateMany({ where: { id: conv.id, tenantId: cfg.tenantId, status: "CLOSED" }, data: { status: "OPEN" } });
  // Baja del marketing (Ley 29733): una palabra clave EXACTA revoca el consentimiento de inmediato, aunque el bot esté apagado, y el bot no la responde
  let optOutRevoked = 0;
  if (type === "TEXT" && typeof body === "string" && isOptOut(body)) {
    optOutRevoked = await revokeByPhone(cfg.tenantId, from);
    await db.whatsAppMessage.updateMany({ where: { tenantId: cfg.tenantId, waMessageId: m.id }, data: { botHandledAt: new Date() } });
  }
  jobs.set(conv.id, { tenantId: cfg.tenantId, conversationId: conv.id, optOutRevoked });
}

async function processStatus(cfg: Cfg, s: any, c: Counts) {
  const next = typeof s?.status === "string" ? STATUS_MAP[s.status] : undefined;
  if (!next || typeof s?.id !== "string" || s.id.length > 200) { c.ignored++; return; }
  const at = dateFromSeconds(s.timestamp);
  const e = Array.isArray(s.errors) ? s.errors[0] : undefined;
  const err = e ? { code: typeof e.code === "number" ? e.code : undefined, detail: String(e.error_data?.details ?? e.title ?? e.message ?? "").slice(0, 300) } : undefined;
  const exists = await db.whatsAppMessage.findFirst({ where: { tenantId: cfg.tenantId, waMessageId: s.id, direction: "OUT" }, select: { id: true } });
  if (exists) { await applyStatus(cfg.tenantId, s.id, next, at, err); c.statuses++; return; }
  // El estado llegó antes de guardar el id del envío: se guarda y se aplica cuando el envío termine
  await db.whatsAppOrphanStatus.create({ data: { tenantId: cfg.tenantId, waMessageId: s.id, status: next, errorCode: err?.code ?? null, errorDetail: err?.detail ?? null, at } });
  c.orphans++;
}

export async function handleWebhookPost(raw: Buffer, signature: string | null): Promise<WebhookResult> {
  if (raw.length === 0 || raw.length > MAX_BODY) return { status: raw.length ? 413 : 400, body: "Bad request" };
  const unauthorized = { status: 401, body: "Invalid signature" };
  // 1) Solo para elegir secretos: sin efectos hasta validar la firma
  let json: any;
  try { json = JSON.parse(raw.toString("utf8")); } catch { return unauthorized; }
  if (json?.object !== "whatsapp_business_account" || !Array.isArray(json.entry)) return unauthorized;
  const ids = new Set<string>();
  for (const e of json.entry.slice(0, 50)) for (const ch of (e?.changes ?? []).slice(0, 50)) {
    const p = ch?.value?.metadata?.phone_number_id;
    if (typeof p === "string" && /^\d{5,30}$/.test(p) && ids.size < 20) ids.add(p);
  }
  const configs = ids.size ? await db.whatsAppConfig.findMany({ where: { phoneNumberId: { in: [...ids] } } }) : [];
  const secrets = new Set<string>();
  for (const c of configs) { const s = effectiveSecret(c); if (s) secrets.add(s); }
  if (process.env.META_APP_SECRET) secrets.add(process.env.META_APP_SECRET);

  // 2) Validación criptográfica obligatoria
  const v = verifySignature(raw, signature, [...secrets]);
  if (!v.ok) return unauthorized;

  // 3) Procesamiento: solo los tenants cuyo secreto efectivo firmó este cuerpo
  const byPid = new Map(configs.filter((c) => effectiveSecret(c) === v.secret && c.enabled).map((c) => [c.phoneNumberId, c]));
  const counts: Counts = { messages: 0, duplicates: 0, statuses: 0, orphans: 0, ignored: 0 };
  const jobs = new Map<string, BotJob>();
  for (const entry of json.entry.slice(0, 50)) for (const ch of (entry?.changes ?? []).slice(0, 50)) {
    if (ch?.field !== "messages") continue;
    const value = ch.value ?? {};
    const cfg = byPid.get(value?.metadata?.phone_number_id);
    if (!cfg) { counts.ignored++; continue; }
    for (const m of (value.messages ?? []).slice(0, 100)) await processInbound(cfg, value, m, counts, jobs);
    for (const s of (value.statuses ?? []).slice(0, 100)) await processStatus(cfg, s, counts);
  }
  return { status: 200, body: JSON.stringify(counts), jobs: [...jobs.values()] };
}
