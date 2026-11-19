import "server-only";
import { db } from "@/lib/db";
import { retryBusy } from "@/lib/billing/service";
import { z } from "zod";
import { hasFeature } from "@/lib/plans/limits";
import { decryptSecret, encryptSecret, generateVerifyToken, hashVerifyToken } from "./crypto";
import { GraphError, graph, resolveVersion, type GraphConfig, type MediaKind, type TemplateComponent } from "./graph";
import { inServiceWindow, toWaId } from "./phone";
import { applyStatus, conversationFor } from "./webhook";

/** Motor de WhatsApp por establecimiento: configuración cifrada, prueba de conexión, suscripción y envío (texto y plantillas). */
const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e));
export type Fetch = typeof fetch;

// ---------- Configuración ----------
const numericId = z.string().trim().regex(/^\d{5,30}$/, "Debe ser numérico");
const tplName = z.string().trim().regex(/^[a-z0-9_]{1,200}$/, "Solo minúsculas, números y guion bajo").optional().or(z.literal("").transform(() => undefined));
export const configSchema = z.object({
  phoneNumberId: numericId,
  wabaId: numericId,
  accessToken: z.string().trim().regex(/^[A-Za-z0-9_.\-]{20,700}$/, "Token no válido").optional().or(z.literal("").transform(() => undefined)),
  appSecret: z.string().trim().regex(/^[A-Fa-f0-9]{32}$/, "El App Secret tiene 32 caracteres hexadecimales").optional().or(z.literal("").transform(() => undefined)),
  apiVersion: z.string().trim().regex(/^v\d{1,3}\.\d{1,2}$/, "Ejemplo: v27.0").optional().or(z.literal("").transform(() => undefined)),
  countryCode: z.string().trim().regex(/^\d{1,3}$/).default("51"),
  templateLanguage: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/, "Ejemplo: es o es_PE").default("es"),
  tplPortalCode: tplName, portalCodeTplKind: z.enum(["UTILITY", "AUTHENTICATION"]).default("UTILITY"),
  tplReservationReminder: tplName, tplCashAlert: tplName,
  ownerAlertPhone: z.string().trim().optional().or(z.literal("").transform(() => undefined)),
});
export type ConfigInput = z.infer<typeof configSchema>;
export class WhatsAppError extends Error {}

export async function saveConfig(tenantId: string, userId: string, input: ConfigInput) {
  const existing = await db.whatsAppConfig.findUnique({ where: { tenantId } });
  if (!existing && !input.accessToken) throw new WhatsAppError("Indica el token de acceso");
  const owner = input.ownerAlertPhone ? toWaId(input.ownerAlertPhone, input.countryCode) : null;
  if (input.ownerAlertPhone && !owner) throw new WhatsAppError("El teléfono del propietario no es válido");
  // Solo cuenta como cambio de credenciales si el valor es realmente distinto (volver a guardar lo mismo no desactiva WhatsApp)
  const differs = (enc: string | null | undefined, next: string | undefined, field: string) => {
    if (!next) return false;
    if (!existing || !enc) return true;
    try { return decryptSecret(enc, tenantId, field) !== next; } catch { return true; }
  };
  const tokenChanged = differs(existing?.accessTokenEnc, input.accessToken, "accessToken");
  const secretChanged = differs(existing?.appSecretEnc, input.appSecret, "appSecret");
  const identityChanged = !existing || existing.phoneNumberId !== input.phoneNumberId || existing.wabaId !== input.wabaId || tokenChanged || secretChanged;
  const verify = existing ? null : generateVerifyToken();
  const data = {
    phoneNumberId: input.phoneNumberId, wabaId: input.wabaId, apiVersion: input.apiVersion ?? null, countryCode: input.countryCode,
    templateLanguage: input.templateLanguage, tplPortalCode: input.tplPortalCode ?? null, portalCodeTplKind: input.portalCodeTplKind,
    tplReservationReminder: input.tplReservationReminder ?? null, tplCashAlert: input.tplCashAlert ?? null, updatedById: userId,
    // Campo vacío = conservar el teléfono guardado (el formulario no lo muestra completo)
    ...(owner ? { ownerAlertPhone: owner } : {}),
    ...(tokenChanged ? { accessTokenEnc: encryptSecret(input.accessToken!, tenantId, "accessToken"), accessTokenLast4: input.accessToken!.slice(-4) } : {}),
    ...(secretChanged ? { appSecretEnc: encryptSecret(input.appSecret!, tenantId, "appSecret") } : {}),
    // Cambiar número, WABA o credenciales obliga a probar de nuevo la conexión antes de volver a enviar
    ...(identityChanged && existing ? { enabled: false, lastTestOk: null, lastTestError: null, subscribedAt: null } : {}),
  };
  try {
    if (existing) await db.whatsAppConfig.update({ where: { tenantId }, data });
    else await db.whatsAppConfig.create({ data: { tenantId, ...data, accessTokenEnc: data.accessTokenEnc!, accessTokenLast4: data.accessTokenLast4!, verifyTokenEnc: encryptSecret(verify!, tenantId, "verifyToken"), verifyTokenHash: hashVerifyToken(verify!) } });
  } catch (e) {
    if (isUnique(e)) throw new WhatsAppError("Ese número de WhatsApp ya está conectado a otro establecimiento");
    throw e;
  }
}

