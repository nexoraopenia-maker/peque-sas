/**
 * Cliente HTTP nativo (fetch) hacia la Graph API de Meta. Sin dependencias.
 *  - Los ids que se interpolan en la ruta se validan (numéricos): evita inyección en la URL.
 *  - Tiempo de espera de 10 s. No se reintenta el envío (podría duplicar mensajes): el reintento lo decide quien llama.
 *  - Los errores NUNCA incluyen el token de acceso. Los mensajes de error de Meta se truncan.
 *  - `fetchImpl` y `baseUrl` son inyectables (pruebas y entornos de sandbox); en producción solo se admite https.
 */
export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly details?: string, readonly retryable = false) { super(message); }
}

export type GraphConfig = { token: string; version?: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

export const DEFAULT_API_VERSION = "v27.0";
const DEFAULT_BASE = "https://graph.facebook.com";

export function resolveBase(baseUrl?: string): string {
  const b = (baseUrl ?? process.env.META_GRAPH_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const u = new URL(b);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production")) throw new Error("La URL de Graph API debe ser https");
  return b;
}
export const resolveVersion = (v?: string | null) => {
  const x = v || process.env.META_API_VERSION || DEFAULT_API_VERSION;
  if (!/^v\d{1,3}\.\d{1,2}$/.test(x)) throw new Error("Versión de Graph API no válida");
  return x;
};
const id = (v: string, what: string) => { if (!/^\d{5,30}$/.test(v)) throw new Error(`${what} no válido`); return v; };

// Códigos de error de Meta que conviene reintentar más tarde (límites de tasa y fallos transitorios)
const RETRYABLE = new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131048, 131056]);

