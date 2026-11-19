import { isAuthorizedCron } from "@/lib/security/cron";
import { expireAllDue } from "@/lib/marketing/loyalty";
import { continueCampaigns } from "@/lib/marketing/campaigns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron diario: vence puntos y continúa campañas a medias. Idempotente (lotes únicos y destinatarios reclamados). */
export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return new Response("Unauthorized", { status: 401 });
  const points = await expireAllDue();
  const campaigns = await continueCampaigns();
  return Response.json({ points, campaigns });
}
