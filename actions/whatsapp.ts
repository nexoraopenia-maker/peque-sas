"use server";
import { revalidatePath } from "next/cache";
import { requirePermission, requireFeature } from "@/lib/rbac";
import { WhatsAppError, configSchema, regenerateVerifyToken, saveConfig, setEnabled, subscribeWebhook, testConnection } from "@/lib/whatsapp/service";
import { done, doneOk } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";

const BACK = "/settings/whatsapp";

/** Solo el propietario (permiso whatsapp:configure). Los secretos se cifran antes de guardarse y nunca se devuelven al navegador. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof WhatsAppError) done(BACK, e.message); throw e; }
}

export async function saveWhatsAppConfigAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const parsed = configSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) { const i = parsed.error.issues[0]!; done(BACK, `${String(i.path[0] ?? "Dato")}: ${i.message}`); }
  await guard(() => saveConfig(tenantId, user.id, parsed.data));
  await audit({ tenantId, actorId: user.id, action: "whatsapp.config.save", entity: "WhatsAppConfig" });
  revalidatePath(BACK);
  doneOk(BACK, "Configuración guardada. Prueba la conexión antes de activar.");
}

export async function testWhatsAppAction() {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const r = await guard(() => testConnection(tenantId));
  await audit({ tenantId, actorId: user.id, action: "whatsapp.test", entity: "WhatsAppConfig", metadata: { ok: r.ok } });
  revalidatePath(BACK);
  if (!r.ok) done(BACK, `La conexión falló: ${r.error}`);
  doneOk(BACK, "Conexión verificada con Meta: el token puede leer el número y el número pertenece al WABA.");
}

export async function subscribeWhatsAppAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  await guard(() => subscribeWebhook(tenantId, form.get("override") === "on"));
  await audit({ tenantId, actorId: user.id, action: "whatsapp.subscribe", entity: "WhatsAppConfig" });
  revalidatePath(BACK);
  doneOk(BACK, "Aplicación suscrita al WABA.");
}

export async function toggleWhatsAppAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const enable = form.get("enable") === "true";
  await guard(() => setEnabled(tenantId, enable));
  await audit({ tenantId, actorId: user.id, action: enable ? "whatsapp.enable" : "whatsapp.disable", entity: "WhatsAppConfig" });
  revalidatePath(BACK);
  doneOk(BACK, enable ? "WhatsApp activado: los avisos del sistema comenzarán a enviarse." : "WhatsApp desactivado: no se enviará ningún aviso.");
}

export async function regenerateVerifyTokenAction() {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  await guard(() => regenerateVerifyToken(tenantId));
  await audit({ tenantId, actorId: user.id, action: "whatsapp.verify_token.regenerate", entity: "WhatsAppConfig" });
  revalidatePath(BACK);
  doneOk(BACK, "Nuevo verify token generado: actualízalo en Meta (o vuelve a suscribir el WABA con la URL de este sistema).");
}
