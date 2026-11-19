import { isAuthorizedCron } from "@/lib/security/cron";
import { runReservationReminders } from "@/lib/whatsapp/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron (GET con Authorization: Bearer CRON_SECRET). Idempotente: cada recordatorio se reclama antes de enviarse. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await runReservationReminders());
}
