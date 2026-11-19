import { GatewayAuthError, getGateway } from "@/lib/subscriptions/gateway";
import { applyPaymentEvent } from "@/lib/subscriptions/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Avisos de la pasarela de pago. La firma se valida sobre el cuerpo CRUDO antes de tocar nada; el evento es idempotente
 * (PaymentEvent único por proveedor+evento) y el monto debe coincidir con el cobro. 401 = firma inválida; 500 = la pasarela reintenta.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const gw = getGateway();
  if (!gw || gw.provider.toLowerCase() !== provider) return json(404, { error: "not_found" });
  try {
    const raw = Buffer.from(await req.arrayBuffer());
    if (raw.length > 64_000) return json(413, { error: "too_large" });
    const ev = await gw.parseWebhook(raw, req.headers, new URL(req.url).searchParams);
    if (!ev) return json(200, { status: "ignored" });
    const r = await applyPaymentEvent(gw.provider, ev);
    return json(200, { status: r.status });
  } catch (e) {
    if (e instanceof GatewayAuthError) return json(401, { error: "invalid_signature" });
    return json(500, { error: "error" });
  }
}
