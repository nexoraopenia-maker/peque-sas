import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRACE_DAYS, RENEWAL_LEAD_DAYS, addDays, decideCycle, dueInfo, paidPeriodEnd, periodDays, signMercadoPago, verifyMercadoPagoSignature, mockSignature, verifyMockSignature } from "@/lib/subscriptions/pure";
import { GatewayAuthError, GatewayError, MercadoPagoGateway } from "@/lib/subscriptions/gateway";
import { serverEnvSchema, validateEnv } from "@/lib/env";
import { featureEnabled, pctUsed } from "@/lib/plans/pure";

const T0 = new Date("2026-12-01T12:00:00Z");
const sub = (over: Partial<{ status: "ACTIVE" | "PAST_DUE" | "CANCELED"; end: Date; grace: Date | null }> = {}) => ({ status: over.status ?? "ACTIVE", currentPeriodEnd: over.end ?? addDays(T0, 30), graceUntil: over.grace ?? null });

describe("ciclo de cobro (decisiones puras)", () => {
  it("no hace nada lejos del vencimiento", () => expect(decideCycle(sub(), false, T0)).toEqual([]));
  it("genera el cobro con 7 días de anticipación, una sola vez", () => {
    const end = sub().currentPeriodEnd;
    expect(decideCycle(sub(), false, addDays(end, -RENEWAL_LEAD_DAYS - 1))).toEqual([]);
    expect(decideCycle(sub(), false, addDays(end, -RENEWAL_LEAD_DAYS))).toEqual(["CREATE_INVOICE"]);
    expect(decideCycle(sub(), true, addDays(end, -3))).toEqual([]);
  });
  it("vencido: marca vencida y, pasada la gracia, bloquea", () => {
    const end = sub().currentPeriodEnd;
    expect(decideCycle(sub(), true, addDays(end, 1))).toEqual(["MARK_PAST_DUE"]);
    expect(decideCycle(sub({ status: "PAST_DUE", grace: addDays(end, GRACE_DAYS) }), true, addDays(end, GRACE_DAYS - 1))).toEqual([]);
    expect(decideCycle(sub({ status: "PAST_DUE", grace: addDays(end, GRACE_DAYS) }), true, addDays(end, GRACE_DAYS + 1))).toEqual(["SUSPEND"]);
    // el cron estuvo caído: de activa a bloqueada en una sola pasada
    expect(decideCycle(sub(), true, addDays(end, GRACE_DAYS + 3))).toEqual(["MARK_PAST_DUE", "SUSPEND"]);
    expect(decideCycle(sub(), false, addDays(end, 1))).toEqual(["CREATE_INVOICE", "MARK_PAST_DUE"]);
  });
  it("una suscripción cancelada nunca genera acciones", () => expect(decideCycle(sub({ status: "CANCELED", end: addDays(T0, -100) }), false, T0)).toEqual([]));
  it("estado para el propietario", () => {
    expect(dueInfo(null, T0)).toBeNull();
    expect(dueInfo(sub(), T0)).toMatchObject({ state: "OK", daysLeft: 30 });
    expect(dueInfo(sub({ end: addDays(T0, 3) }), T0)).toMatchObject({ state: "DUE_SOON", daysLeft: 3 });
    expect(dueInfo(sub({ end: addDays(T0, -2) }), T0)).toMatchObject({ state: "PAST_DUE", daysLeft: -2 });
    expect(dueInfo(sub({ status: "CANCELED" }), T0)?.state).toBe("CANCELED");
  });
  it("al pagar el periodo se suma al vigente o cuenta desde hoy si ya venció", () => {
    expect(paidPeriodEnd(addDays(T0, 5), 30, T0).toISOString()).toBe(addDays(T0, 35).toISOString());
    expect(paidPeriodEnd(addDays(T0, -5), 30, T0).toISOString()).toBe(addDays(T0, 30).toISOString());
    expect(periodDays(T0, addDays(T0, 30))).toBe(30);
  });
});

