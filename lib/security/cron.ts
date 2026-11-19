import { timingSafeEqual } from "node:crypto";

/**
 * Autoriza una invocación de Vercel Cron. Vercel envía `Authorization: Bearer ${CRON_SECRET}`.
 * Uso en un Route Handler: `if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });`
 * Los jobs deben ser idempotentes.
 */
export function isAuthorizedCron(req: Request, secret = process.env.CRON_SECRET): boolean {
  if (!secret || secret.length < 16) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
