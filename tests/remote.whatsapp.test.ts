import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/whatsapp/crypto";
import { signBody, escapeUnicode } from "@/lib/whatsapp/signature";
import { configSchema, deliver, getConfigView, saveConfig, setEnabled, subscribeWebhook, testConnection, WhatsAppError, type ConfigInput, type Fetch } from "@/lib/whatsapp/service";
import { handleWebhookPost, verifyWebhookChallenge } from "@/lib/whatsapp/webhook";
import { CASH_ALERT_THRESHOLD_CENTS, notifyCashAlert, notifyPortalCode, notifyReservationReminder, runReservationReminders, sendReminderClaimed } from "@/lib/whatsapp/notify";
import { requestCodeViaWhatsApp } from "@/lib/portal/self-service";
import { loginWithCode } from "@/lib/portal/auth";
import { limaDate } from "@/lib/utils/date";
import { addDays } from "@/lib/reservations/calendar";

// Contra Turso remoto (RUN_REMOTE_TESTS=1). Graph API = doble de pruebas inyectado (no hay credenciales reales de Meta).
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__wa_${Date.now()}`;
const startedAt = new Date();
const SECRET_A = "a1".repeat(16), SECRET_GLOBAL = "b2".repeat(16);
const PID_A = "100000000000001", PID_B = "100000000000002", WABA_A = "200000000000001", WABA_B = "200000000000002";
const TOKEN_A = "EAAtokenA_" + "x".repeat(40), TOKEN_B = "EAAtokenB_" + "y".repeat(40);
const PORTAL = "WAPORTAL";
let planId = "", A = "", B = "", staff = "", guardianA = "", guardianNoPhone = "", childA = "";

type Call = { url: URL; method: string; headers: Record<string, string>; body: any };
let wamSeq = 0; // global: los wamid reales de Meta nunca se repiten
function graphMock(handler?: (c: Call, n: number) => { status?: number; json?: unknown } | void) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const c: Call = { url: new URL(String(input)), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const custom = handler?.(c, calls.length);
    if (custom) return new Response(JSON.stringify(custom.json ?? {}), { status: custom.status ?? 200 });
    if (c.url.pathname.endsWith("/messages")) return new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: c.body.to, wa_id: c.body.to }], messages: [{ id: `wamid.${tag}.m${++wamSeq}` }] }));
    return new Response("{}");
  }) as unknown as Fetch;
  return { impl, calls };
}
const cfgInput = (over: Partial<ConfigInput> = {}): ConfigInput => configSchema.parse({ phoneNumberId: PID_A, wabaId: WABA_A, accessToken: TOKEN_A, appSecret: SECRET_A, ...over });
const sign = (secret: string, obj: unknown) => { const raw = Buffer.from(JSON.stringify(obj)); return { raw, sig: signBody(secret, raw) }; };
const inbound = (pid: string, id: string, from: string, text: string, ts = Math.floor(Date.now() / 1000)) => ({ object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { display_phone_number: "51900000000", phone_number_id: pid },
  contacts: [{ profile: { name: "Cliente Prueba" }, wa_id: from }], messages: [{ from, id, timestamp: String(ts), type: "text", text: { body: text } }] } }] }] });
const statusEvt = (pid: string, wamid: string, status: string, errors?: unknown[]) => ({ object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: pid }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "51911111111", ...(errors ? { errors } : {}) }] } }] }] });
const post = (secret: string, obj: unknown) => { const s = sign(secret, obj); return handleWebhookPost(s.raw, s.sig); };
const count = (w: object) => db.whatsAppMessage.count({ where: w as never });

run("Fase 11: WhatsApp Meta Cloud API (Turso remoto)", () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "s".repeat(48);
    process.env.META_APP_SECRET = SECRET_GLOBAL;
    process.env.META_VERIFY_TOKEN = "token-global-de-prueba";
    process.env.APP_URL = "https://app.example.test";
    planId = (await db.plan.create({ data: { name: tag, modules: [] } })).id;
    A = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId, modules: ["WHATSAPP"], portalEnabled: true, portalCode: PORTAL } })).id;
    B = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId, modules: ["WHATSAPP"] } })).id;
    staff = (await db.user.create({ data: { email: `${tag}@example.test`, name: "s", role: "OWNER", tenantId: A, passwordHash: "x" } })).id;
    childA = (await db.child.create({ data: { tenantId: A, fullName: "Niño WA" } })).id;
    guardianA = (await db.guardian.create({ data: { tenantId: A, fullName: "Madre WA", dni: "71000001", phone: "987654321", phoneDigits: "987654321" } })).id;
    guardianNoPhone = (await db.guardian.create({ data: { tenantId: A, fullName: "Sin teléfono", dni: "71000002" } })).id;
    for (const g of [guardianA, guardianNoPhone]) await db.childGuardian.create({ data: { tenantId: A, childId: childA, guardianId: g, canPickup: true } });
    await saveConfig(A, staff, cfgInput({ ownerAlertPhone: "955 123 456", tplCashAlert: "alerta_caja" }));
    await saveConfig(B, staff, configSchema.parse({ phoneNumberId: PID_B, wabaId: WABA_B, accessToken: TOKEN_B })); // B usa el App Secret global
  }, 180000);

  afterAll(async () => {
    const w = { where: { tenantId: { in: [A, B] } } };
    for (const m of ["whatsAppOrphanStatus", "whatsAppMessage", "whatsAppConversation", "whatsAppConfig", "parentAccessCode", "reservation", "childGuardian", "guardian", "child", "auditLog", "user"] as const) {
      await (db[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany(w);
    }
    await db.parentAuthEvent.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await db.tenant.deleteMany({ where: { id: { in: [A, B] } } }); await db.plan.deleteMany({ where: { id: planId } });
  }, 180000);

  // ---------- Cifrado ----------
  it("los secretos están CIFRADOS en la base y la vista del panel nunca los expone", async () => {
    const row = await db.whatsAppConfig.findUniqueOrThrow({ where: { tenantId: A } });
    const dump = JSON.stringify(row);
    for (const secret of [TOKEN_A, SECRET_A]) expect(dump).not.toContain(secret);
    expect(row.accessTokenEnc).toMatch(/^v1\./);
    expect(decryptSecret(row.accessTokenEnc, A, "accessToken")).toBe(TOKEN_A);
    expect(decryptSecret(row.appSecretEnc!, A, "appSecret")).toBe(SECRET_A);
    expect(row.accessTokenLast4).toBe(TOKEN_A.slice(-4));
    expect(() => decryptSecret(row.accessTokenEnc, B, "accessToken")).toThrow();          // otro tenant
    expect(() => decryptSecret(row.accessTokenEnc, A, "appSecret")).toThrow();            // otro campo
    const raw = await db.$queryRaw<{ accessTokenEnc: string }[]>`SELECT "accessTokenEnc" FROM "WhatsAppConfig" WHERE "tenantId" = ${A}`;
    expect(raw[0]!.accessTokenEnc).not.toContain("EAAtoken");
    const view = JSON.stringify(await getConfigView(A));
    for (const s of [TOKEN_A, SECRET_A, row.accessTokenEnc, row.verifyTokenHash]) expect(view).not.toContain(s);
    expect(row.verifyTokenHash).not.toContain((await getConfigView(A))!.verifyToken);
  }, 120000);

  it("un texto cifrado copiado a OTRO tenant no sirve (datos autenticados)", async () => {
    const a = await db.whatsAppConfig.findUniqueOrThrow({ where: { tenantId: A } });
    const b = await db.whatsAppConfig.findUniqueOrThrow({ where: { tenantId: B } });
    await db.whatsAppConfig.update({ where: { tenantId: B }, data: { accessTokenEnc: a.accessTokenEnc, lastTestOk: true } });
    const m = graphMock();
    const r = await testConnection(B, m.impl);                    // no descifra: no se llama a Meta y no se habilita
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/No se pudieron leer las credenciales/) });
    expect(m.calls).toHaveLength(0);
    await db.whatsAppConfig.update({ where: { tenantId: B }, data: { accessTokenEnc: b.accessTokenEnc, lastTestOk: null } });
  }, 120000);

  it("un número solo puede pertenecer a un establecimiento", async () => {
    await expect(saveConfig(B, staff, configSchema.parse({ phoneNumberId: PID_A, wabaId: WABA_B, accessToken: TOKEN_B }))).rejects.toThrow(/ya está conectado/);
    expect((await db.whatsAppConfig.findUniqueOrThrow({ where: { tenantId: B } })).phoneNumberId).toBe(PID_B);
  }, 90000);

  it("guardar con el teléfono del propietario vacío conserva el guardado", async () => {
    await saveConfig(A, staff, cfgInput({ ownerAlertPhone: undefined, tplCashAlert: "alerta_caja" }));
    expect((await db.whatsAppConfig.findUniqueOrThrow({ where: { tenantId: A } })).ownerAlertPhone).toBe("51955123456");
  }, 90000);

  it("validación de entradas de configuración", () => {
    for (const bad of [{ phoneNumberId: "12" }, { phoneNumberId: "123/../x" }, { wabaId: "abc" }, { accessToken: "corto" }, { appSecret: "zz" }, { apiVersion: "27" }, { tplCashAlert: "Con Espacios" }])
      expect(() => configSchema.parse({ phoneNumberId: PID_A, wabaId: WABA_A, accessToken: TOKEN_A, ...bad }), JSON.stringify(bad)).toThrow();
    expect(() => configSchema.parse({ phoneNumberId: PID_A, wabaId: WABA_A, tplPortalCode: "codigo_portal", apiVersion: "v27.0" })).not.toThrow();
  });

  // ---------- Prueba de conexión / activación ----------
  it("la activación exige una prueba de conexión exitosa contra Graph API (número ∈ WABA)", async () => {
    await expect(setEnabled(A, true)).rejects.toThrow(/prueba de conexión/);
    const bad = graphMock((c) => c.url.pathname.includes("/phone_numbers") ? { json: { data: [{ id: "999999999999999" }] } } : { json: { id: PID_A, display_phone_number: "51 900 000 000" } });
    expect((await testConnection(A, bad.impl)).ok).toBe(false);
    await expect(setEnabled(A, true)).rejects.toThrow(WhatsAppError);
    const exp = graphMock((c) => { throw new Error("no debería llamarse " + c.url); });
    void exp;
    const token190 = graphMock(() => ({ status: 401, json: { error: { message: "expired", code: 190 } } }));
    const r190 = await testConnection(A, token190.impl);
    expect(r190.ok).toBe(false);
    expect(r190.error).toMatch(/Token inválido o vencido/);
    expect(JSON.stringify(token190.calls[0]!.headers)).toContain(TOKEN_A);                 // el token del tenant sale solo hacia Graph
    const good = graphMock((c) => c.url.pathname.includes("/phone_numbers") ? { json: { data: [{ id: PID_A }] } } : { json: { id: PID_A, display_phone_number: "51 900 000 000", verified_name: "Centro Prueba", quality_rating: "GREEN" } });
    expect((await testConnection(A, good.impl)).ok).toBe(true);
    expect(good.calls[0]!.url.pathname).toBe(`/v27.0/${PID_A}`);
    const v = (await getConfigView(A))!;
    expect([v.lastTestOk, v.displayPhoneNumber, v.verifiedName, v.qualityRating]).toEqual([true, "51 900 000 000", "Centro Prueba", "GREEN"]);
    await setEnabled(A, true);
    expect((await db.whatsAppConfig.findUniqueOrThrow({ where: { tenantId: A } })).enabled).toBe(true);
  }, 180000);

  it("cambiar el número o el token desactiva y obliga a probar de nuevo; la suscripción exige https y prueba previa", async () => {
    const sub = graphMock((c) => c.url.pathname.endsWith("/subscribed_apps") ? { json: { success: true } } : undefined);
    await subscribeWebhook(A, true, sub.impl);
    const body = sub.calls[0]!.body;
    expect(body.override_callback_uri).toBe("https://app.example.test/api/webhooks/whatsapp");
    expect(body.verify_token).toBe((await getConfigView(A))!.verifyToken);
    expect((await getConfigView(A))!.subscribedAt).not.toBeNull();
    const http = process.env.APP_URL; process.env.APP_URL = "http://localhost:3000";
    await expect(subscribeWebhook(A, true, sub.impl)).rejects.toThrow(/https/);
    process.env.APP_URL = http;
    await saveConfig(A, staff, cfgInput({ ownerAlertPhone: "955123456", tplCashAlert: "alerta_caja", accessToken: undefined }));
    expect((await db.whatsAppConfig.findUniqueOrThrow({ where: { tenantId: A } })).enabled).toBe(true); // sin cambios de credenciales sigue activo
    await saveConfig(A, staff, cfgInput({ accessToken: TOKEN_A + "Z", ownerAlertPhone: "955123456", tplCashAlert: "alerta_caja" }));
    const after = await db.whatsAppConfig.findUniqueOrThrow({ where: { tenantId: A } });
    expect([after.enabled, after.lastTestOk, after.subscribedAt]).toEqual([false, null, null]);
    await saveConfig(A, staff, cfgInput({ accessToken: TOKEN_A, ownerAlertPhone: "955123456", tplCashAlert: "alerta_caja" }));
    const good = graphMock((c) => c.url.pathname.includes("/phone_numbers") ? { json: { data: [{ id: PID_A }] } } : { json: { id: PID_A } });
    await testConnection(A, good.impl); await setEnabled(A, true);
    // B queda activo con App Secret global
    const gb = graphMock((c) => c.url.pathname.includes("/phone_numbers") ? { json: { data: [{ id: PID_B }] } } : { json: { id: PID_B } });
    await testConnection(B, gb.impl); await setEnabled(B, true);
  }, 240000);

  // ---------- Webhook: verificación ----------
  it("GET de verificación: token global o por tenant; cualquier otro se rechaza", async () => {
    const own = (await getConfigView(A))!.verifyToken;
    expect(await verifyWebhookChallenge({ mode: "subscribe", token: own, challenge: "1158201444" })).toEqual({ status: 200, body: "1158201444" });
    expect(await verifyWebhookChallenge({ mode: "subscribe", token: "token-global-de-prueba", challenge: "42" })).toEqual({ status: 200, body: "42" });
    for (const q of [{ mode: "subscribe", token: "mal", challenge: "1" }, { mode: "unsubscribe", token: own, challenge: "1" }, { mode: "subscribe", token: own, challenge: "<script>" }, { mode: "subscribe", token: own }, { mode: null, token: null, challenge: null }, { mode: "subscribe", token: "x".repeat(400), challenge: "1" }])
      expect((await verifyWebhookChallenge(q as never)).status, JSON.stringify(q)).toBe(403);
  }, 90000);

  // ---------- Webhook: firma ----------
  it("POST: sin firma o con firma inválida → 401 y NO se guarda nada", async () => {
    const evt = inbound(PID_A, `wamid.${tag}.bad`, "51911111111", "no debe guardarse");
    const raw = Buffer.from(JSON.stringify(evt));
    for (const sig of [null, "", "sha256=" + "0".repeat(64), signBody("c3".repeat(16), raw), signBody(SECRET_A, raw).replace("sha256=", "")])
      expect((await handleWebhookPost(raw, sig)).status, String(sig)).toBe(401);
    expect((await handleWebhookPost(Buffer.from("no-json"), signBody(SECRET_A, "no-json"))).status).toBe(401);
    expect((await handleWebhookPost(Buffer.from(JSON.stringify({ object: "page", entry: [] })), "sha256=" + "0".repeat(64))).status).toBe(401);
    expect((await handleWebhookPost(Buffer.alloc(0), null)).status).toBe(400);
    expect((await handleWebhookPost(Buffer.alloc(1_000_001, 65), null)).status).toBe(413);
    expect(await count({ tenantId: A, waMessageId: `wamid.${tag}.bad` })).toBe(0);
  }, 90000);

  it("POST válido: guarda conversación y mensaje; Meta reintenta el MISMO mensaje → idempotente", async () => {
    const evt = inbound(PID_A, `wamid.${tag}.in1`, "51911111111", "Hola, quiero reservar");
    const r1 = await post(SECRET_A, evt);
    expect(r1.status).toBe(200);
    expect(JSON.parse(r1.body)).toMatchObject({ messages: 1, duplicates: 0 });
    for (let i = 0; i < 3; i++) expect(JSON.parse((await post(SECRET_A, evt)).body)).toMatchObject({ messages: 0, duplicates: 1 });
    expect(await count({ tenantId: A, waMessageId: `wamid.${tag}.in1` })).toBe(1);
    const conv = await db.whatsAppConversation.findFirstOrThrow({ where: { tenantId: A, waId: "51911111111" } });
    expect([conv.contactName, conv.lastInboundAt !== null]).toEqual(["Cliente Prueba", true]);
    const msg = await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, waMessageId: `wamid.${tag}.in1` } });
    expect([msg.direction, msg.type, msg.status, msg.body]).toEqual(["IN", "TEXT", "RECEIVED", "Hola, quiero reservar"]);
  }, 120000);

  it("entregas simultáneas del mismo evento crean UN solo mensaje", async () => {
    const evt = inbound(PID_A, `wamid.${tag}.race`, "51922222222", "carrera");
    const res = await Promise.all(Array.from({ length: 6 }, () => post(SECRET_A, evt)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await count({ tenantId: A, waMessageId: `wamid.${tag}.race` })).toBe(1);
    expect(await db.whatsAppConversation.count({ where: { tenantId: A, waId: "51922222222" } })).toBe(1);
  }, 180000);

  it("Unicode: se acepta la firma sobre el cuerpo crudo y la variante con Unicode escapado", async () => {
    const evt = inbound(PID_A, `wamid.${tag}.u1`, "51933333333", "¡Hola! ñandú 😀");
    const raw = Buffer.from(JSON.stringify(evt));
    expect((await handleWebhookPost(raw, signBody(SECRET_A, raw))).status).toBe(200);
    const evt2 = inbound(PID_A, `wamid.${tag}.u2`, "51933333333", "¿Qué tal? 🎈");
    const raw2 = Buffer.from(JSON.stringify(evt2));
    expect((await handleWebhookPost(raw2, signBody(SECRET_A, escapeUnicode(raw2.toString("utf8"))))).status).toBe(200);
    expect((await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, waMessageId: `wamid.${tag}.u1` } })).body).toBe("¡Hola! ñandú 😀");
    expect(await count({ tenantId: A, waMessageId: `wamid.${tag}.u2` })).toBe(1);
  }, 120000);

  // ---------- Aislamiento multi-tenant ----------
  it("un tenant con su propio App Secret NO puede inyectar eventos en el número de OTRO tenant", async () => {
    // Cuerpo con dos entradas (número de A y número de B) firmado con el secreto de A: solo se procesa lo de A
    const both = { object: "whatsapp_business_account", entry: [inbound(PID_A, `wamid.${tag}.mixA`, "51944444444", "para A").entry[0], inbound(PID_B, `wamid.${tag}.mixB`, "51944444444", "falsificado para B").entry[0]] };
    const r = await post(SECRET_A, both);
    expect(r.status).toBe(200);
    expect(await count({ tenantId: A, waMessageId: `wamid.${tag}.mixA` })).toBe(1);
    expect(await count({ tenantId: B, waMessageId: `wamid.${tag}.mixB` })).toBe(0);
    expect(await count({ waMessageId: `wamid.${tag}.mixB` })).toBe(0);
    // Evento legítimo firmado con el secreto global procesa B, pero no A
    const bothG = { object: "whatsapp_business_account", entry: [inbound(PID_A, `wamid.${tag}.gA`, "51955555555", "x").entry[0], inbound(PID_B, `wamid.${tag}.gB`, "51955555555", "legítimo B").entry[0]] };
    await post(SECRET_GLOBAL, bothG);
    expect(await count({ tenantId: B, waMessageId: `wamid.${tag}.gB` })).toBe(1);
    expect(await count({ tenantId: A, waMessageId: `wamid.${tag}.gA` })).toBe(0);
    // Las conversaciones del mismo cliente en cada tenant están separadas
    expect(await db.whatsAppConversation.count({ where: { tenantId: A, waId: "51955555555" } })).toBe(0);
    expect(await db.whatsAppConversation.count({ where: { tenantId: B, waId: "51955555555" } })).toBe(1);
  }, 180000);

  it("números desconocidos y tenants desactivados se ignoran sin error", async () => {
    expect(JSON.parse((await post(SECRET_GLOBAL, inbound("100000000000999", `wamid.${tag}.unk`, "51966666666", "x"))).body).ignored).toBeGreaterThan(0);
    await db.whatsAppConfig.update({ where: { tenantId: B }, data: { enabled: false } });
    expect(JSON.parse((await post(SECRET_GLOBAL, inbound(PID_B, `wamid.${tag}.off`, "51966666666", "x"))).body).ignored).toBeGreaterThan(0);
    expect(await count({ tenantId: B, waMessageId: `wamid.${tag}.off` })).toBe(0);
    await db.whatsAppConfig.update({ where: { tenantId: B }, data: { enabled: true } });
  }, 120000);

  // ---------- Envío y estados ----------
  it("envío saliente: guarda PENDING, usa el token/número del tenant y queda SENT con el id real devuelto", async () => {
    const m = graphMock();
    const r = await deliver({ tenantId: A, to: "987 654 321", purpose: "MANUAL", template: { name: "plantilla_x", components: [] }, fetchImpl: m.impl });
    expect(r.ok).toBe(true);
    const c = m.calls[0]!;
    expect(c.url.pathname).toBe(`/v27.0/${PID_A}/messages`);
    expect(c.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(c.body).toMatchObject({ to: "51987654321", type: "template", template: { name: "plantilla_x", language: { code: "es" } } });
    const row = await db.whatsAppMessage.findFirstOrThrow({ where: { id: r.ok ? r.messageId : "" } });
    expect([row.status, row.direction, row.type, row.waMessageId?.startsWith("wamid.")]).toEqual(["SENT", "OUT", "TEMPLATE", true]);
    // B usa su propio número y token
    const mb = graphMock();
    await deliver({ tenantId: B, to: "987654321", purpose: "MANUAL", template: { name: "p", components: [] }, fetchImpl: mb.impl });
    expect(mb.calls[0]!.url.pathname).toBe(`/v27.0/${PID_B}/messages`);
    expect(mb.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN_B}`);
  }, 120000);

  it("estados de entrega: solo avanzan, los duplicados no cambian nada y un 'sent' tardío no retrocede", async () => {
    const m = graphMock();
    const r = await deliver({ tenantId: A, to: "987654321", purpose: "MANUAL", template: { name: "p", components: [] }, fetchImpl: m.impl });
    if (!r.ok) throw new Error("envío");
    const id = r.waMessageId;
    const st = async () => (await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, waMessageId: id } })).status;
    expect(await st()).toBe("SENT");
    await post(SECRET_A, statusEvt(PID_A, id, "delivered")); expect(await st()).toBe("DELIVERED");
    await post(SECRET_A, statusEvt(PID_A, id, "read")); expect(await st()).toBe("READ");
    await post(SECRET_A, statusEvt(PID_A, id, "delivered")); expect(await st()).toBe("READ");   // tardío: no retrocede
    await post(SECRET_A, statusEvt(PID_A, id, "sent")); expect(await st()).toBe("READ");
    await post(SECRET_A, statusEvt(PID_A, id, "read")); expect(await st()).toBe("READ");        // duplicado
    await post(SECRET_A, statusEvt(PID_A, id, "failed", [{ code: 131026, title: "x" }])); expect(await st()).toBe("READ"); // fallo tardío no pisa un leído
  }, 180000);

  it("estado 'failed' desde SENT guarda código y detalle; un estado de OTRO tenant no afecta mi mensaje", async () => {
    const m = graphMock();
    const r = await deliver({ tenantId: A, to: "987654321", purpose: "MANUAL", template: { name: "p", components: [] }, fetchImpl: m.impl });
    if (!r.ok) throw new Error("envío");
    // evento de B (firmado con el secreto global) refiriéndose al wamid de A: no coincide con ningún mensaje de B
    await post(SECRET_GLOBAL, statusEvt(PID_B, r.waMessageId, "read"));
    expect((await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, waMessageId: r.waMessageId } })).status).toBe("SENT");
    await post(SECRET_A, statusEvt(PID_A, r.waMessageId, "failed", [{ code: 131026, title: "Message Undeliverable", error_data: { details: "Número sin WhatsApp" } }]));
    const row = await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, waMessageId: r.waMessageId } });
    expect([row.status, row.errorCode, row.errorDetail]).toEqual(["FAILED", 131026, "Número sin WhatsApp"]);
    expect(await db.whatsAppOrphanStatus.count({ where: { tenantId: B, waMessageId: r.waMessageId } })).toBe(1); // quedó como huérfano de B, sin tocar a A
  }, 180000);

  it("carrera envío/webhook: un estado que llega ANTES de guardar el id se aplica al terminar el envío", async () => {
    const wamid = `wamid.${tag}.carrera`;
    await post(SECRET_A, statusEvt(PID_A, wamid, "delivered"));
    expect(await db.whatsAppOrphanStatus.count({ where: { tenantId: A, waMessageId: wamid } })).toBe(1);
    const m = graphMock((c) => c.url.pathname.endsWith("/messages") ? { json: { messages: [{ id: wamid }] } } : undefined);
    const r = await deliver({ tenantId: A, to: "987654321", purpose: "MANUAL", template: { name: "p", components: [] }, fetchImpl: m.impl });
    expect(r.ok).toBe(true);
    expect((await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, waMessageId: wamid } })).status).toBe("DELIVERED");
    expect(await db.whatsAppOrphanStatus.count({ where: { tenantId: A, waMessageId: wamid } })).toBe(0);
  }, 180000);

  it("reglas de envío: sin configuración, teléfono inválido, texto fuera de ventana, plantilla sin ventana", async () => {
    const m = graphMock();
    const noCfg = await db.tenant.create({ data: { name: `${tag}-C`, businessType: "t", planId, modules: ["WHATSAPP"] } });
    expect(await deliver({ tenantId: noCfg.id, to: "987654321", purpose: "MANUAL", text: "x", fetchImpl: m.impl })).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
    await db.tenant.delete({ where: { id: noCfg.id } });
    expect(await deliver({ tenantId: A, to: "123", purpose: "MANUAL", text: "x", fetchImpl: m.impl })).toEqual({ ok: false, reason: "INVALID_PHONE" });
    expect(await deliver({ tenantId: A, to: "987000111", purpose: "MANUAL", text: "hola", fetchImpl: m.impl })).toMatchObject({ ok: false, reason: "OUTSIDE_WINDOW" });
    expect(m.calls).toHaveLength(0);                                                                       // nunca se llamó a Meta
    await post(SECRET_A, inbound(PID_A, `wamid.${tag}.win`, "51987000111", "hola"));                        // el cliente escribe: se abre la ventana
    expect((await deliver({ tenantId: A, to: "987000111", purpose: "MANUAL", text: "te respondo", fetchImpl: m.impl })).ok).toBe(true);
    expect(m.calls[0]!.body.type).toBe("text");
    expect((await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, direction: "OUT", type: "TEXT" } })).status).toBe("SENT");
  }, 180000);

  it("error de Meta: queda FAILED con código, detalle legible y SIN el token; reintentable según el código", async () => {
    const m = graphMock(() => ({ status: 400, json: { error: { message: `(#132001) plantilla ${TOKEN_A}`, code: 132001, error_data: { details: "template name does not exist" } } } }));
    const r = await deliver({ tenantId: A, to: "987654321", purpose: "MANUAL", template: { name: "no_existe", components: [] }, fetchImpl: m.impl });
    expect(r).toMatchObject({ ok: false, reason: "GRAPH_ERROR", retryable: false });
    const row = await db.whatsAppMessage.findFirstOrThrow({ where: { tenantId: A, templateName: "no_existe" } });
    expect([row.status, row.errorCode]).toEqual(["FAILED", 132001]);
    expect(JSON.stringify(row)).not.toContain(TOKEN_A.slice(0, 20) + "x".repeat(10));
    const rl = graphMock(() => ({ status: 429, json: { error: { message: "rate", code: 130429 } } }));
    expect(await deliver({ tenantId: A, to: "987654321", purpose: "MANUAL", template: { name: "p2", components: [] }, fetchImpl: rl.impl })).toMatchObject({ reason: "GRAPH_ERROR", retryable: true });
  }, 180000);

  // ---------- Disparos reales ----------
  it("a) código del portal: plantilla (utilidad y autenticación) o texto; el código NO se guarda en la base", async () => {
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { tplPortalCode: "codigo_portal", portalCodeTplKind: "UTILITY" } });
    const m = graphMock();
    const r = await notifyPortalCode({ tenantId: A, guardianId: guardianA, code: "12345678", minutes: 15, fetchImpl: m.impl });
    expect(r.ok).toBe(true);
    expect(m.calls[0]!.body.to).toBe("51987654321");                                          // teléfono REGISTRADO del apoderado
    expect(m.calls[0]!.body.template.components).toEqual([{ type: "body", parameters: [{ type: "text", text: "12345678" }, { type: "text", text: "15" }] }]);
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { portalCodeTplKind: "AUTHENTICATION" } });
    const m2 = graphMock();
    await notifyPortalCode({ tenantId: A, guardianId: guardianA, code: "87654321", minutes: 15, fetchImpl: m2.impl });
    expect(m2.calls[0]!.body.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "87654321" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "87654321" }] },
    ]);
    const stored = JSON.stringify(await db.whatsAppMessage.findMany({ where: { tenantId: A, purpose: "PORTAL_CODE" } }));
    expect(stored).not.toContain("12345678"); expect(stored).not.toContain("87654321");
    expect(stored).toContain("omitido por seguridad");
    expect(await notifyPortalCode({ tenantId: A, guardianId: guardianNoPhone, code: "11111111", minutes: 15, fetchImpl: m.impl })).toEqual({ ok: false, reason: "INVALID_PHONE" });
    expect(await notifyPortalCode({ tenantId: B, guardianId: guardianA, code: "11111111", minutes: 15, fetchImpl: m.impl })).toMatchObject({ ok: false });   // apoderado de OTRO tenant: sin teléfono → no se envía
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { tplPortalCode: null } });
  }, 240000);

  it("b) recordatorios de reservas: envío único, reclamo atómico y aislamiento por tenant", async () => {
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { tplReservationReminder: "recordatorio_reserva" } });
    await db.whatsAppConfig.update({ where: { tenantId: B }, data: { tplReservationReminder: "recordatorio_b" } });
    const tomorrow = addDays(limaDate(), 1);
    const mk = (tenantId: string, name: string, phone: string | null, over: object = {}) => db.reservation.create({ data: { tenantId, serviceType: "LUDOTECA", contactName: name, contactPhone: phone, date: tomorrow, startTime: "10:00", endTime: "11:00", attendees: 2, totalAmountCents: 5000, advancePaidCents: 2000, createdById: staff, ...over } });
    const rA = await mk(A, "Contacto A", "987111222"); await mk(A, "Sin teléfono", null); await mk(A, "Cancelada", "987333444", { status: "CANCELLED" });
    await mk(A, "Otro día", "987555666", { date: addDays(limaDate(), 3) }); await mk(B, "Contacto B", "987777888");
    const m = graphMock();
    const out = await runReservationReminders(new Date(), m.impl);
    expect(out).toMatchObject({ sent: 2, failed: 0 });
    const targets = m.calls.map((c) => c.body.to).sort();
    expect(targets).toEqual(["51987111222", "51987777888"]);
    for (const c of m.calls) expect(c.url.pathname).toBe(`/v27.0/${c.body.to === "51987111222" ? PID_A : PID_B}/messages`);       // cada uno con SU número
    const a = m.calls.find((c) => c.body.to === "51987111222")!;
    expect(a.body.template.name).toBe("recordatorio_reserva");
    expect(a.body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(["Contacto A", tomorrow, "10:00", "S/ 30.00"]);
    expect((await db.reservation.findFirstOrThrow({ where: { id: rA.id } })).reminderSentAt).not.toBeNull();
    const again = graphMock();
    expect(await runReservationReminders(new Date(), again.impl)).toMatchObject({ sent: 0 });                                    // idempotente: no vuelve a enviar
    expect(again.calls).toHaveLength(0);
    // reclamo simultáneo de una reserva nueva: solo una de las ejecuciones envía
    const r2 = await mk(A, "Carrera", "987999000");
    const cm = graphMock();
    const res = await Promise.all([1, 2, 3, 4].map(() => sendReminderClaimed({ tenantId: A, reservationId: r2.id, fetchImpl: cm.impl })));
    expect(res.filter((x) => x.ok)).toHaveLength(1);
    expect(cm.calls).toHaveLength(1);
    // si el envío falla se libera el reclamo para reintentar
    const r3 = await mk(A, "Falla", "987888000");
    const fail = graphMock(() => ({ status: 500, json: { error: { message: "x", code: 2 } } }));
    expect((await sendReminderClaimed({ tenantId: A, reservationId: r3.id, fetchImpl: fail.impl })).ok).toBe(false);
    expect((await db.reservation.findFirstOrThrow({ where: { id: r3.id } })).reminderSentAt).toBeNull();
    // otro tenant no puede enviar el recordatorio de una reserva ajena
    const r4 = await mk(A, "Ajena", "987123123");
    expect(await notifyReservationReminder({ tenantId: B, reservationId: r4.id, fetchImpl: graphMock().impl })).toMatchObject({ ok: false });
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { tplReservationReminder: null } });
    // Sin plantilla ni ventana abierta no se puede enviar: no se llama a Meta y el recordatorio queda por hacer
    await db.whatsAppConfig.update({ where: { tenantId: B }, data: { tplReservationReminder: null } });
    const r5 = await mk(B, "Sin plantilla", "987246810");
    const none = graphMock();
    expect(await sendReminderClaimed({ tenantId: B, reservationId: r5.id, fetchImpl: none.impl })).toMatchObject({ ok: false, reason: "OUTSIDE_WINDOW" });
    expect(none.calls).toHaveLength(0);
    expect((await db.reservation.findFirstOrThrow({ where: { id: r5.id } })).reminderSentAt).toBeNull();
  }, 300000);

  it("c) alerta de caja: solo si |diferencia| > S/ 5.00, al propietario, una sola vez por cierre", async () => {
    const m = graphMock();
    const base = { tenantId: A, expectedCents: 17000, declaredCents: 15000 };
    for (const d of [0, 500, -500, 100]) expect(await notifyCashAlert({ ...base, sessionId: `s-${d}`, differenceCents: d, fetchImpl: m.impl })).toEqual({ ok: false, reason: "BELOW_THRESHOLD" });
    expect(CASH_ALERT_THRESHOLD_CENTS).toBe(500);
    expect(m.calls).toHaveLength(0);
    const r = await notifyCashAlert({ ...base, sessionId: "sess-1", differenceCents: -2000, fetchImpl: m.impl });
    expect(r.ok).toBe(true);
    expect(m.calls[0]!.body.to).toBe("51955123456");
    expect(m.calls[0]!.body.template.name).toBe("alerta_caja");
    expect(m.calls[0]!.body.template.components[0].parameters.map((p: { text: string }) => p.text).slice(0, 3)).toEqual(["-S/ 20.00", "S/ 170.00", "S/ 150.00"]);
    const dup = await Promise.all([1, 2, 3].map(() => notifyCashAlert({ ...base, sessionId: "sess-1", differenceCents: -2000, fetchImpl: m.impl })));
    expect(dup.every((x) => !x.ok && x.reason === "DUPLICATE")).toBe(true);
    expect(m.calls).toHaveLength(1);                                                           // una sola alerta por cierre
    expect(await notifyCashAlert({ tenantId: B, sessionId: "sess-b", differenceCents: 900, expectedCents: 1, declaredCents: 1, fetchImpl: m.impl })).toMatchObject({ ok: false, reason: "INVALID_PHONE" }); // B sin teléfono de propietario
    // una alerta fallida no bloquea el reintento
    const fail = graphMock(() => ({ status: 500, json: { error: { message: "x", code: 2 } } }));
    expect((await notifyCashAlert({ ...base, sessionId: "sess-2", differenceCents: 900, fetchImpl: fail.impl })).ok).toBe(false);
    expect((await notifyCashAlert({ ...base, sessionId: "sess-2", differenceCents: 900, fetchImpl: m.impl })).ok).toBe(true);
  }, 240000);

  // ---------- Autoservicio del portal por WhatsApp ----------
  it("autoservicio: el código llega por WhatsApp al teléfono REGISTRADO, sirve para ingresar y no revela si el apoderado existe", async () => {
    await db.parentAuthEvent.deleteMany({ where: { createdAt: { gte: startedAt } } });
    // Sin plantilla aprobada ni ventana abierta no se emite ningún código (no se podría entregar)
    const idle = graphMock();
    await db.parentAccessCode.deleteMany({ where: { tenantId: A } });
    await requestCodeViaWhatsApp({ portalCode: PORTAL, identifier: "71000001", fetchImpl: idle.impl });
    expect(idle.calls).toHaveLength(0);
    expect(await db.parentAccessCode.count({ where: { tenantId: A } })).toBe(0);
    await db.parentAuthEvent.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { tplPortalCode: "codigo_portal", portalCodeTplKind: "UTILITY" } });
    const m = graphMock();
    await requestCodeViaWhatsApp({ portalCode: PORTAL, identifier: "71000001", fetchImpl: m.impl });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.body.to).toBe("51987654321");
    const code = m.calls[0]!.body.template.components[0].parameters[0].text as string;
    expect(code).toMatch(/^\d{8}$/);
    expect(code).toBeTruthy();
    const login = await loginWithCode({ portalCode: PORTAL, identifier: "71000001", code });
    expect(login.ok).toBe(true);
    // DNI inexistente: misma respuesta, ningún envío, ningún código
    const none = graphMock();
    const before = await db.parentAccessCode.count({ where: { tenantId: A } });
    expect(await requestCodeViaWhatsApp({ portalCode: PORTAL, identifier: "79999999", fetchImpl: none.impl })).toEqual({ limited: false });
    expect(none.calls).toHaveLength(0);
    expect(await db.parentAccessCode.count({ where: { tenantId: A } })).toBe(before);
    // apoderado sin teléfono registrado: no hay a dónde enviar
    await requestCodeViaWhatsApp({ portalCode: PORTAL, identifier: "71000002", fetchImpl: none.impl });
    expect(none.calls).toHaveLength(0);
    // enfriamiento por apoderado (60 s)
    await requestCodeViaWhatsApp({ portalCode: PORTAL, identifier: "987654321", fetchImpl: none.impl });
    expect(none.calls).toHaveLength(0);
  }, 240000);

  it("autoservicio: límite de solicitudes, WhatsApp desactivado y apoderado bloqueado no envían nada", async () => {
    await db.parentAuthEvent.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await db.parentAccessCode.deleteMany({ where: { tenantId: A } });
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { tplPortalCode: "codigo_portal" } });
    const m = graphMock();
    const r: { limited: boolean }[] = [];
    for (let i = 0; i < 5; i++) r.push(await requestCodeViaWhatsApp({ portalCode: PORTAL, identifier: "79990000", fetchImpl: m.impl }));
    expect(r.map((x) => x.limited)).toEqual([false, false, false, true, true]);              // 3 por identificador cada 15 min (exista o no)
    await db.parentAuthEvent.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { enabled: false } });
    await requestCodeViaWhatsApp({ portalCode: PORTAL, identifier: "71000001", fetchImpl: m.impl });
    expect(m.calls).toHaveLength(0);
    expect(await db.parentAccessCode.count({ where: { tenantId: A } })).toBe(0);             // no se emite un código que no se puede entregar
    await db.whatsAppConfig.update({ where: { tenantId: A }, data: { enabled: true } });
    await db.guardian.update({ where: { id: guardianA }, data: { portalBlocked: true } });
    await requestCodeViaWhatsApp({ portalCode: PORTAL, identifier: "71000001", fetchImpl: m.impl });
    expect(m.calls).toHaveLength(0);
    await db.guardian.update({ where: { id: guardianA }, data: { portalBlocked: false } });
  }, 240000);

  it("no se guardan cuerpos de mensajes ni secretos en los eventos de autenticación del portal", async () => {
    const ev = JSON.stringify(await db.parentAuthEvent.findMany({ where: { createdAt: { gte: startedAt } } }));
    expect(ev).not.toContain("71000001");
    expect(ev).not.toContain("987654321");
  }, 60000);
});
