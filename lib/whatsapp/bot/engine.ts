import { featureEnabled } from "@/lib/plans/pure";
import "server-only";
import { db } from "@/lib/db";
import { retryBusy } from "@/lib/billing/service";
import { AI_MODEL, createAiClient, type AiBlock, type AiClient, type AiMessage } from "@/lib/ai/anthropic";
import { limaDate } from "@/lib/utils/date";
import { deliver, type Fetch } from "@/lib/whatsapp/service";
import { groundingCheck, wantsHuman } from "./guard";
import { handoff, markInboundHandled } from "./handoff";
import { isOpenNow, parseHours } from "./hours";
import { buildSystemPrompt } from "./prompt";
import { TOOL_DEFS, runTool, type ToolCtx } from "./tools";

/**
 * Motor del chatbot. Reglas (claude.md §16):
 *  - Solo responde si: bot activado en el establecimiento, plan con automatizaciones, bot activo en ESA conversación y la IA disponible.
 *  - Si una persona toma la conversación o el cliente pide atención humana, el bot deja de responder de inmediato en ese chat.
 *  - Solo hay UN procesador por conversación (bloqueo con vencimiento) y los mensajes que llegan juntos se responden en una sola vez.
 *  - La respuesta se verifica en código (guard) antes de enviarse; si falla, se deriva a una persona en vez de arriesgar un dato inventado.
 *  - Justo antes de enviar se comprueba otra vez que el bot siga activo: si una persona tomó el chat mientras la IA pensaba, NO se envía.
 */
export type BotDeps = { ai?: AiClient | null; fetchImpl?: Fetch; now?: Date };
export type BotOutcome = "REPLIED" | "HANDOFF" | "OUT_OF_HOURS" | "NOTHING" | "LOCKED" | "DISABLED" | "TAKEN_OVER" | "BLOCKED" | "ERROR";

const LOCK_MS = 120_000, PENDING_WINDOW_MS = 6 * 3600_000, MAX_TOOL_STEPS = 6, MAX_ROUNDS = 3, HISTORY = 20;
const DEFAULT_OUT_OF_HOURS = "Gracias por escribirnos. Ahora estamos fuera de nuestro horario de atención; te responderemos en cuanto abramos.";
const nowLabel = (d: Date) => new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", dateStyle: "full", timeStyle: "short" }).format(d);

/** Atiende los mensajes nuevos de una conversación. Nunca lanza: devuelve el resultado de cada ronda. */
export async function runBot(job: { tenantId: string; conversationId: string }, deps: BotDeps = {}): Promise<BotOutcome[]> {
  const { tenantId, conversationId } = job;
  const clock = () => deps.now ?? new Date();
  try {
    const cfg = await db.botConfig.findUnique({ where: { tenantId } });
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, include: { plan: true } });
    if (!cfg?.enabled || !tenant || tenant.status === "SUSPENDED" || !featureEnabled(tenant, "AUTOMATIONS")) return ["DISABLED"];

    const claim = await retryBusy(() => db.whatsAppConversation.updateMany({
      where: { id: conversationId, tenantId, botEnabled: true, OR: [{ botLockedUntil: null }, { botLockedUntil: { lt: clock() } }] },
      data: { botLockedUntil: new Date(clock().getTime() + LOCK_MS) },
    }));
    if (claim.count !== 1) return ["LOCKED"];

    const outcomes: BotOutcome[] = [];
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const o = await oneRound({ tenantId, conversationId, cfg, tenantName: tenant.name, planLimit: tenant.plan.botMonthlyReplies }, deps, clock);
        outcomes.push(o);
        // Tras un traspaso, bloqueo, error o si una persona tomó el chat, el bot ya no tiene nada más que hacer. Tras REPLIED se revisa una vez más
        // por si llegó otro mensaje mientras se respondía.
        if (o !== "REPLIED" && o !== "OUT_OF_HOURS") break;
      }
    } finally {
      await db.whatsAppConversation.updateMany({ where: { id: conversationId, tenantId }, data: { botLockedUntil: null } });
    }
    return outcomes;
  } catch {
    return ["ERROR"];
  }
}

type Round = { tenantId: string; conversationId: string; cfg: NonNullable<Awaited<ReturnType<typeof db.botConfig.findUnique>>>; tenantName: string; planLimit: number };

