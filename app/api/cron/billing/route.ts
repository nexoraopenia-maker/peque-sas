import { isAuthorizedCron } from "@/lib/security/cron";
import { runBillingCycle } from "@/lib/subscriptions/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Ciclo diario de cobro: genera cobros del siguiente periodo, marca vencidos y bloquea por impago tras la gracia. Idempotente. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await runBillingCycle());
}