/** Vista segura para el panel: nunca incluye el token ni el App Secret; el verify token se muestra al propietario para pegarlo en Meta. */
export async function getConfigView(tenantId: string) {
  const c = await db.whatsAppConfig.findUnique({ where: { tenantId } });
  if (!c) return null;
  let verifyToken = "";
  try { verifyToken = decryptSecret(c.verifyTokenEnc, tenantId, "verifyToken"); } catch { /* clave rotada */ }
  const { accessTokenEnc: _a, appSecretEnc: _s, verifyTokenEnc: _v, verifyTokenHash: _h, ...safe } = c;
  void _a; void _s; void _v; void _h;
  return { ...safe, hasAppSecret: !!c.appSecretEnc, verifyToken };
}

export async function regenerateVerifyToken(tenantId: string) {
  const t = generateVerifyToken();
  const r = await db.whatsAppConfig.updateMany({ where: { tenantId }, data: { verifyTokenEnc: encryptSecret(t, tenantId, "verifyToken"), verifyTokenHash: hashVerifyToken(t), subscribedAt: null } });
  if (r.count !== 1) throw new WhatsAppError("Configura WhatsApp primero");
}

type Row = NonNullable<Awaited<ReturnType<typeof db.whatsAppConfig.findUnique>>>;
function graphCfg(c: Row, fetchImpl?: Fetch): GraphConfig {
  return { token: decryptSecret(c.accessTokenEnc, c.tenantId, "accessToken"), version: resolveVersion(c.apiVersion), fetchImpl };
}

const friendly = (e: unknown) => {
  if (!(e instanceof GraphError)) return "Error inesperado";
  if (e.code === 190 || e.status === 401) return "Token inválido o vencido (código 190). Genera un token permanente de System User.";
  if (e.code === 100 || e.status === 400) return `Meta rechazó la solicitud: ${e.details ?? e.message}`;
  if (e.code === 10 || (e.code && e.code >= 200 && e.code < 300)) return "Faltan permisos (whatsapp_business_management / whatsapp_business_messaging).";
  return e.message;
};

/** Prueba REAL contra Graph API: el token debe leer el número y el número debe pertenecer al WABA indicado. No habilita nada por sí sola. */
export async function testConnection(tenantId: string, fetchImpl?: Fetch) {
  const c = await db.whatsAppConfig.findUnique({ where: { tenantId } });
  if (!c) throw new WhatsAppError("Configura WhatsApp primero");
  let ok = false, error: string | null = null, info: Awaited<ReturnType<typeof graph.getPhoneNumber>> | null = null;
  try {
    const g = graphCfg(c, fetchImpl);
    info = await graph.getPhoneNumber(g, c.phoneNumberId);
    const list = await graph.listWabaPhoneNumbers(g, c.wabaId);
    if (!list.data?.some((n) => n.id === c.phoneNumberId)) throw new WhatsAppError("El número no pertenece al WABA indicado");
    ok = true;
  } catch (e) {
    // Un fallo que no es de Graph ni nuestro suele ser credenciales ilegibles (p. ej. cambió AUTH_SECRET): se pide volver a guardarlas
    error = e instanceof WhatsAppError ? e.message : e instanceof GraphError ? friendly(e) : "No se pudieron leer las credenciales guardadas: vuelve a guardar el token y el App Secret.";
  }
  await db.whatsAppConfig.update({ where: { tenantId }, data: {
    lastTestAt: new Date(), lastTestOk: ok, lastTestError: error,
    ...(ok && info ? { displayPhoneNumber: info.display_phone_number ?? null, verifiedName: info.verified_name ?? null, qualityRating: info.quality_rating ?? null } : { enabled: false }),
  } });
  return { ok, error };
}

