"use server";
import { revalidatePath } from "next/cache";
import { requirePermission, requireFeature } from "@/lib/rbac";
import { db } from "@/lib/db";
import { tenantDb } from "@/lib/db/tenant";
import { hoursFromForm, hoursSchema } from "@/lib/whatsapp/bot/hours";
import { parseSoles } from "@/lib/billing/money";
import { done, doneOk } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";

const BACK = "/settings/whatsapp/bot";
const t = (f: FormData, k: string, max: number) => String(f.get(k) ?? "").trim().slice(0, max);

/** Solo el propietario (whatsapp:configure). */
export async function saveBotConfigAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const hours = hoursFromForm((k) => t(form, k, 5));
  const parsed = hoursSchema.safeParse(hours);
  if (!parsed.success) done(BACK, "Horario no válido: la hora de cierre debe ser posterior a la de apertura");
  const maxReplies = Number(form.get("maxRepliesPerHour"));
  if (!Number.isInteger(maxReplies) || maxReplies < 1 || maxReplies > 100) done(BACK, "El máximo de respuestas por hora debe estar entre 1 y 100");
  const personality = t(form, "personality", 200) || "Amable, cercano y breve";
  const data = {
    enabled: form.get("enabled") === "on", personality, instructions: t(form, "instructions", 2000) || null,
    welcomeMessage: t(form, "welcomeMessage", 500) || null, outOfHoursMessage: t(form, "outOfHoursMessage", 500) || null,
    handoffMessage: t(form, "handoffMessage", 500) || "Te comunico con una persona del equipo para ayudarte mejor. En unos minutos te responden.",
    policies: t(form, "policies", 2000) || null, hours: parsed.data, answerOutsideHours: form.get("answerOutsideHours") === "on",
    maxRepliesPerHour: maxReplies, updatedById: user.id,
  };
  await db.botConfig.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  await audit({ tenantId, actorId: user.id, action: "bot.config.save", entity: "BotConfig", metadata: { enabled: data.enabled } });
  revalidatePath(BACK);
  doneOk(BACK, data.enabled ? "Configuración guardada. El bot está ACTIVO." : "Configuración guardada. El bot está desactivado.");
}

export async function addFaqAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const q = t(form, "question", 300), a = t(form, "answer", 1000);
  if (q.length < 3 || a.length < 2) done(BACK, "Escribe la pregunta y la respuesta");
  const f = await tenantDb(tenantId).botFaq.create({ data: { question: q, answer: a } as never });
  await audit({ tenantId, actorId: user.id, action: "bot.faq.add", entity: "BotFaq", entityId: f.id });
  revalidatePath(BACK); done(BACK);
}
export async function deleteFaqAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const id = t(form, "id", 64);
  if ((await tenantDb(tenantId).botFaq.deleteMany({ where: { id } })).count) await audit({ tenantId, actorId: user.id, action: "bot.faq.delete", entity: "BotFaq", entityId: id });
  revalidatePath(BACK); done(BACK);
}

export async function addServiceAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const name = t(form, "name", 100), raw = t(form, "price", 12);
  const price = raw ? parseSoles(raw) : null;
  if (name.length < 2 || (raw && price === null)) done(BACK, "Nombre o precio no válidos (el precio admite hasta 2 decimales)");
  const s = await tenantDb(tenantId).botService.create({ data: { name, description: t(form, "description", 300) || null, priceCents: price } as never });
  await audit({ tenantId, actorId: user.id, action: "bot.service.add", entity: "BotService", entityId: s.id });
  revalidatePath(BACK); done(BACK);
}
export async function deleteServiceAction(form: FormData) {
  const { user, tenantId } = await requirePermission("whatsapp:configure");
  await requireFeature("WHATSAPP");
  const id = t(form, "id", 64);
  if ((await tenantDb(tenantId).botService.deleteMany({ where: { id } })).count) await audit({ tenantId, actorId: user.id, action: "bot.service.delete", entity: "BotService", entityId: id });
  revalidatePath(BACK); done(BACK);
}
