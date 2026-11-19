import { isAuthorizedCron } from "@/lib/security/cron";
import { processDue } from "@/lib/sunat/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reintenta comprobantes pendientes (espera creciente por comprobante) y completa PDF/XML. Idempotente: cada comprobante se reserva antes de enviarse. */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await processDue());
}