/** Suscribe la app al WABA. Con override fija la URL del webhook y el verify token de ESTE WABA (requiere https). */
export async function subscribeWebhook(tenantId: string, override: boolean, fetchImpl?: Fetch) {
  const c = await db.whatsAppConfig.findUnique({ where: { tenantId } });
  if (!c?.lastTestOk) throw new WhatsAppError("Prueba la conexión antes de suscribir el webhook");
  let ov: { callbackUrl: string; verifyToken: string } | undefined;
  if (override) {
    const base = process.env.APP_URL ?? "";
    if (!base.startsWith("https://")) throw new WhatsAppError("APP_URL debe ser una URL https pública para fijar el webhook");
    const url = `${base.replace(/\/+$/, "")}/api/webhooks/whatsapp`;
    if (url.length > 200) throw new WhatsAppError("La URL del webhook supera los 200 caracteres permitidos por Meta");
    ov = { callbackUrl: url, verifyToken: decryptSecret(c.verifyTokenEnc, tenantId, "verifyToken") };
  }
  try { await graph.subscribeApp(graphCfg(c, fetchImpl), c.wabaId, ov); }
  catch (e) { throw new WhatsAppError(friendly(e)); }
  await db.whatsAppConfig.update({ where: { tenantId }, data: { subscribedAt: new Date() } });
}

export async function setEnabled(tenantId: string, enabled: boolean) {
  const c = await db.whatsAppConfig.findUnique({ where: { tenantId } });
  if (!c) throw new WhatsAppError("Configura WhatsApp primero");
  if (enabled && !c.lastTestOk) throw new WhatsAppError("Solo se puede activar después de una prueba de conexión exitosa");
  await db.whatsAppConfig.update({ where: { tenantId }, data: { enabled } });
}

export async function loadActive(tenantId: string) {
  const c = await db.whatsAppConfig.findUnique({ where: { tenantId } });
  if (!c || !c.enabled) return null;
  return c;
}

// ---------- Envío ----------
export type SendResult =
  | { ok: true; messageId: string; waMessageId: string }
  | { ok: false; reason: "NOT_CONFIGURED" | "INVALID_PHONE" | "OUTSIDE_WINDOW" | "NO_TEMPLATE" | "DUPLICATE" | "GRAPH_ERROR" | "ERROR"; detail?: string; retryable?: boolean };

export type Deliver = {
  tenantId: string; to: string | null | undefined; purpose: string; relatedType?: string; relatedId?: string; sentById?: string; fetchImpl?: Fetch;
  /** Texto libre: solo si la ventana de 24 h está abierta. Plantilla: siempre permitida si está aprobada en Meta. */
  text?: string; template?: { name: string; components: TemplateComponent[] };
  /** Lo que se guarda como cuerpo (p. ej. se omite el código OTP). */
  storedBody?: string | null;
  /** Archivo (el contenido se sube a Meta antes de enviar). Como el texto libre, solo dentro de la ventana de 24 h. */
  media?: { kind: MediaKind; bytes: Uint8Array; mime: string; filename: string; caption?: string };
  /** Quién escribe: se muestra en el inbox (bot, agente o sistema). */
  authorKind?: "BOT" | "AGENT" | "SYSTEM";
};

