import { db } from "@/lib/db";
import { isAuthorizedCron } from "@/lib/security/cron";
import { validateEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sonda de despliegue. Pública: solo ok/no ok. Con `Authorization: Bearer CRON_SECRET` añade el resultado de la validación de entorno (nombres, nunca valores). */
export async function GET(req: Request) {
  let dbOk = false;
  try { await db.$queryRaw`SELECT 1`; dbOk = true; } catch { /* se informa abajo */ }
  const body: Record<string, unknown> = { status: dbOk ? "ok" : "error" };
  if (isAuthorizedCron(req)) { const env = validateEnv(); Object.assign(body, { db: dbOk, env: { ok: env.ok, errors: env.errors, warnings: env.warnings }, node: process.version }); }
  return Response.json(body, { status: dbOk ? 200 : 503, headers: { "cache-control": "no-store" } });
}
