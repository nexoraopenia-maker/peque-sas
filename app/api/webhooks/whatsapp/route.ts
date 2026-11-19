import { after, type NextRequest } from "next/server";
import { handleWebhookPost, verifyWebhookChallenge } from "@/lib/whatsapp/webhook";
import { runBotJobs } from "@/lib/whatsapp/bot/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // el bot responde después de contestar 200 a Meta

const text = (r: { status: number; body: string }) => new Response(r.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Verificación del webhook (hub.mode / hub.verify_token / hub.challenge). */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return text(await verifyWebhookChallenge({ mode: q.get("hub.mode"), token: q.get("hub.verify_token"), challenge: q.get("hub.challenge") }));
}

/** Eventos: la firma X-Hub-Signature-256 se valida sobre el cuerpo CRUDO antes de procesar nada. */
export async function POST(req: NextRequest) {
  try {
    const raw = Buffer.from(await req.arrayBuffer());
    const result = await handleWebhookPost(raw, req.headers.get("x-hub-signature-256"));
    // Meta espera 200 en pocos segundos: la IA responde DESPUÉS, sin retrasar la confirmación del webhook
    if (result.status === 200 && result.jobs?.length) after(() => runBotJobs(result.jobs!));
    return text(result);
  } catch {
    // Error interno: 500 para que Meta reintente (el procesamiento es idempotente)
    return text({ status: 500, body: "Error" });
  }
}