/** Nunca lanza: devuelve un resultado explícito. Guarda el mensaje ANTES de enviarlo (PENDING) y lo actualiza con la respuesta real de Meta. */
export async function deliver(p: Deliver): Promise<SendResult> {
  try {
    // El plan debe incluir WhatsApp (un plan sin el módulo no envía nada, ni siquiera avisos automáticos)
    if (!(await hasFeature(p.tenantId, "WHATSAPP"))) return { ok: false, reason: "NOT_CONFIGURED", detail: "WhatsApp no está incluido en el plan" };
    const cfg = await loadActive(p.tenantId);
    if (!cfg) return { ok: false, reason: "NOT_CONFIGURED" };
    const waId = toWaId(p.to, cfg.countryCode);
    if (!waId) return { ok: false, reason: "INVALID_PHONE" };
    if (!p.text && !p.template && !p.media) return { ok: false, reason: "NO_TEMPLATE" };
    const conv = await conversationFor(p.tenantId, waId);
    if (!p.template && !inServiceWindow(conv.lastInboundAt)) return { ok: false, reason: "OUTSIDE_WINDOW", detail: "Fuera de la ventana de 24 h: se necesita una plantilla aprobada" };

    let row: { id: string };
    try {
      row = await db.whatsAppMessage.create({ data: {
        tenantId: p.tenantId, conversationId: conv.id, direction: "OUT", type: p.template ? "TEMPLATE" : p.media ? (p.media.kind === "image" ? "IMAGE" : p.media.kind === "document" ? "DOCUMENT" : p.media.kind === "audio" ? "AUDIO" : "VIDEO") : "TEXT", status: "PENDING",
        authorKind: p.authorKind ?? null, mediaMime: p.media?.mime ?? null, mediaFilename: p.media?.filename.slice(0, 100) ?? null,
        body: p.storedBody === undefined ? (p.template ? null : p.media ? (p.media.caption?.slice(0, 1024) ?? null) : p.text!.slice(0, 4096)) : p.storedBody, templateName: p.template?.name ?? null,
        purpose: p.purpose, relatedType: p.relatedType ?? null, relatedId: p.relatedId ?? null, sentById: p.sentById ?? null,
      } });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "DUPLICATE" };
      throw e;
    }
    const g = graphCfg(cfg, p.fetchImpl);
    try {
      let res: { messages: { id: string }[] };
      if (p.template) res = await graph.sendTemplate(g, cfg.phoneNumberId, waId, p.template.name, cfg.templateLanguage, p.template.components);
      else if (p.media) {
        const up = await graph.uploadMedia(g, cfg.phoneNumberId, p.media.bytes, p.media.mime, p.media.filename);
        await db.whatsAppMessage.updateMany({ where: { id: row.id, tenantId: p.tenantId }, data: { mediaId: up.id } });
        res = await graph.sendMedia(g, cfg.phoneNumberId, waId, p.media.kind, up.id, { caption: p.media.caption, filename: p.media.filename });
      } else res = await graph.sendText(g, cfg.phoneNumberId, waId, p.text!);
      const wamid = res.messages?.[0]?.id;
      if (!wamid) throw new GraphError("Meta no devolvió el id del mensaje", 200);
      await retryBusy(() => db.whatsAppMessage.updateMany({ where: { id: row.id, tenantId: p.tenantId, status: "PENDING" }, data: { waMessageId: wamid, status: "SENT", statusAt: new Date() } }));
      await db.whatsAppConversation.updateMany({ where: { id: conv.id, tenantId: p.tenantId }, data: { lastMessageAt: new Date() } });
      // Estados que llegaron antes de conocer el id (carrera envío/webhook)
      const orphans = await db.whatsAppOrphanStatus.findMany({ where: { tenantId: p.tenantId, waMessageId: wamid }, orderBy: { at: "asc" } });
      for (const o of orphans) await applyStatus(p.tenantId, wamid, o.status as "SENT", o.at, { code: o.errorCode ?? undefined, detail: o.errorDetail ?? undefined });
      if (orphans.length) await db.whatsAppOrphanStatus.deleteMany({ where: { tenantId: p.tenantId, waMessageId: wamid } });
      return { ok: true, messageId: row.id, waMessageId: wamid };
    } catch (e) {
      const ge = e instanceof GraphError ? e : null;
      await db.whatsAppMessage.updateMany({ where: { id: row.id, tenantId: p.tenantId, status: "PENDING" }, data: { status: "FAILED", statusAt: new Date(), errorCode: ge?.code ?? null, errorDetail: (ge ? friendly(ge) : "Error al enviar").slice(0, 300) } });
      return { ok: false, reason: "GRAPH_ERROR", detail: ge ? friendly(ge) : "Error al enviar", retryable: ge?.retryable ?? false };
    }
  } catch {
    return { ok: false, reason: "ERROR" };
  }
}

/** Configuración de Graph API de un tenant (descifra el token). null si no hay configuración o no se puede leer. Para rutas que descargan archivos. */
export async function graphConfigFor(tenantId: string, fetchImpl?: Fetch): Promise<GraphConfig | null> {
  const c = await db.whatsAppConfig.findUnique({ where: { tenantId } });
  if (!c) return null;
  try { return graphCfg(c, fetchImpl); } catch { return null; }
}
