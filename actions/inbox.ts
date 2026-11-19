"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission, requireFeature } from "@/lib/rbac";
import * as inbox from "@/lib/whatsapp/inbox";
import { describeSendFailure } from "@/lib/whatsapp/notify";
import { audit } from "@/lib/audit";

const BASE = "/whatsapp/inbox";
const t = (f: FormData, k: string, max = 64) => String(f.get(k) ?? "").trim().slice(0, max);
/** Vuelve a la conversación abierta (y al filtro activo). */
const back = (f: FormData) => {
  const c = t(f, "c"), filter = t(f, "f", 12);
  return `${BASE}${c ? `?c=${encodeURIComponent(c)}${filter ? `&f=${encodeURIComponent(filter)}` : ""}` : ""}`;
};
function redirectWithError(path: string, msg: string): never { redirect(`${path}${path.includes("?") ? "&" : "?"}e=${encodeURIComponent(msg)}`); }

async function guard(form: FormData, fn: () => Promise<void>) {
  try { await fn(); } catch (e) {
    if (e instanceof inbox.InboxError) redirectWithError(back(form), e.message);
    throw e;
  }
}

export async function sendTextAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:use");
  await requireFeature("WHATSAPP");
  const id = t(form, "c");
  await guard(form, async () => {
    const r = await inbox.sendAgentText(tenantId, user.id, id, String(form.get("text") ?? ""));
    if (!r.ok) redirectWithError(back(form), describeSendFailure(r));
    await audit({ tenantId, actorId: user.id, action: "inbox.send.text", entity: "WhatsAppConversation", entityId: id });
  });
  revalidatePath(BASE); redirect(back(form));
}

export async function sendFileAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:use");
  await requireFeature("WHATSAPP");
  const id = t(form, "c"); const file = form.get("file");
  await guard(form, async () => {
    if (!(file instanceof File) || file.size === 0) throw new inbox.InboxError("Selecciona un archivo");
    if (file.size > 17 * 1024 * 1024) throw new inbox.InboxError("El archivo es demasiado grande");
    const r = await inbox.sendAgentFile(tenantId, user.id, id, { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, name: file.name || "archivo" }, t(form, "caption", 1000));
    if (!r.ok) redirectWithError(back(form), describeSendFailure(r));
    await audit({ tenantId, actorId: user.id, action: "inbox.send.file", entity: "WhatsAppConversation", entityId: id });
  });
  revalidatePath(BASE); redirect(back(form));
}

export async function addNoteAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:use");
  await requireFeature("WHATSAPP");
  await guard(form, () => inbox.addNote(tenantId, user.id, t(form, "c"), String(form.get("body") ?? "")));
  revalidatePath(BASE); redirect(back(form));
}

/** Acciones de estado: tomar, asignar, devolver al bot, activar/desactivar bot, cerrar, reabrir. */
export async function conversationAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:use");
  await requireFeature("WHATSAPP");
  const id = t(form, "c"), op = t(form, "op", 20);
  await guard(form, async () => {
    if (op === "claim") await inbox.claimConversation(tenantId, user.id, id);
    else if (op === "assign") await inbox.assignConversation(tenantId, id, t(form, "assignee") || null);
    else if (op === "release") await inbox.releaseToBot(tenantId, id);
    else if (op === "bot_on") await inbox.setBotEnabled(tenantId, id, true);
    else if (op === "bot_off") await inbox.setBotEnabled(tenantId, id, false);
    else if (op === "close") await inbox.closeConversation(tenantId, id);
    else if (op === "reopen") await inbox.reopenConversation(tenantId, id);
    else throw new inbox.InboxError("Operación no válida");
    await audit({ tenantId, actorId: user.id, action: `inbox.${op}`, entity: "WhatsAppConversation", entityId: id });
  });
  revalidatePath(BASE); redirect(back(form));
}