describe("firmas de pasarela", () => {
  it("Mercado Pago: acepta la firma correcta y rechaza cualquier alteración", () => {
    const sig = signMercadoPago("secreto", "123ABC", "req-1", "1700000000000");
    const ok = { secret: "secreto", xSignature: sig, xRequestId: "req-1", dataId: "123ABC" };
    expect(verifyMercadoPagoSignature(ok)).toBe(true);
    expect(verifyMercadoPagoSignature({ ...ok, secret: "otro" })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...ok, dataId: "999" })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...ok, xRequestId: "req-2" })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...ok, xSignature: sig.replace("ts=1700000000000", "ts=1") })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...ok, xSignature: null })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...ok, xSignature: "basura" })).toBe(false);
    expect(verifyMercadoPagoSignature({ ...ok, secret: "" })).toBe(false);
  });
  it("sandbox: HMAC del cuerpo crudo", () => {
    const raw = Buffer.from('{"a":1}');
    expect(verifyMockSignature(raw, mockSignature(raw, "k"), "k")).toBe(true);
    expect(verifyMockSignature(Buffer.from('{"a":2}'), mockSignature(raw, "k"), "k")).toBe(false);
    expect(verifyMockSignature(raw, null, "k")).toBe(false);
    expect(verifyMockSignature(raw, "00", "k")).toBe(false);
  });
});

