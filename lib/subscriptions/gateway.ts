import { hkdfSync } from "node:crypto";
import { paymentProvider } from "@/lib/env";
import { mockSignature, verifyMercadoPagoSignature, verifyMockSignature } from "./pure";

/**
 * Pasarela de pago para cobrar las suscripciones del SaaS (cuenta de la PLATAFORMA, no de cada establecimiento).
 * Interfaz agnóstica: `createCheckout` devuelve la URL donde el propietario paga; `parseWebhook` valida la FIRMA del aviso y lo
 * convierte en un evento normalizado (lanza `GatewayAuthError` si la firma no es válida).
 * Implementaciones: MOCK (sandbox, no cobra nada) y MERCADOPAGO (tarjetas, Yape y otros medios de Mercado Pago Perú).
 * Yape/Plin directos no tienen API pública de comercio: se cubren con pago manual confirmado por el SuperAdmin.
 */
export type CheckoutInvoice = { id: string; amountCents: number; description: string };
export type PaymentMethodKind = "CARD" | "YAPE" | "PLIN" | "TRANSFER" | "OTHER";
export type ParsedPayment = {
  eventId: string; invoiceId: string; amountCents: number; currency: string; providerRef: string;
  status: "APPROVED" | "PENDING" | "REJECTED" | "REFUNDED"; method: PaymentMethodKind;
};
export class GatewayAuthError extends Error {}
export class GatewayError extends Error {}

export interface PaymentGateway {
  readonly provider: "MOCK" | "MERCADOPAGO";
  createCheckout(inv: CheckoutInvoice, urls: { notificationUrl: string; backUrl: string }): Promise<{ url: string; providerRef: string }>;
  /** null = aviso que no es de un pago (se responde 200 y se ignora). */
  parseWebhook(raw: Buffer, headers: Headers, query: URLSearchParams): Promise<ParsedPayment | null>;
}

const appUrl = () => (process.env.APP_URL ?? "").replace(/\/+$/, "");
export const mockKey = () => {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET debe tener al menos 32 caracteres");
  return Buffer.from(hkdfSync("sha256", s, "pequessaas-payments-salt", "pequessaas:payments-mock:v1", 32)).toString("hex");
};

export class MockGateway implements PaymentGateway {
  readonly provider = "MOCK" as const;
  async createCheckout(inv: CheckoutInvoice) { return { url: `${appUrl()}/billing/sandbox?invoice=${encodeURIComponent(inv.id)}`, providerRef: `mock-${inv.id}` }; }
  async parseWebhook(raw: Buffer, headers: Headers): Promise<ParsedPayment | null> {
    if (!verifyMockSignature(raw, headers.get("x-mock-signature"), mockKey())) throw new GatewayAuthError("Firma inválida");
    const b = JSON.parse(raw.toString("utf8")) as Partial<ParsedPayment>;
    if (!b.eventId || !b.invoiceId || !Number.isSafeInteger(b.amountCents)) return null;
    return { eventId: String(b.eventId), invoiceId: String(b.invoiceId), amountCents: b.amountCents!, currency: b.currency ?? "PEN", providerRef: b.providerRef ?? `mock-${b.eventId}`, status: b.status ?? "APPROVED", method: b.method ?? "CARD" };
  }
}
export const signMockEvent = (raw: string) => mockSignature(raw, mockKey());

type Fetch = typeof fetch;
const MP_API = "https://api.mercadopago.com";
export class MercadoPagoGateway implements PaymentGateway {
  readonly provider = "MERCADOPAGO" as const;
  constructor(private cfg: { accessToken: string; webhookSecret: string; fetchImpl?: Fetch; baseUrl?: string }) {}
  private get f() { return this.cfg.fetchImpl ?? fetch; }
  private get base() { return this.cfg.baseUrl ?? MP_API; }
  private async call(path: string, init: RequestInit) {
    let res: Response;
    try { res = await this.f(`${this.base}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.accessToken}`, ...(init.headers ?? {}) } }); }
    catch (e) { throw new GatewayError(`No se pudo contactar a Mercado Pago: ${e instanceof Error ? e.message : "red"}`); }
    if (!res.ok) throw new GatewayError(`Mercado Pago respondió ${res.status}`);
    return (await res.json()) as Record<string, any>;
  }
  async createCheckout(inv: CheckoutInvoice, urls: { notificationUrl: string; backUrl: string }) {
    const j = await this.call("/checkout/preferences", { method: "POST", headers: { "X-Idempotency-Key": inv.id }, body: JSON.stringify({
      items: [{ id: inv.id, title: inv.description.slice(0, 120), quantity: 1, currency_id: "PEN", unit_price: Number((inv.amountCents / 100).toFixed(2)) }],
      external_reference: inv.id, notification_url: urls.notificationUrl,
      back_urls: { success: urls.backUrl, failure: urls.backUrl, pending: urls.backUrl }, auto_return: "approved",
    }) });
    const url = typeof j.init_point === "string" ? j.init_point : null;
    if (!url || !/^https:\/\/([\w-]+\.)*mercadopago\.[a-z.]+\//.test(url)) throw new GatewayError("Mercado Pago no devolvió una URL de pago válida");
    return { url, providerRef: String(j.id ?? inv.id) };
  }
  async parseWebhook(raw: Buffer, headers: Headers, query: URLSearchParams): Promise<ParsedPayment | null> {
    let body: Record<string, any> = {};
    try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { /* el id también llega por query */ }
    const dataId = query.get("data.id") ?? (body.data?.id != null ? String(body.data.id) : null);
    if (!verifyMercadoPagoSignature({ secret: this.cfg.webhookSecret, xSignature: headers.get("x-signature"), xRequestId: headers.get("x-request-id"), dataId })) throw new GatewayAuthError("Firma inválida");
    const type = query.get("type") ?? body.type;
    if (type !== "payment" || !dataId) return null;
    // La firma solo prueba que el aviso es de MP; el estado y el monto REALES se consultan a la API (nunca se confía en el cuerpo del aviso)
    const p = await this.call(`/v1/payments/${encodeURIComponent(dataId)}`, { method: "GET" });
    const st = String(p.status);
    const status = st === "approved" ? "APPROVED" : st === "refunded" || st === "charged_back" ? "REFUNDED" : st === "rejected" || st === "cancelled" ? "REJECTED" : "PENDING";
    const pm = String(p.payment_method_id ?? ""), pt = String(p.payment_type_id ?? "");
    const method: PaymentMethodKind = pm === "yape" ? "YAPE" : pt === "credit_card" || pt === "debit_card" ? "CARD" : pt === "bank_transfer" ? "TRANSFER" : "OTHER";
    if (!p.external_reference) return null;
    return { eventId: `${dataId}:${st}`, invoiceId: String(p.external_reference), amountCents: Math.round(Number(p.transaction_amount) * 100), currency: String(p.currency_id ?? "PEN"), providerRef: String(dataId), status, method };
  }
}

/** Pasarela del entorno (null si no hay: solo pagos manuales). */
export function getGateway(): PaymentGateway | null {
  const p = paymentProvider();
  if (p === "MOCK") return process.env.NODE_ENV === "production" ? null : new MockGateway();
  if (p === "MERCADOPAGO") {
    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN, webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    return accessToken && webhookSecret ? new MercadoPagoGateway({ accessToken, webhookSecret }) : null;
  }
  return null;
}
