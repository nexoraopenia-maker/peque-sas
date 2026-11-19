import { z } from "zod";

/**
 * Variables de entorno del servidor, tipadas y validadas. Sin `server-only` ni alias para poder usarse también desde `scripts/env-check.ts`.
 * `validateEnv()` NUNCA devuelve valores: solo nombres y motivos (los secretos no deben aparecer en logs).
 * Producción en Vercel: ver docs/DESPLIEGUE_VERCEL.md.
 */
const opt = z.string().trim().min(1).optional();
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Base de datos (Turso/libSQL). file:./prisma/local.db solo en desarrollo.
  TURSO_DATABASE_URL: z.string().trim().min(1),
  TURSO_AUTH_TOKEN: opt,
  // Sesiones y cifrado de credenciales por establecimiento
  AUTH_SECRET: z.string().min(32, "mínimo 32 caracteres"),
  APP_URL: z.url(),
  CRON_SECRET: z.string().min(16, "mínimo 16 caracteres"),
  // IA del chatbot (clave global del sistema)
  ANTHROPIC_API_KEY: opt,
  ANTHROPIC_MODEL: opt,
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  // Meta / WhatsApp Cloud API
  META_APP_ID: opt, META_APP_SECRET: opt, META_VERIFY_TOKEN: opt,
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/, "formato vNN.N").optional(),
  META_GRAPH_BASE_URL: z.url().optional(),
  // Cobro de suscripciones del SaaS
  PAYMENT_PROVIDER: z.enum(["NONE", "MOCK", "MERCADOPAGO"]).default("NONE"),
  MERCADOPAGO_ACCESS_TOKEN: opt, MERCADOPAGO_WEBHOOK_SECRET: opt,
  BILLING_MANUAL_INSTRUCTIONS: z.string().trim().max(500).optional(),
});
export type ServerEnv = z.infer<typeof serverEnvSchema>;

export type EnvReport = { ok: boolean; errors: string[]; warnings: string[] };

/** Valida un conjunto de variables. En producción las reglas son estrictas. */
export function validateEnv(source: Record<string, string | undefined> = process.env): EnvReport {
  const errors: string[] = [], warnings: string[] = [];
  const p = serverEnvSchema.safeParse(Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === "" ? undefined : v])));
  if (!p.success) for (const i of p.error.issues) errors.push(`${i.path.join(".") || "env"}: ${i.message}`);
  const e = p.success ? p.data : null;
  const prod = (source.NODE_ENV ?? "development") === "production";
  const v = (k: string) => source[k]?.trim() || undefined;
  if (e) {
    if (e.TURSO_DATABASE_URL.startsWith("libsql://") && !e.TURSO_AUTH_TOKEN) errors.push("TURSO_AUTH_TOKEN: obligatorio con una base libsql:// (Turso)");
    if (prod && e.TURSO_DATABASE_URL.startsWith("file:")) errors.push("TURSO_DATABASE_URL: en producción no se admite una base local file:");
    if (prod && !e.APP_URL.startsWith("https://")) errors.push("APP_URL: en producción debe ser https (Meta solo acepta webhooks https)");
    if (prod && e.META_GRAPH_BASE_URL && !e.META_GRAPH_BASE_URL.startsWith("https://")) errors.push("META_GRAPH_BASE_URL: en producción debe ser https (variable solo para pruebas)");
    if (prod && e.PAYMENT_PROVIDER === "MOCK") errors.push("PAYMENT_PROVIDER: MOCK (sandbox) no se admite en producción");
    if (e.PAYMENT_PROVIDER === "MERCADOPAGO") {
      if (!e.MERCADOPAGO_ACCESS_TOKEN) errors.push("MERCADOPAGO_ACCESS_TOKEN: obligatorio con PAYMENT_PROVIDER=MERCADOPAGO");
      if (!e.MERCADOPAGO_WEBHOOK_SECRET) errors.push("MERCADOPAGO_WEBHOOK_SECRET: obligatorio con PAYMENT_PROVIDER=MERCADOPAGO (valida la firma de los avisos)");
    }
    if (!e.ANTHROPIC_API_KEY) warnings.push("ANTHROPIC_API_KEY: sin clave el chatbot deriva todo a una persona");
    if (!e.META_APP_SECRET) warnings.push("META_APP_SECRET: sin App Secret global, cada establecimiento debe registrar el suyo");
    if (!e.META_VERIFY_TOKEN && !e.META_APP_ID) warnings.push("META_*: variables de Meta no configuradas (WhatsApp compartido)");
    if (e.PAYMENT_PROVIDER === "NONE") warnings.push("PAYMENT_PROVIDER=NONE: solo se aceptan pagos manuales (Yape/Plin/transferencia confirmados por el SuperAdmin)");
    if (prod && !v("BILLING_MANUAL_INSTRUCTIONS")) warnings.push("BILLING_MANUAL_INSTRUCTIONS: define a qué número/cuenta deben pagar los establecimientos (Yape/Plin/transferencia)");
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Proveedor de pagos del SaaS configurado en el entorno (NONE si no es válido). */
export const paymentProvider = (): ServerEnv["PAYMENT_PROVIDER"] => {
  const v = process.env.PAYMENT_PROVIDER;
  return v === "MOCK" || v === "MERCADOPAGO" ? v : "NONE";
};