describe("pasarela Mercado Pago (contra un fetch simulado; NO es Mercado Pago real)", () => {
  const SECRET = "whsec";
  const hdr = (dataId: string, over: Record<string, string> = {}) => new Headers({ "x-signature": signMercadoPago(SECRET, dataId, "rq1", "1700000000000"), "x-request-id": "rq1", ...over });
  const mk = (handler: (url: string, init: RequestInit) => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); }) as unknown as typeof fetch;
    return { gw: new MercadoPagoGateway({ accessToken: "APP_USR-token", webhookSecret: SECRET, fetchImpl: f }), calls };
  };
  const pay = (over: Record<string, unknown> = {}) => Response.json({ status: "approved", external_reference: "inv-1", transaction_amount: 59, currency_id: "PEN", payment_type_id: "credit_card", payment_method_id: "visa", ...over });

  it("crea la preferencia con monto, referencia externa y URL de aviso; solo acepta una URL de pago de mercadopago", async () => {
    const { gw, calls } = mk(() => Response.json({ id: "pref-1", init_point: "https://www.mercadopago.com.pe/checkout/v1/redirect?pref_id=pref-1" }));
    const r = await gw.createCheckout({ id: "inv-1", amountCents: 5900, description: "Suscripción Pro" }, { notificationUrl: "https://app.test/api/webhooks/payments/mercadopago", backUrl: "https://app.test/billing" });
    expect(r).toMatchObject({ providerRef: "pref-1" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ external_reference: "inv-1", notification_url: "https://app.test/api/webhooks/payments/mercadopago", items: [{ currency_id: "PEN", unit_price: 59, quantity: 1 }] });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer APP_USR-token");
    const evil = mk(() => Response.json({ id: "x", init_point: "https://evil.example.com/pay" }));
    await expect(evil.gw.createCheckout({ id: "i", amountCents: 100, description: "x" }, { notificationUrl: "u", backUrl: "b" })).rejects.toBeInstanceOf(GatewayError);
    const down = mk(() => new Response("", { status: 500 }));
    await expect(down.gw.createCheckout({ id: "i", amountCents: 100, description: "x" }, { notificationUrl: "u", backUrl: "b" })).rejects.toBeInstanceOf(GatewayError);
  });
  it("aviso firmado: consulta el pago real y lo normaliza (estado y monto salen de la API, no del aviso)", async () => {
    const { gw, calls } = mk(() => pay());
    const ev = await gw.parseWebhook(Buffer.from(JSON.stringify({ type: "payment", data: { id: "777" }, amount: 1 })), hdr("777"), new URLSearchParams());
    expect(ev).toEqual({ eventId: "777:approved", invoiceId: "inv-1", amountCents: 5900, currency: "PEN", providerRef: "777", status: "APPROVED", method: "CARD" });
    expect(calls[0]!.url).toContain("/v1/payments/777");
    const q = await gw.parseWebhook(Buffer.from("{}"), hdr("888"), new URLSearchParams("type=payment&data.id=888"));
    expect(q?.providerRef).toBe("888");                                                                    // leyó data.id de la query
    expect(calls[1]!.url).toContain("/v1/payments/888");
  });
  it("mapea estados y medios (Yape, transferencia, reembolsos)", async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ status: "pending" }, "PENDING", "CARD"], [{ status: "in_process" }, "PENDING", "CARD"], [{ status: "rejected" }, "REJECTED", "CARD"], [{ status: "refunded" }, "REFUNDED", "CARD"], [{ status: "charged_back" }, "REFUNDED", "CARD"],
      [{ payment_method_id: "yape", payment_type_id: "bank_transfer" }, "APPROVED", "YAPE"], [{ payment_type_id: "bank_transfer", payment_method_id: "pagoefectivo" }, "APPROVED", "TRANSFER"], [{ payment_type_id: "ticket", payment_method_id: "x" }, "APPROVED", "OTHER"],
    ];
    for (const [over, status, method] of cases) {
      const { gw } = mk(() => pay(over));
      expect(await gw.parseWebhook(Buffer.from("{}"), hdr("5"), new URLSearchParams("type=payment&data.id=5"))).toMatchObject({ status, method });
    }
  });
  it("rechaza firmas inválidas SIN consultar la API; ignora avisos que no son de pagos", async () => {
    const { gw, calls } = mk(() => pay());
    const body = Buffer.from(JSON.stringify({ type: "payment", data: { id: "9" } }));
    await expect(gw.parseWebhook(body, new Headers(), new URLSearchParams())).rejects.toBeInstanceOf(GatewayAuthError);
    await expect(gw.parseWebhook(body, hdr("10"), new URLSearchParams())).rejects.toBeInstanceOf(GatewayAuthError);          // firma de otro id
    await expect(gw.parseWebhook(body, hdr("9", { "x-request-id": "otro" }), new URLSearchParams())).rejects.toBeInstanceOf(GatewayAuthError);
    expect(calls).toHaveLength(0);
    expect(await gw.parseWebhook(Buffer.from(JSON.stringify({ type: "merchant_order", data: { id: "9" } })), hdr("9"), new URLSearchParams())).toBeNull();
    const noRef = mk(() => pay({ external_reference: null }));
    expect(await noRef.gw.parseWebhook(body, hdr("9"), new URLSearchParams())).toBeNull();
  });
});

describe("límites por plan (lógica pura)", () => {
  const plan = { reportsEnabled: true, automationsEnabled: true };
  it("funciones: módulos contratados y banderas del plan", () => {
    expect(featureEnabled({ modules: ["WHATSAPP", "SUNAT"], plan }, "WHATSAPP")).toBe(true);
    expect(featureEnabled({ modules: ["SUNAT"], plan }, "WHATSAPP")).toBe(false);
    expect(featureEnabled({ modules: [], plan }, "SUNAT")).toBe(false);
    expect(featureEnabled({ modules: "basura", plan }, "SUNAT")).toBe(false);
    expect(featureEnabled({ modules: [], plan: { ...plan, reportsEnabled: false } }, "REPORTS")).toBe(false);
    expect(featureEnabled({ modules: ["WHATSAPP"], plan: { ...plan, automationsEnabled: false } }, "AUTOMATIONS")).toBe(false);
    expect(featureEnabled({ modules: [], plan }, "AUTOMATIONS")).toBe(false);                 // sin WhatsApp no hay chatbot
    expect(featureEnabled({ modules: ["WHATSAPP"], plan }, "AUTOMATIONS")).toBe(true);
  });
  it("porcentaje de uso", () => { expect(pctUsed(50, 100)).toBe(50); expect(pctUsed(150, 100)).toBe(100); expect(pctUsed(0, 0)).toBe(0); expect(pctUsed(1, 0)).toBe(100); });
});

