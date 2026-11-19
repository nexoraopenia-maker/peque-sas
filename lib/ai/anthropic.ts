import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Cliente de IA del sistema (Anthropic / Claude, SDK oficial). UNA clave global del sistema (ANTHROPIC_API_KEY), administrada por el
 * SuperAdmin; el consumo se absorbe en los planes (límite mensual por plan + consumo registrado por establecimiento en BotUsage).
 * Envoltorio delgado e INYECTABLE: el motor del bot depende de `AiClient`, no del SDK (en pruebas se inyecta un doble).
 *  - Modelo: ANTHROPIC_MODEL (por defecto claude-opus-5-5). Cambiar a un modelo más económico es una decisión de costos del SuperAdmin.
 *  - Esfuerzo: ANTHROPIC_EFFORT (por defecto `low`: chat corto con herramientas; con Opus 5.5 el pensamiento siempre está activo).
 *  - fallbacks "default": si los clasificadores de seguridad rechazan una solicitud, la API la reintenta en un modelo de respaldo.
 */
export type AiBlock = Anthropic.Beta.BetaContentBlock;
export type AiMessage = Anthropic.Beta.BetaMessageParam;
export type AiTool = Anthropic.Beta.BetaTool;
export type AiRequest = { system: string; messages: AiMessage[]; tools: AiTool[] };
export type AiResponse = { content: AiBlock[]; stopReason: string | null; inputTokens: number; outputTokens: number; model: string };
export interface AiClient { complete(req: AiRequest): Promise<AiResponse> }

export const AI_MODEL = () => process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const effort = () => { const e = process.env.ANTHROPIC_EFFORT as (typeof EFFORTS)[number] | undefined; return e && EFFORTS.includes(e) ? e : "low"; };
// Familias de modelos que admiten `fallbacks` (Haiku 5.5 no lo admite)
const supportsFallbacks = (model: string) => /^claude-(fable-5|opus-5|sonnet-5-5)/.test(model);

export function createAiClient(apiKey = process.env.ANTHROPIC_API_KEY): AiClient | null {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, timeout: 40_000, maxRetries: 1 });
  return {
    async complete(req) {
      const model = AI_MODEL();
      const res = await client.beta.messages.create({
        model, max_tokens: 2000, system: req.system, tools: req.tools, messages: req.messages,
        output_config: { effort: effort() },
        ...(supportsFallbacks(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      return { content: res.content, stopReason: res.stop_reason, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, model: res.model };
    },
  };
}
