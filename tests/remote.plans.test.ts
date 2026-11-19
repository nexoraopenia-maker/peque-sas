import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ForbiddenError } from "@/lib/rbac";
import { assertFeature, canStore, createUserWithinLimit, hasFeature, setUserActiveWithinLimit, usageSummary } from "@/lib/plans/limits";
import { changeTenantPlan, reactivateTenant, suspendTenant } from "@/lib/superadmin/service";
import { applyPaymentEvent, confirmReportedPayment, createRenewalInvoice, registerPayment, rejectReportedPayment, reportManualPayment, runBillingCycle, settleInvoice, startCheckout } from "@/lib/subscriptions/service";
import { signMockEvent, type ParsedPayment, type PaymentGateway } from "@/lib/subscriptions/gateway";
import { GRACE_DAYS, TRIAL_DAYS, addDays } from "@/lib/subscriptions/pure";
import { createDocumentForSale, fetchArtifacts } from "@/lib/sunat/service";
import { POST as webhook } from "@/app/api/webhooks/payments/[provider]/route";
import { GET as cronBilling } from "@/app/api/cron/billing/route";

// Contra Turso remoto (RUN_REMOTE_TESTS=1).
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__plans_${Date.now()}`;
let freePlan = "", paidPlan = "", paid2 = "", A = "", B = "", C = "", SA = "", uA = "", uB = "", seq = 0;
const created: string[] = [];
const email = (n: string) => `${tag}-${n}-${++seq}@example.test`;
const mkUser = (tenantId: string | null, role: "OWNER" | "ADMIN" | "RECEPTION" | "SUPERADMIN", active = true) => db.user.create({ data: { email: email(role), name: role, role, tenantId, passwordHash: "x", mustChangePassword: false, isActive: active } });
const mkTenant = async (name: string, planId: string, over: Record<string, unknown> = {}) => { const t = await db.tenant.create({ data: { name: `${tag}-${name}`, businessType: "t", planId, modules: [], ...over } }); created.push(t.id); return t.id; };
const sub = (t: string) => db.subscription.findFirstOrThrow({ where: { tenantId: t } });
const tn = (t: string) => db.tenant.findFirstOrThrow({ where: { id: t } });
const invs = (t: string) => db.saasInvoice.findMany({ where: { tenantId: t }, orderBy: { periodStart: "asc" } });
const ev = (invoiceId: string, over: Partial<ParsedPayment> = {}): ParsedPayment => ({ eventId: `${tag}-e${++seq}`, invoiceId, amountCents: 5000, currency: "PEN", providerRef: "ref", status: "APPROVED", method: "CARD", ...over });
const wipe = async () => {
  const ids = created;
  const w = { where: { tenantId: { in: ids } } };
  await db.paymentEvent.deleteMany({ where: { OR: [{ eventId: { startsWith: tag } }, { tenantId: { in: ids } }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ tenantId: { in: ids } }, { actorId: SA }] } });
  for (const m of ["saasInvoice", "subscription", "sunatDocument", "sunatConfig", "saleItem", "sale", "cashRegisterSession", "user"] as const) await (db[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany(w);
  await db.user.deleteMany({ where: { id: SA } });
  await db.tenant.deleteMany({ where: { id: { in: ids } } });
  await db.plan.deleteMany({ where: { name: { startsWith: tag } } });
};

run("Fase 17: límites por plan, suscripciones y pagos (Turso remoto)", () => {
  beforeAll(async () => {
    freePlan = (await db.plan.create({ data: { name: `${tag}-free`, modules: [], maxUsers: 3, priceCents: 0, storageMb: 0, botMonthlyReplies: 2, automationsEnabled: true, reportsEnabled: false } })).id;
    paidPlan = (await db.plan.create({ data: { name: `${tag}-paid`, modules: ["WHATSAPP", "SUNAT"], maxUsers: 5, priceCents: 5000, billingPeriodDays: 30, storageMb: 100, automationsEnabled: true } })).id;
    paid2 = (await db.plan.create({ data: { name: `${tag}-paid2`, modules: ["PLAYGROUND"], maxUsers: 5, priceCents: 9000, billingPeriodDays: 30 } })).id;
    SA = (await mkUser(null, "SUPERADMIN")).id;
    A = await mkTenant("A", freePlan); B = await mkTenant("B", freePlan);
    uA = (await mkUser(A, "OWNER")).id; uB = (await mkUser(B, "OWNER")).id;
  }, 120000);
  afterAll(wipe, 180000);

  it("usuarios: el tope del plan se respeta aunque las altas sean simultáneas", async () => {
    await mkUser(A, "RECEPTION");                                   // A: 2 activos, tope 3
    const mk = (n: number) => createUserWithinLimit(A, { name: `n${n}`, email: email("w"), role: "RECEPTION", passwordHash: "x" });
    const r = await Promise.allSettled([mk(1), mk(2), mk(3), mk(4)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of r) if (x.status === "rejected") expect(String(x.reason.message)).toMatch(/límite de 3 usuarios activos/);
    expect(await db.user.count({ where: { tenantId: A, isActive: true } })).toBe(3);
    await expect(createUserWithinLimit(A, { name: "x", email: email("w"), role: "ADMIN", passwordHash: "x" })).rejects.toThrow(/límite/);
    // correo repetido (incluso de otro establecimiento) y otro tenant no afectado
    const dup = (await db.user.findFirstOrThrow({ where: { tenantId: B } })).email;
    await expect(createUserWithinLimit(B, { name: "x", email: dup, role: "ADMIN", passwordHash: "x" })).rejects.toThrow(/ya está registrado/);
    await createUserWithinLimit(B, { name: "ok", email: email("w"), role: "ADMIN", passwordHash: "x" });
  }, 180000);

  it("usuarios: reactivar también cuenta contra el tope; desactivar siempre se permite", async () => {
    const staff = await db.user.findMany({ where: { tenantId: A, role: "RECEPTION", isActive: true } });
    expect(await setUserActiveWithinLimit(A, staff[0]!.id, false)).toBe(true);
    await createUserWithinLimit(A, { name: "reemplazo", email: email("w"), role: "RECEPTION", passwordHash: "x" });   // vuelve a 3 activos
    await expect(setUserActiveWithinLimit(A, staff[0]!.id, true)).rejects.toThrow(/límite/);
    expect((await db.user.findFirstOrThrow({ where: { id: staff[0]!.id } })).isActive).toBe(false);
    expect(await setUserActiveWithinLimit(A, uA, false)).toBe(false);                    // el OWNER no se puede desactivar
    expect(await setUserActiveWithinLimit(A, (await db.user.findFirstOrThrow({ where: { tenantId: B, role: "ADMIN" } })).id, false)).toBe(false); // ni usuarios de otro tenant
  }, 120000);

  it("funciones por plan: módulos y banderas, con error controlado", async () => {
    await expect(assertFeature(A, "WHATSAPP")).rejects.toThrow(/WhatsApp no está incluido/);
    await expect(assertFeature(A, "SUNAT")).rejects.toThrow(/SUNAT/);
    await expect(assertFeature(A, "REPORTS")).rejects.toThrow(/Reportes/);
    await expect(assertFeature(A, "AUTOMATIONS")).rejects.toThrow(/Automatizaciones/);     // sin módulo WhatsApp
    const P = await mkTenant("P", paidPlan, { modules: ["WHATSAPP", "SUNAT"] });
    for (const f of ["WHATSAPP", "SUNAT", "REPORTS", "AUTOMATIONS"] as const) await assertFeature(P, f);
    expect(await hasFeature(P, "SUNAT")).toBe(true); expect(await hasFeature(A, "SUNAT")).toBe(false); expect(await hasFeature("no-existe", "SUNAT")).toBe(false);
    // facturación electrónica: aunque haya configuración activa, sin el módulo no se emite
    await db.sunatConfig.create({ data: { tenantId: A, provider: "MOCK", rucEmisor: "20131312955", razonSocial: "X SAC", enabled: true, lastTestOk: true, updatedById: uA } });
    await expect(createDocumentForSale({ tenantId: A, userId: uA, saleId: "x", kind: "BOLETA", customer: {} })).rejects.toThrow(/SUNAT no está incluido/);
  }, 120000);

  it("resumen de uso y almacenamiento: el tope del plan impide guardar archivos", async () => {
    const u = await usageSummary(A);
    expect(u).toMatchObject({ users: { used: 3, max: 3 }, bot: { used: 0, max: 2 }, planName: `${tag}-free` });
    expect(u.features).toMatchObject({ WHATSAPP: false, SUNAT: false, REPORTS: false });
    expect(await canStore(A, 1)).toBe(false);                                            // plan con 0 MB
    expect(await canStore(await mkTenant("S", paidPlan), 1000)).toBe(true);
    // el archivo del PSE no se guarda si no cabe (queda solo el enlace)
    const sess = await db.cashRegisterSession.create({ data: { tenantId: A, openedById: uA, openingBalanceCents: 0 } });
    const sale = await db.sale.create({ data: { tenantId: A, cashRegisterSessionId: sess.id, kind: "POS", totalCents: 118, cashCents: 118, createdById: uA } });
    const d = await db.sunatDocument.create({ data: { tenantId: A, kind: "BOLETA", status: "ACCEPTED", acceptedAt: new Date(), provider: "MOCK", serie: "B001", number: 1, issueDate: "2026-11-18", saleId: sale.id, customerDocType: "NONE", customerName: "X", igvBp: 1800, taxableCents: 100, igvCents: 18, totalCents: 118, items: [], createdById: uA, pdfUrl: "http://127.0.0.1:9/a.pdf" } });
    const fake = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    await fetchArtifacts(A, d.id, fake);
    expect((await db.sunatDocument.findFirstOrThrow({ where: { id: d.id } })).pdf).toBeNull();
  }, 180000);

  it("cambio de plan: crea la suscripción de prueba, anula cobros del plan anterior y cancela al volver a gratis", async () => {
    await expect(changeTenantPlan({ actorId: uA, tenantId: A, planId: paidPlan })).rejects.toBeInstanceOf(ForbiddenError);
    const t0 = new Date();
    await changeTenantPlan({ actorId: SA, tenantId: B, planId: paidPlan, now: t0 });
    const s = await sub(B);
    expect(s.status).toBe("ACTIVE"); expect(s.currentPeriodEnd.getTime() - s.currentPeriodStart.getTime()).toBe(TRIAL_DAYS * 86_400_000);
    expect(await tn(B)).toMatchObject({ planId: paidPlan, modules: ["WHATSAPP", "SUNAT"] });
    const inv = (await createRenewalInvoice(B, addDays(s.currentPeriodEnd, -3)))!;
    expect(inv.created).toBe(true);
    await changeTenantPlan({ actorId: SA, tenantId: B, planId: paid2 });                    // otro precio: el cobro pendiente ya no vale
    expect((await invs(B))[0]!.status).toBe("VOID");
    expect((await sub(B)).planId).toBe(paid2);
    await changeTenantPlan({ actorId: SA, tenantId: B, planId: freePlan });
    expect(await sub(B)).toMatchObject({ status: "CANCELED" });
    expect(await runBillingCycle(addDays(new Date(), 400))).toBeTruthy();
    expect((await tn(B)).status).toBe("ACTIVE");                                            // cancelada: el ciclo nunca la bloquea
  }, 240000);

  it("ciclo de cobro: cobro 7 días antes (idempotente y sin carreras), vencida, gracia y bloqueo por impago", async () => {
    const T = await mkTenant("T", freePlan);
    const owner = (await mkUser(T, "OWNER")).id, rec = (await mkUser(T, "RECEPTION")).id;
    await changeTenantPlan({ actorId: SA, tenantId: T, planId: paidPlan });
    const end = (await sub(T)).currentPeriodEnd;
    const r0 = await runBillingCycle(addDays(end, -10));
    expect(await invs(T)).toHaveLength(0); expect(r0.checked).toBeGreaterThanOrEqual(1);
    const [c1, c2] = await Promise.all([runBillingCycle(addDays(end, -6)), runBillingCycle(addDays(end, -6))]);
    expect(c1.invoicesCreated + c2.invoicesCreated).toBeGreaterThanOrEqual(1);
    const list = await invs(T);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amountCents: 5000, status: "PENDING", planId: paidPlan });
    expect(list[0]!.periodStart.getTime()).toBe(end.getTime());
    await runBillingCycle(addDays(end, -5)); expect(await invs(T)).toHaveLength(1);        // idempotente
    // vence sin pagar
    await runBillingCycle(addDays(end, 1));
    expect(await sub(T)).toMatchObject({ status: "PAST_DUE" });
    expect((await sub(T)).graceUntil!.getTime()).toBe(addDays(end, GRACE_DAYS).getTime());
    expect((await tn(T)).status).toBe("ACTIVE");                                           // aún en gracia
    const svRec = (await db.user.findFirstOrThrow({ where: { id: rec } })).sessionVersion, svOwn = (await db.user.findFirstOrThrow({ where: { id: owner } })).sessionVersion;
    const r = await runBillingCycle(addDays(end, GRACE_DAYS + 1));
    expect(r.suspended).toBeGreaterThanOrEqual(1);
    expect(await tn(T)).toMatchObject({ status: "SUSPENDED", suspensionSource: "BILLING", suspendedReason: "Suscripción vencida (impago)" });
    expect((await db.user.findFirstOrThrow({ where: { id: rec } })).sessionVersion).toBe(svRec + 1);     // sesiones cerradas...
    expect((await db.user.findFirstOrThrow({ where: { id: owner } })).sessionVersion).toBe(svOwn);        // ...menos el propietario (va a pagar)
    const again = await runBillingCycle(addDays(end, GRACE_DAYS + 2));
    expect((await db.auditLog.count({ where: { tenantId: T, action: "billing.suspended" } }))).toBe(1); expect(again.checked).toBeGreaterThan(0);
    // pagar reactiva y extiende desde hoy
    const pay = await settleInvoice({ invoiceId: list[0]!.id, method: "YAPE", provider: "MANUAL", providerRef: "op-1", now: addDays(end, GRACE_DAYS + 3) });
    expect(pay.settled).toBe(true);
    expect(await tn(T)).toMatchObject({ status: "ACTIVE", suspendedAt: null, suspensionSource: null });
    const s = await sub(T);
    expect(s.status).toBe("ACTIVE"); expect(s.graceUntil).toBeNull();
    expect(s.currentPeriodEnd.getTime()).toBe(addDays(end, GRACE_DAYS + 3 + 30).getTime());
    expect((await settleInvoice({ invoiceId: list[0]!.id, method: "YAPE", provider: "MANUAL" })).settled).toBe(false);   // no se paga dos veces
  }, 300000);

  it("pago a tiempo suma al periodo vigente; una suspensión manual del SuperAdmin NO se levanta con un pago", async () => {
    const T = await mkTenant("M", freePlan); await mkUser(T, "OWNER");
    await changeTenantPlan({ actorId: SA, tenantId: T, planId: paidPlan });
    const end = (await sub(T)).currentPeriodEnd;
    const inv = (await createRenewalInvoice(T, addDays(end, -2)))!;
    await suspendTenant({ actorId: SA, tenantId: T, reason: "Suspensión manual por incidente" });
    expect(await tn(T)).toMatchObject({ status: "SUSPENDED", suspensionSource: "ADMIN" });
    await settleInvoice({ invoiceId: inv.id, method: "CARD", provider: "MERCADOPAGO", now: addDays(end, -1) });
    expect((await tn(T)).status).toBe("SUSPENDED");                                       // sigue suspendido
    expect((await sub(T)).currentPeriodEnd.getTime()).toBe(addDays(end, 30).getTime());   // pero el periodo sí se extendió
    await reactivateTenant({ actorId: SA, tenantId: T });
    expect(await tn(T)).toMatchObject({ status: "ACTIVE", suspensionSource: null });
    // un bloqueo por impago reactivado a mano recibe gracia nueva
    const T2 = await mkTenant("G", freePlan); await mkUser(T2, "OWNER");
    await changeTenantPlan({ actorId: SA, tenantId: T2, planId: paidPlan });
    const e2 = (await sub(T2)).currentPeriodEnd;
    await runBillingCycle(addDays(e2, GRACE_DAYS + 1));
    expect((await tn(T2)).suspensionSource).toBe("BILLING");
    await reactivateTenant({ actorId: SA, tenantId: T2 });
    expect((await sub(T2)).graceUntil!.getTime()).toBeGreaterThan(Date.now() + (GRACE_DAYS - 1) * 86_400_000);
  }, 300000);

  it("avisos de la pasarela: idempotentes, con monto verificado y sin doble extensión", async () => {
    const T = await mkTenant("W", freePlan); await mkUser(T, "OWNER");
    await changeTenantPlan({ actorId: SA, tenantId: T, planId: paidPlan });
    const end = (await sub(T)).currentPeriodEnd;
    const inv = (await createRenewalInvoice(T, addDays(end, -1)))!;
    expect((await applyPaymentEvent("MOCK", ev("no-existe"))).status).toBe("ERROR");
    expect(await applyPaymentEvent("MOCK", ev(inv.id, { amountCents: 4999 }))).toMatchObject({ status: "ERROR", detail: expect.stringMatching(/no coincide/) });
    expect(await applyPaymentEvent("MOCK", ev(inv.id, { currency: "USD" }))).toMatchObject({ status: "ERROR" });
    expect(await applyPaymentEvent("MOCK", ev(inv.id, { status: "PENDING" }))).toMatchObject({ status: "IGNORED" });
    expect(await applyPaymentEvent("MOCK", ev(inv.id, { status: "REJECTED" }))).toMatchObject({ status: "IGNORED" });
    expect((await invs(T))[0]!.status).toBe("PENDING");                                   // nada de lo anterior cobró
    const same = ev(inv.id);
    const res = await Promise.all([1, 2, 3, 4, 5].map(() => applyPaymentEvent("MOCK", same)));
    expect(res.map((x) => x.status).sort()).toEqual(["APPLIED", "DUPLICATE", "DUPLICATE", "DUPLICATE", "DUPLICATE"]);
    expect(await invs(T)).toMatchObject([{ status: "PAID", method: "CARD", provider: "MOCK" }]);
    expect((await sub(T)).currentPeriodEnd.getTime()).toBe(addDays(end, 30).getTime());   // extendido UNA vez
    expect((await applyPaymentEvent("MOCK", ev(inv.id))).status).toBe("IGNORED");          // otro evento sobre un cobro ya pagado
    expect(await db.paymentEvent.count({ where: { eventId: same.eventId } })).toBe(1);
  }, 300000);

  it("pago manual (Yape/Plin/transferencia): el propietario reporta, solo el SuperAdmin confirma o rechaza", async () => {
    const T = await mkTenant("Y", freePlan); const owner = (await mkUser(T, "OWNER")).id; const other = await mkTenant("Z", freePlan);
    await changeTenantPlan({ actorId: SA, tenantId: T, planId: paidPlan });
    const inv = (await createRenewalInvoice(T, addDays((await sub(T)).currentPeriodEnd, -1)))!;
    await expect(reportManualPayment({ tenantId: T, userId: owner, invoiceId: inv.id, method: "BITCOIN", ref: "12345" })).rejects.toThrow(/Medio/);
    await expect(reportManualPayment({ tenantId: T, userId: owner, invoiceId: inv.id, method: "YAPE", ref: "1" })).rejects.toThrow(/operación/);
    await expect(reportManualPayment({ tenantId: other, userId: owner, invoiceId: inv.id, method: "YAPE", ref: "12345" })).rejects.toThrow(/no encontrado/);   // cobro de otro establecimiento
    await expect(confirmReportedPayment({ actorId: SA, invoiceId: inv.id })).rejects.toThrow(/no ha reportado/);
    await reportManualPayment({ tenantId: T, userId: owner, invoiceId: inv.id, method: "YAPE", ref: "OP-998877" });
    expect(await invs(T)).toMatchObject([{ status: "PENDING", reportedMethod: "YAPE", reportedRef: "OP-998877" }]);
    const endBefore = (await sub(T)).currentPeriodEnd;
    await expect(confirmReportedPayment({ actorId: owner, invoiceId: inv.id })).rejects.toBeInstanceOf(ForbiddenError);   // el propietario no se autoconfirma
    await expect(rejectReportedPayment({ actorId: owner, invoiceId: inv.id, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(registerPayment({ actorId: owner, invoiceId: inv.id, method: "YAPE", ref: "abc" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await sub(T)).currentPeriodEnd.getTime()).toBe(endBefore.getTime());
    await rejectReportedPayment({ actorId: SA, invoiceId: inv.id, reason: "No encontramos la operación" });
    expect(await invs(T)).toMatchObject([{ status: "PENDING", reportedAt: null, rejectedReason: "No encontramos la operación" }]);
    await reportManualPayment({ tenantId: T, userId: owner, invoiceId: inv.id, method: "PLIN", ref: "OP-1122" });
    await confirmReportedPayment({ actorId: SA, invoiceId: inv.id });
    expect(await invs(T)).toMatchObject([{ status: "PAID", method: "PLIN", provider: "MANUAL", providerRef: "OP-1122", paidById: SA, rejectedReason: null }]);
    expect((await sub(T)).currentPeriodEnd.getTime()).toBe(addDays(endBefore, 30).getTime());
    await expect(reportManualPayment({ tenantId: T, userId: owner, invoiceId: inv.id, method: "YAPE", ref: "12345" })).rejects.toThrow(/ya pagado/);
    // registro directo por el SuperAdmin
    const inv2 = (await createRenewalInvoice(T, addDays((await sub(T)).currentPeriodEnd, -1)))!;
    await registerPayment({ actorId: SA, invoiceId: inv2.id, method: "TRANSFER", ref: "TRX-5566" });
    expect((await invs(T)).map((i) => i.status)).toEqual(["PAID", "PAID"]);
  }, 300000);

  it("pago en línea: exige pasarela configurada y deja el cobro listo para el aviso", async () => {
    const T = await mkTenant("C", freePlan); await mkUser(T, "OWNER");
    await changeTenantPlan({ actorId: SA, tenantId: T, planId: paidPlan });
    const inv = (await createRenewalInvoice(T, addDays((await sub(T)).currentPeriodEnd, -1)))!;
    await expect(startCheckout({ tenantId: T, invoiceId: inv.id, gateway: null })).rejects.toThrow(/no está disponible/);
    const gw: PaymentGateway = { provider: "MERCADOPAGO", createCheckout: async (i) => ({ url: `https://www.mercadopago.com.pe/pay/${i.id}`, providerRef: "pref-9" }), parseWebhook: async () => null };
    expect((await startCheckout({ tenantId: T, invoiceId: inv.id, gateway: gw })).url).toContain(inv.id);
    expect(await invs(T)).toMatchObject([{ provider: "MERCADOPAGO", providerRef: "pref-9", status: "PENDING" }]);
    await expect(startCheckout({ tenantId: A, invoiceId: inv.id, gateway: gw })).rejects.toThrow(/no encontrado/);   // cobro de otro establecimiento
  }, 240000);

  it("ruta del webhook: firma obligatoria, idempotente y sin exponer detalles", async () => {
    const T = await mkTenant("H", freePlan); await mkUser(T, "OWNER");
    await changeTenantPlan({ actorId: SA, tenantId: T, planId: paidPlan });
    const end = (await sub(T)).currentPeriodEnd;
    const inv = (await createRenewalInvoice(T, addDays(end, -1)))!;
    const prev = { PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER, NODE_ENV: process.env.NODE_ENV };
    process.env.PAYMENT_PROVIDER = "MOCK";
    try {
      const body = JSON.stringify({ eventId: `${tag}-wh1`, invoiceId: inv.id, amountCents: 5000, status: "APPROVED", method: "CARD" });
      const call = (provider: string, raw: string, sig?: string) => webhook(new Request("http://localhost/api/webhooks/payments/x", { method: "POST", body: raw, headers: sig ? { "x-mock-signature": sig } : {} }), { params: Promise.resolve({ provider }) });
      expect((await call("mock", body)).status).toBe(401);                                         // sin firma
      expect((await call("mock", body, "00".repeat(32))).status).toBe(401);                        // firma falsa
      expect((await call("mock", body.replace("5000", "1"), signMockEvent(body))).status).toBe(401); // cuerpo alterado
      expect((await call("mercadopago", body, signMockEvent(body))).status).toBe(404);              // proveedor distinto del configurado
      expect((await invs(T))[0]!.status).toBe("PENDING");
      const ok = await call("mock", body, signMockEvent(body));
      expect([ok.status, await ok.json()]).toEqual([200, { status: "APPLIED" }]);
      const rep = await call("mock", body, signMockEvent(body));
      expect([rep.status, await rep.json()]).toEqual([200, { status: "DUPLICATE" }]);
      expect((await sub(T)).currentPeriodEnd.getTime()).toBe(addDays(end, 30).getTime());
      const ign = await call("mock", JSON.stringify({ nada: true }), signMockEvent(JSON.stringify({ nada: true })));
      expect(await ign.json()).toEqual({ status: "ignored" });
      process.env.PAYMENT_PROVIDER = "NONE";
      expect((await call("mock", body, signMockEvent(body))).status).toBe(404);                    // sin pasarela configurada no hay webhook
    } finally { process.env.PAYMENT_PROVIDER = prev.PAYMENT_PROVIDER; }
  }, 300000);

  it("cron de cobro: exige CRON_SECRET", async () => {
    expect((await cronBilling(new Request("http://localhost/api/cron/billing"))).status).toBe(401);
    expect((await cronBilling(new Request("http://localhost/api/cron/billing", { headers: { authorization: "Bearer mal" } }))).status).toBe(401);
    const ok = await cronBilling(new Request("http://localhost/api/cron/billing", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect(ok.status).toBe(200); expect(await ok.json()).toMatchObject({ checked: expect.any(Number), invoicesCreated: expect.any(Number) });
  }, 120000);

  it("restricciones de la base de datos de suscripciones", async () => {
    const T = await mkTenant("D", freePlan);
    const now = new Date();
    await expect(db.subscription.create({ data: { tenantId: T, planId: paidPlan, currentPeriodStart: now, currentPeriodEnd: now } })).rejects.toThrow();           // fin > inicio
    await expect(db.subscription.create({ data: { tenantId: T, planId: paidPlan, status: "CANCELED", currentPeriodStart: now, currentPeriodEnd: addDays(now, 1) } })).rejects.toThrow(); // cancelada exige fecha
    const base = { tenantId: T, planId: paidPlan, planName: "x", amountCents: 100, periodStart: now, periodEnd: addDays(now, 30), dueDate: now };
    await expect(db.saasInvoice.create({ data: { ...base, amountCents: 0 } })).rejects.toThrow();
    await expect(db.saasInvoice.create({ data: { ...base, status: "PAID" } })).rejects.toThrow();                                                                   // pagado exige fecha
    await expect(db.saasInvoice.create({ data: { ...base, method: "BITCOIN" } })).rejects.toThrow();
    await db.saasInvoice.create({ data: base });
    await expect(db.saasInvoice.create({ data: base })).rejects.toThrow();                                                                                           // un cobro por periodo
    await expect(db.$executeRaw`UPDATE "Plan" SET "priceCents" = -1 WHERE "id" = ${paidPlan}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "Tenant" SET "suspensionSource" = 'OTRO' WHERE "id" = ${T}`).rejects.toThrow();
    await expect(db.paymentEvent.create({ data: { provider: "MOCK", eventId: `${tag}-dup`, status: "RECEIVED" } }).then(() => db.paymentEvent.create({ data: { provider: "MOCK", eventId: `${tag}-dup`, status: "RECEIVED" } }))).rejects.toThrow();
  }, 180000);
});