async function call<T>(cfg: GraphConfig, method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(`${resolveBase(cfg.baseUrl)}/${resolveVersion(cfg.version)}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 10_000);
  try {
    const res = await (cfg.fetchImpl ?? fetch)(url, {
      method, signal: ctl.signal,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* respuesta no JSON */ }
    if (!res.ok) {
      const e = json.error ?? {};
      const code = typeof e.code === "number" ? e.code : undefined;
      const details = typeof e.error_data?.details === "string" ? e.error_data.details : undefined;
      throw new GraphError(String(e.message ?? `HTTP ${res.status}`).slice(0, 300), res.status, code, details?.slice(0, 300), res.status >= 500 || res.status === 429 || (code !== undefined && RETRYABLE.has(code)));
    }
    return json as T;
  } catch (err) {
    if (err instanceof GraphError) throw err;
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new GraphError(aborted ? "Tiempo de espera agotado al contactar a Meta" : "No se pudo contactar a Meta", 0, undefined, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

export type MediaKind = "image" | "document" | "audio" | "video";
// Tipos y tamaños que acepta el inbox (límites de Meta: imagen 5 MB, audio/video 16 MB, documento 100 MB; aquí se limita más para serverless)
export const OUTBOUND_MEDIA: Record<string, { kind: MediaKind; maxBytes: number }> = {
  "image/jpeg": { kind: "image", maxBytes: 5 * 1024 * 1024 }, "image/png": { kind: "image", maxBytes: 5 * 1024 * 1024 },
  "application/pdf": { kind: "document", maxBytes: 10 * 1024 * 1024 },
  "audio/mpeg": { kind: "audio", maxBytes: 10 * 1024 * 1024 }, "audio/ogg": { kind: "audio", maxBytes: 10 * 1024 * 1024 },
  "video/mp4": { kind: "video", maxBytes: 16 * 1024 * 1024 },
};

export type TemplateComponent = { type: "body" | "header" | "button"; sub_type?: "url" | "quick_reply"; index?: string; parameters: { type: "text"; text: string }[] };

export const graph = {
  /** POST /{phone-number-id}/messages — texto (solo dentro de la ventana de 24 h). */
  sendText: async (c: GraphConfig, phoneNumberId: string, to: string, body: string) =>
    call<{ messages: { id: string }[] }>(c, "POST", `${id(phoneNumberId, "phone_number_id")}/messages`, {
      body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } },
    }),
  /** POST /{phone-number-id}/messages — plantilla aprobada (permite iniciar la conversación fuera de la ventana). */
  sendTemplate: async (c: GraphConfig, phoneNumberId: string, to: string, name: string, language: string, components: TemplateComponent[]) =>
    call<{ messages: { id: string }[] }>(c, "POST", `${id(phoneNumberId, "phone_number_id")}/messages`, {
      body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template: { name, language: { code: language }, ...(components.length ? { components } : {}) } },
    }),
  getPhoneNumber: async (c: GraphConfig, phoneNumberId: string) =>
    call<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>(c, "GET", id(phoneNumberId, "phone_number_id"), { query: { fields: "display_phone_number,verified_name,quality_rating" } }),
  listWabaPhoneNumbers: async (c: GraphConfig, wabaId: string) =>
    call<{ data: { id: string }[] }>(c, "GET", `${id(wabaId, "waba_id")}/phone_numbers`, { query: { fields: "id", limit: "100" } }),
  /** POST /{waba-id}/subscribed_apps — suscribe la app; con override fija la URL y el verify token de ESTE WABA. */
  subscribeApp: async (c: GraphConfig, wabaId: string, override?: { callbackUrl: string; verifyToken: string }) =>
    call<{ success: boolean }>(c, "POST", `${id(wabaId, "waba_id")}/subscribed_apps`, override ? { body: { override_callback_uri: override.callbackUrl, verify_token: override.verifyToken } } : {}),
  getSubscribedApps: async (c: GraphConfig, wabaId: string) => call<{ data: unknown[] }>(c, "GET", `${id(wabaId, "waba_id")}/subscribed_apps`),
  /** POST /{phone-number-id}/media (multipart): sube un archivo y devuelve su id para enviarlo. */
  uploadMedia: async (c: GraphConfig, phoneNumberId: string, bytes: Uint8Array, mime: string, filename: string) => {
    const url = new URL(`${resolveBase(c.baseUrl)}/${resolveVersion(c.version)}/${id(phoneNumberId, "phone_number_id")}/media`);
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", mime);
    form.set("file", new Blob([bytes as BlobPart], { type: mime }), filename.replace(/[^\w.\- ]/g, "_").slice(0, 100));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), (c.timeoutMs ?? 10_000) * 3);
    try {
      const res = await (c.fetchImpl ?? fetch)(url, { method: "POST", signal: ctl.signal, headers: { Authorization: `Bearer ${c.token}` }, body: form });
      const json = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok) throw new GraphError(String(json.error?.message ?? `HTTP ${res.status}`).slice(0, 300), res.status, typeof json.error?.code === "number" ? json.error.code : undefined, undefined, res.status >= 500 || res.status === 429);
      if (typeof json.id !== "string") throw new GraphError("Meta no devolvió el id del archivo", 200);
      return { id: json.id as string };
    } catch (err) {
      if (err instanceof GraphError) throw err;
      throw new GraphError(err instanceof Error && err.name === "AbortError" ? "Tiempo de espera agotado al subir el archivo" : "No se pudo contactar a Meta", 0, undefined, undefined, true);
    } finally { clearTimeout(timer); }
  },
  /** Envía un archivo ya subido (por id). */
  sendMedia: async (c: GraphConfig, phoneNumberId: string, to: string, kind: MediaKind, mediaId: string, opts: { caption?: string; filename?: string } = {}) =>
    call<{ messages: { id: string }[] }>(c, "POST", `${id(phoneNumberId, "phone_number_id")}/messages`, {
      body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: kind, [kind]: { id: id(mediaId, "media_id"), ...(opts.caption && kind !== "audio" ? { caption: opts.caption.slice(0, 1024) } : {}), ...(kind === "document" && opts.filename ? { filename: opts.filename.slice(0, 100) } : {}) } },
    }),
  getMediaInfo: async (c: GraphConfig, mediaId: string) => call<{ url: string; mime_type: string; sha256?: string; file_size?: number; id: string }>(c, "GET", id(mediaId, "media_id")),
};

/**
 * Descarga de un archivo recibido: 1) GET /{media-id} → URL temporal (vence en 5 min), 2) GET de la URL con el MISMO token.
 * Valida https y host de Meta, limita el tamaño y verifica el sha256 cuando Meta lo informa. No guarda nada (no hay almacenamiento configurado).
 */
export async function downloadMedia(c: GraphConfig, mediaId: string, maxBytes = 25 * 1024 * 1024) {
  const info = await graph.getMediaInfo(c, mediaId);
  const u = new URL(info.url);
  const custom = !!(c.baseUrl ?? process.env.META_GRAPH_BASE_URL);
  if (!custom && (u.protocol !== "https:" || !/(^|\.)(fbcdn\.net|fbsbx\.com|whatsapp\.net|facebook\.com)$/.test(u.hostname))) throw new GraphError("URL de archivo no permitida", 0);
  if (info.file_size && info.file_size > maxBytes) throw new GraphError("El archivo supera el tamaño permitido", 0);
  const res = await (c.fetchImpl ?? fetch)(u, { headers: { Authorization: `Bearer ${c.token}` } });
  if (!res.ok) throw new GraphError(`No se pudo descargar el archivo (HTTP ${res.status})`, res.status, undefined, undefined, res.status === 404 || res.status >= 500);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new GraphError("El archivo supera el tamaño permitido", 0);
  if (info.sha256) {
    const { createHash } = await import("node:crypto");
    if (createHash("sha256").update(bytes).digest("hex") !== info.sha256.toLowerCase()) throw new GraphError("El archivo descargado no coincide con su huella sha256", 0);
  }
  return { bytes, mime: info.mime_type };
}