describe("variables de entorno tipadas", () => {
  const ok = { NODE_ENV: "production", TURSO_DATABASE_URL: "libsql://x.turso.io", TURSO_AUTH_TOKEN: "t", AUTH_SECRET: "a".repeat(32), APP_URL: "https://app.example.com", CRON_SECRET: "c".repeat(16), ANTHROPIC_API_KEY: "k", META_APP_SECRET: "m", META_VERIFY_TOKEN: "v", BILLING_MANUAL_INSTRUCTIONS: "Yape 999" };
  it("una configuración de producción completa es válida y sin avisos relevantes", () => {
    const r = validateEnv(ok);
    expect(r.errors).toEqual([]); expect(r.ok).toBe(true);
  });
  it("detecta cada error de producción", () => {
    const err = (over: Record<string, string | undefined>) => validateEnv({ ...ok, ...over }).errors.join("|");
    expect(err({ AUTH_SECRET: "corto" })).toMatch(/AUTH_SECRET/);
    expect(err({ AUTH_SECRET: undefined })).toMatch(/AUTH_SECRET/);
    expect(err({ CRON_SECRET: "corto" })).toMatch(/CRON_SECRET/);
    expect(err({ APP_URL: "http://app.example.com" })).toMatch(/https/);
    expect(err({ APP_URL: "no-es-url" })).toMatch(/APP_URL/);
    expect(err({ TURSO_DATABASE_URL: undefined })).toMatch(/TURSO_DATABASE_URL/);
    expect(err({ TURSO_DATABASE_URL: "file:./prisma/local.db" })).toMatch(/local/);
    expect(err({ TURSO_AUTH_TOKEN: undefined })).toMatch(/TURSO_AUTH_TOKEN/);
    expect(err({ PAYMENT_PROVIDER: "MOCK" })).toMatch(/MOCK/);
    expect(err({ PAYMENT_PROVIDER: "PAYPAL" })).toMatch(/PAYMENT_PROVIDER/);
    expect(err({ PAYMENT_PROVIDER: "MERCADOPAGO" })).toMatch(/MERCADOPAGO_ACCESS_TOKEN/);
    expect(err({ PAYMENT_PROVIDER: "MERCADOPAGO", MERCADOPAGO_ACCESS_TOKEN: "t" })).toMatch(/MERCADOPAGO_WEBHOOK_SECRET/);
    expect(err({ PAYMENT_PROVIDER: "MERCADOPAGO", MERCADOPAGO_ACCESS_TOKEN: "t", MERCADOPAGO_WEBHOOK_SECRET: "s" })).toBe("");
    expect(err({ META_GRAPH_BASE_URL: "http://localhost:9" })).toMatch(/https/);
    expect(err({ META_API_VERSION: "27" })).toMatch(/META_API_VERSION/);
    expect(err({ ANTHROPIC_EFFORT: "extremo" })).toMatch(/ANTHROPIC_EFFORT/);
  });
  it("en desarrollo admite base local y MOCK; avisa de lo opcional", () => {
    const dev = validateEnv({ NODE_ENV: "development", TURSO_DATABASE_URL: "file:./prisma/local.db", AUTH_SECRET: "a".repeat(32), APP_URL: "http://localhost:3000", CRON_SECRET: "c".repeat(16), PAYMENT_PROVIDER: "MOCK" });
    expect(dev.ok).toBe(true);
    expect(dev.warnings.join("|")).toMatch(/ANTHROPIC_API_KEY/);
    expect(validateEnv({ ...ok, ANTHROPIC_API_KEY: undefined }).warnings.join("|")).toMatch(/ANTHROPIC_API_KEY/);
  });
  it("nunca incluye valores secretos en sus mensajes", () => {
    const r = validateEnv({ ...ok, AUTH_SECRET: "SECRETO-MUY-CORTO", CRON_SECRET: "tambien-secreto" });
    expect(JSON.stringify(r)).not.toMatch(/SECRETO-MUY-CORTO|tambien-secreto/);
  });
});