async function oneRound(r: Round, deps: BotDeps, clock: () => Date): Promise<BotOutcome> {
  const { tenantId, conversationId, cfg } = r;
  const now = clock();
  const conv = await db.whatsAppConversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conv || !conv.botEnabled || conv.status !== "OPEN") return "TAKEN_OVER";

  const pending = await db.whatsAppMessage.findMany({
    where: { tenantId, conversationId, direction: "IN", botHandledAt: null, createdAt: { gt: new Date(now.getTime() - PENDING_WINDOW_MS) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!pending.length) return "NOTHING";
  const ids = pending.map((m) => m.id);
  const handled = () => db.whatsAppMessage.updateMany({ where: { id: { in: ids }, tenantId, botHandledAt: null }, data: { botHandledAt: new Date() } });
  const texts = pending.filter((m) => m.type === "TEXT" && m.body).map((m) => m.body!.slice(0, 1000));
  const send = (text: string, purpose: string) => deliver({ tenantId, to: conv.waId, text, purpose, authorKind: "BOT", fetchImpl: deps.fetchImpl });

  // 1) Atención humana pedida por el cliente: sin IA, de inmediato
  if (texts.some(wantsHuman)) { await handoff({ tenantId, conversationId, reason: "El cliente pidió atención humana", notifyCustomer: true, message: cfg.handoffMessage, fetchImpl: deps.fetchImpl }); return "HANDOFF"; }
  // 2) Mensajes sin texto (imágenes, audios…): el bot no los interpreta
  if (!texts.length) { await handoff({ tenantId, conversationId, reason: "El cliente envió un archivo o un mensaje que el bot no interpreta", notifyCustomer: true, message: cfg.handoffMessage, fetchImpl: deps.fetchImpl }); return "HANDOFF"; }
  // 3) Fuera de horario
  if (!isOpenNow(parseHours(cfg.hours), now) && !cfg.answerOutsideHours) {
    if (!conv.lastOutOfHoursAt || limaDate(conv.lastOutOfHoursAt) !== limaDate(now)) {
      const s = await send(cfg.outOfHoursMessage || DEFAULT_OUT_OF_HOURS, "BOT_OUT_OF_HOURS");
      if (s.ok) await db.whatsAppConversation.updateMany({ where: { id: conv.id, tenantId }, data: { lastOutOfHoursAt: now } });
    }
    await handled();
    return "OUT_OF_HOURS";
  }
  // 4) Límites de consumo (plan y por conversación)
  const month = limaDate(now).slice(0, 7);
  const [used, lastHour] = await Promise.all([
    db.botUsage.count({ where: { tenantId, month } }),
    db.botUsage.count({ where: { tenantId, conversationId, createdAt: { gt: new Date(now.getTime() - 3600_000) } } }),
  ]);
  if (used >= r.planLimit || lastHour >= cfg.maxRepliesPerHour) {
    await handoff({ tenantId, conversationId, reason: used >= r.planLimit ? "Se alcanzó el límite mensual de respuestas automáticas del plan" : "Demasiadas respuestas automáticas en la última hora", notifyCustomer: true, message: cfg.handoffMessage, fetchImpl: deps.fetchImpl });
    return "HANDOFF";
  }
  const ai = deps.ai === undefined ? createAiClient() : deps.ai;
  if (!ai) { await handoff({ tenantId, conversationId, reason: "La IA no está disponible (falta la clave del sistema)", notifyCustomer: true, message: cfg.handoffMessage, fetchImpl: deps.fetchImpl }); return "HANDOFF"; }

  // 5) Historial → mensajes de la API. Los mensajes PENDIENTES van siempre como último turno del usuario y el historial se arma con
  //    los demás: ordenar todo por fecha fallaría si un mensaje llegó mientras el bot pensaba (su fecha queda antes de nuestra respuesta
  //    aunque el bot aún no lo haya visto) y se daría por "atendido" sin responderlo.
  const rows = await db.whatsAppMessage.findMany({ where: { tenantId, conversationId, type: "TEXT", body: { not: null }, id: { notIn: ids } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: HISTORY });
  const messages: AiMessage[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content as string}\n${text}`; else messages.push({ role, content: text });
  };
  for (const m of rows.reverse()) push(m.direction === "IN" ? "user" : "assistant", (m.body ?? "").slice(0, 1000));
  while (messages.length && messages[0]!.role !== "user") messages.shift();
  push("user", texts.join("\n"));

  // 6) Bienvenida (una sola vez por conversación). Va DESPUÉS de armar el historial: si no, el último mensaje sería del asistente.
  let greeted = false;
  if (!conv.welcomedAt) {
    const c = await db.whatsAppConversation.updateMany({ where: { id: conv.id, tenantId, welcomedAt: null }, data: { welcomedAt: now } });
    if (c.count === 1 && cfg.welcomeMessage) { greeted = (await send(cfg.welcomeMessage, "BOT_WELCOME")).ok; }
  }

  const system = buildSystemPrompt({ tenantName: r.tenantName, personality: cfg.personality, instructions: cfg.instructions, nowLabel: nowLabel(now), alreadyGreeted: greeted });
  const ctx: ToolCtx = { tenantId, conversationId, waId: conv.waId, now };
  const toolOutputs: string[] = [], availability: { available: boolean }[] = [];
  let inTokens = 0, outTokens = 0, model = AI_MODEL(), finalText: string | null = null, handoffReason: string | null = null, failed = false;

  try {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const res = await ai.complete({ system, messages, tools: TOOL_DEFS });
      inTokens += res.inputTokens; outTokens += res.outputTokens; model = res.model || model;
      if (res.stopReason === "refusal") { handoffReason = "La IA rechazó la solicitud por sus filtros de seguridad"; break; }
      if (res.stopReason === "tool_use") {
        messages.push({ role: "assistant", content: res.content as AiBlock[] as never });
        const results: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = [];
        for (const b of res.content) {
          if (b.type !== "tool_use") continue;
          const t = await runTool(ctx, b.name, b.input);
          const out = JSON.stringify(t.output);
          toolOutputs.push(out);
          if (t.availability) availability.push(t.availability);
          if (t.handoff && !handoffReason) handoffReason = t.handoff;
          results.push({ type: "tool_result", tool_use_id: b.id, content: out, ...(t.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        if (handoffReason) break;
        continue;
      }
      if (res.stopReason === "end_turn") { finalText = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim(); break; }
      handoffReason = `La IA no terminó su respuesta (${res.stopReason})`; break;
    }
    if (finalText === null && !handoffReason) handoffReason = "La IA superó el número de pasos permitidos";
  } catch {
    failed = true; handoffReason = "Error del servicio de IA";
  }

  const record = (outcome: string) => db.botUsage.create({ data: { tenantId, conversationId, month, model, inputTokens: inTokens, outputTokens: outTokens, outcome } });
  if (handoffReason) {
    await record(failed ? "ERROR" : "HANDOFF");
    await handoff({ tenantId, conversationId, reason: handoffReason, notifyCustomer: true, message: cfg.handoffMessage, fetchImpl: deps.fetchImpl });
    return failed ? "ERROR" : "HANDOFF";
  }

  // 7) Verificación determinista de la respuesta contra los datos reales
  const verdict = groundingCheck(finalText!, { toolOutputs, staticTexts: [cfg.instructions ?? "", cfg.policies ?? "", cfg.welcomeMessage ?? "", cfg.outOfHoursMessage ?? "", cfg.handoffMessage], availability });
  if (!verdict.ok) {
    await record("BLOCKED");
    await handoff({ tenantId, conversationId, reason: `Respuesta del bot bloqueada por verificación: ${verdict.reason}`, notifyCustomer: true, message: cfg.handoffMessage, fetchImpl: deps.fetchImpl });
    return "BLOCKED";
  }

  // 8) Compuerta final: si una persona tomó el chat mientras la IA pensaba, NO se envía
  const gate = await db.whatsAppConversation.updateMany({ where: { id: conv.id, tenantId, botEnabled: true, status: "OPEN" }, data: { lastBotReplyAt: new Date() } });
  if (gate.count !== 1) { await record("TAKEN_OVER"); return "TAKEN_OVER"; }
  const sent = await send(finalText!, "BOT_REPLY");
  await record("REPLIED");
  if (!sent.ok) {
    await handled();
    await handoff({ tenantId, conversationId, reason: "No se pudo enviar la respuesta del bot", notifyCustomer: false, fetchImpl: deps.fetchImpl });
    return "ERROR";
  }
  await handled();
  return "REPLIED";
}

/** Atiende en segundo plano los trabajos que dejó el webhook (después de responder 200 a Meta). Nunca lanza. */
export async function runBotJobs(jobs: { tenantId: string; conversationId: string; optOutRevoked?: number }[], deps: BotDeps = {}) {
  for (const j of jobs) {
    if (j.optOutRevoked && j.optOutRevoked > 0) {
      const conv = await db.whatsAppConversation.findFirst({ where: { id: j.conversationId, tenantId: j.tenantId }, select: { waId: true } }).catch(() => null);
      if (conv) await deliver({ tenantId: j.tenantId, to: conv.waId, text: "Listo: no recibirás más promociones por WhatsApp. Puedes volver a activarlas cuando quieras pidiéndolo en recepción.", purpose: "OPT_OUT_CONFIRM", authorKind: "SYSTEM", fetchImpl: deps.fetchImpl }).catch(() => undefined);
    }
    await runBot(j, deps).catch(() => undefined);
  }
}
export { markInboundHandled };