describe("configuración de despliegue en Vercel", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { if (["node_modules", ".next", "generated"].includes(n)) return []; const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const cronsOf = (f: string) => (JSON.parse(read(f)) as { crons: { path: string; schedule: string }[] }).crons;

  it("todo cron de vercel.json apunta a una ruta existente protegida con CRON_SECRET", () => {
    for (const f of ["vercel.json", "vercel.pro.json"]) for (const c of cronsOf(f)) {
      const file = `app${c.path}/route.ts`;
      expect(existsSync(file), `${f}: ${c.path}`).toBe(true);
      expect(read(file), file).toContain("isAuthorizedCron");
    }
  });
  it("vercel.json (plan Hobby) solo usa crons diarios; vercel.pro.json frecuencia mayor para SUNAT", () => {
    for (const c of cronsOf("vercel.json")) expect(c.schedule, c.path).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);          // minuto y hora fijos: una vez al día
    expect(cronsOf("vercel.pro.json").find((c) => c.path === "/api/cron/sunat")!.schedule).toBe("*/15 * * * *");
    expect(cronsOf("vercel.json").map((c) => c.path).sort()).toEqual(cronsOf("vercel.pro.json").map((c) => c.path).sort());
    expect(cronsOf("vercel.json").map((c) => c.path)).toContain("/api/cron/billing");
  });
  it("la región de las funciones coincide con la de Turso (us-east-1 = iad1)", () => expect(JSON.parse(read("vercel.json")).regions).toEqual(["iad1"]));
  it(".env.example documenta TODAS las variables que lee el código y todas las del esquema tipado", () => {
    const example = new Set([...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));
    const used = new Set(["app", "lib", "actions", "scripts", "proxy.ts", "instrumentation.ts", "prisma.config.ts"].flatMap((d) => (statSync(d).isDirectory() ? walk(d) : [d])).filter((f) => /\.(ts|tsx|mjs)$/.test(f))
      .flatMap((f) => [...read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!)));
    const ignore = new Set(["NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE", "DATABASE_URL"]);
    const missing = [...used].filter((v) => !ignore.has(v) && !example.has(v));
    expect(missing).toEqual([]);
    const schemaKeys = Object.keys(serverEnvSchema.shape).filter((k) => k !== "NODE_ENV");
    expect(schemaKeys.filter((k) => !example.has(k))).toEqual([]);
  });
  it(".env.example no contiene valores reales y .gitignore protege los .env", () => {
    for (const m of read(".env.example").matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)) {
      const [, k, v] = m;
      if (k === "PAYMENT_PROVIDER") expect(v).toBe("NONE"); else expect(v, k).toBe("");
    }
    const gi = read(".gitignore"); expect(gi).toMatch(/^\.env$/m); expect(gi).toMatch(/^\.env\.\*$/m); expect(gi).toMatch(/^!\.env\.example$/m); expect(gi).toMatch(/^\.vercel$/m);
  });
  it("las cabeceras de seguridad están configuradas", () => {
    const c = read("next.config.ts");
    for (const h of ["X-Content-Type-Options", "X-Frame-Options", "Strict-Transport-Security", "Referrer-Policy", "Permissions-Policy"]) expect(c).toContain(h);
    expect(c).toContain("poweredByHeader: false");
  });
  it("el webhook de pagos y el cron exigen autenticación propia (firma / CRON_SECRET)", () => {
    expect(read("app/api/webhooks/payments/[provider]/route.ts")).toContain("parseWebhook");
    expect(read("app/api/cron/billing/route.ts")).toContain("isAuthorizedCron");
    expect(read("app/api/health/route.ts")).toContain("isAuthorizedCron");
  });
});
