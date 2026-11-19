import "server-only";
import { db } from "@/lib/db";
import { BillingError, retryBusy, type Tx } from "@/lib/billing/service";
import { audit } from "@/lib/audit";
import { limaDate } from "@/lib/utils/date";
import { ForbiddenError } from "@/lib/rbac";
import { GRACE_DAYS, TRIAL_DAYS, addDays, decideCycle, paidPeriodEnd, periodDays } from "./pure";
import { getGateway, type ParsedPayment, type PaymentGateway, type PaymentMethodKind } from "./gateway";

/**
 * Suscripciones del SaaS. Reglas:
 *  - Un cobro por periodo (único tenantId+periodStart). Pagar = voltear PENDING→PAID con una sentencia condicionada: un aviso repetido
 *    o dos pagos simultáneos no extienden dos veces el periodo.
 *  - Los avisos de la pasarela se registran en PaymentEvent (único provider+eventId) y su MONTO se compara con el del cobro.
 *  - El bloqueo por impago (suspensionSource = BILLING) deja entrar solo al PROPIETARIO a /billing; un pago reactiva solo ese tipo de suspensión
 *    (una suspensión manual del SuperAdmin nunca se levanta sola).
 *  - Todo el ciclo (crear cobros, vencer, bloquear) es idempotente: el cron puede ejecutarse varias veces.
 */
const TX = { maxWait: 10_000, timeout: 30_000 } as const;
const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(e instanceof Error ? e.message : String(e));
const text = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function assertSuper(actorId: string) {
  const u = await db.user.findFirst({ where: { id: actorId } });
  if (!u || !u.isActive || u.role !== "SUPERADMIN" || u.tenantId !== null) throw new ForbiddenError("Solo el SuperAdmin puede realizar esta operación");
}

// ---------- Suscripción según el plan ----------
type PlanRow = { id: string; priceCents: number; isDemo: boolean };
/** Sincroniza la suscripción con el plan (dentro de la transacción del cambio de plan). Plan de pago → suscripción; gratuito/demo → cancelada. */
export async function syncSubscription(tx: Tx, tenantId: string, plan: PlanRow, now: Date) {
  const sub = await tx.subscription.findFirst({ where: { tenantId } });
  const paid = plan.priceCents > 0 && !plan.isDemo;
  if (paid) {
    if (!sub) await tx.subscription.create({ data: { tenantId, planId: plan.id, status: "ACTIVE", currentPeriodStart: now, currentPeriodEnd: addDays(now, TRIAL_DAYS) } });
    else await tx.subscription.updateMany({ where: { tenantId }, data: { planId: plan.id, ...(sub.status === "CANCELED" ? { status: "ACTIVE", canceledAt: null, currentPeriodStart: now, currentPeriodEnd: addDays(now, TRIAL_DAYS), graceUntil: null } : {}) } });
    // El precio cambió: los cobros pendientes del plan anterior ya no valen (el ciclo genera el nuevo)
    await tx.saasInvoice.updateMany({ where: { tenantId, status: "PENDING", planId: { not: plan.id } }, data: { status: "VOID" } });
  } else if (sub && sub.status !== "CANCELED") {
    await tx.subscription.updateMany({ where: { tenantId }, data: { status: "CANCELED", canceledAt: now, graceUntil: null } });
    await tx.saasInvoice.updateMany({ where: { tenantId, status: "PENDING" }, data: { status: "VOID" } });
  }
}

// ---------- Cobros ----------
/** Genera el cobro del siguiente periodo (idempotente por periodo). */
export async function createRenewalInvoice(tenantId: string, now = new Date()): Promise<{ id: string; created: boolean } | null> {
  const sub = await db.subscription.findFirst({ where: { tenantId } });
  if (!sub || sub.status === "CANCELED") return null;
  const plan = await db.plan.findFirst({ where: { id: sub.planId } });
  if (!plan || plan.priceCents <= 0 || plan.isDemo) return null;
  const start = sub.currentPeriodEnd, end = addDays(start, plan.billingPeriodDays);
  const prev = await db.saasInvoice.findFirst({ where: { tenantId, periodStart: start }, select: { id: true } });
  if (prev) return { id: prev.id, created: false };
  try {
    const inv = await retryBusy(() => db.saasInvoice.create({ data: { tenantId, planId: plan.id, planName: plan.name, amountCents: plan.priceCents, periodStart: start, periodEnd: end, dueDate: start } , select: { id: true } }));
    return { id: inv.id, created: true };
  } catch (e) {
    if (isUnique(e)) { const again = await db.saasInvoice.findFirst({ where: { tenantId, periodStart: start }, select: { id: true } }); if (again) return { id: again.id, created: false }; }
    throw e;
  }
}

export type Settle = { invoiceId: string; method: PaymentMethodKind; provider: string; providerRef?: string | null; paidById?: string | null; now?: Date };
/**
 * Marca el cobro como pagado y extiende la suscripción (UNA transacción). Si el acceso estaba bloqueado por impago, lo reactiva.
 * Devuelve false si el cobro ya no estaba pendiente (pago repetido o cobro anulado).
 */
export async function settleInvoice(i: Settle): Promise<{ settled: boolean; tenantId: string | null }> {
  const now = i.now ?? new Date();
  const inv = await db.saasInvoice.findFirst({ where: { id: i.invoiceId } });
  if (!inv) return { settled: false, tenantId: null };
  const tenantId = inv.tenantId;
  const settled = await retryBusy(() => db.$transaction(async (tx: Tx) => {
    const flip = await tx.saasInvoice.updateMany({
      where: { id: inv.id, tenantId, status: "PENDING" },
      data: { status: "PAID", paidAt: now, method: i.method, provider: i.provider, providerRef: i.providerRef ?? null, paidById: i.paidById ?? null, reportedAt: null, reportedMethod: null, reportedRef: null, rejectedReason: null },
    });
    if (flip.count !== 1) return false;
    const sub = await tx.subscription.findFirst({ where: { tenantId } });
    const days = periodDays(inv.periodStart, inv.periodEnd);
    if (sub) {
      const end = paidPeriodEnd(sub.currentPeriodEnd, days, now);
      const start = sub.currentPeriodEnd.getTime() > now.getTime() ? sub.currentPeriodEnd : now;
      await tx.subscription.updateMany({ where: { tenantId }, data: { status: "ACTIVE", canceledAt: null, graceUntil: null, currentPeriodStart: start, currentPeriodEnd: end, planId: inv.planId } });
    }
    // Reactiva SOLO el bloqueo por impago
    await tx.tenant.updateMany({ where: { id: tenantId, status: "SUSPENDED", suspensionSource: "BILLING" }, data: { status: "ACTIVE", suspendedAt: null, suspendedReason: null, suspensionSource: null } });
    return true;
  }, TX));
  if (settled) await audit({ tenantId, actorId: i.paidById ?? null, action: "billing.invoice.paid", entity: "SaasInvoice", entityId: inv.id, metadata: { method: i.method, provider: i.provider, amountCents: inv.amountCents } });
  return { settled, tenantId };
}

// ---------- Avisos de la pasarela ----------
export type EventResult = { status: "APPLIED" | "DUPLICATE" | "IGNORED" | "ERROR"; detail?: string };
/** Procesa un aviso YA autenticado (firma verificada por la pasarela). Idempotente por (provider, eventId). */
export async function applyPaymentEvent(provider: string, ev: ParsedPayment, now = new Date()): Promise<EventResult> {
  try {
    await db.paymentEvent.create({ data: { provider, eventId: ev.eventId, invoiceId: ev.invoiceId, amountCents: ev.amountCents, status: "RECEIVED" } });
  } catch (e) {
    if (isUnique(e)) return { status: "DUPLICATE" };
    throw e;
  }
  const done = (status: "APPLIED" | "IGNORED" | "ERROR", detail: string | null, tenantId?: string | null) =>
    db.paymentEvent.updateMany({ where: { provider, eventId: ev.eventId }, data: { status, detail, tenantId: tenantId ?? null, processedAt: new Date() } }).then(() => ({ status, ...(detail ? { detail } : {}) }) as EventResult);
  const inv = await db.saasInvoice.findFirst({ where: { id: ev.invoiceId } });
  if (!inv) return done("ERROR", "Cobro no encontrado");
  if (ev.status !== "APPROVED") return done("IGNORED", `Estado ${ev.status}: no se aplica`, inv.tenantId);
  if (ev.currency !== "PEN") return done("ERROR", `Moneda ${ev.currency} no admitida`, inv.tenantId);
  if (ev.amountCents !== inv.amountCents) return done("ERROR", `El monto pagado (${ev.amountCents}) no coincide con el cobro (${inv.amountCents}): revisar manualmente`, inv.tenantId);
  if (inv.status !== "PENDING") return done("IGNORED", `El cobro ya está ${inv.status}`, inv.tenantId);
  const r = await settleInvoice({ invoiceId: inv.id, method: ev.method, provider, providerRef: ev.providerRef, now });
  return done(r.settled ? "APPLIED" : "IGNORED", r.settled ? null : "El cobro ya no estaba pendiente", inv.tenantId);
}

export async function startCheckout(i: { tenantId: string; invoiceId: string; gateway?: PaymentGateway | null }): Promise<{ url: string }> {
  const gw = i.gateway === undefined ? getGateway() : i.gateway;
  if (!gw) throw new BillingError("El pago en línea no está disponible: usa Yape, Plin o transferencia y reporta tu pago");
  const inv = await db.saasInvoice.findFirst({ where: { id: i.invoiceId, tenantId: i.tenantId, status: "PENDING" } });
  if (!inv) throw new BillingError("Cobro no encontrado o ya pagado");
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  const r = await gw.createCheckout({ id: inv.id, amountCents: inv.amountCents, description: `Suscripción ${inv.planName}` }, { notificationUrl: `${base}/api/webhooks/payments/${gw.provider.toLowerCase()}`, backUrl: `${base}/billing` });
  await retryBusy(() => db.saasInvoice.updateMany({ where: { id: inv.id, tenantId: i.tenantId, status: "PENDING" }, data: { provider: gw.provider, providerRef: r.providerRef } }));
  return { url: r.url };
}

// ---------- Pago manual (Yape / Plin / transferencia) ----------
/** El propietario informa su pago; no extiende nada hasta que el SuperAdmin lo confirma. */
export async function reportManualPayment(i: { tenantId: string; userId: string; invoiceId: string; method: string; ref: string }) {
  if (!["YAPE", "PLIN", "TRANSFER"].includes(i.method)) throw new BillingError("Medio de pago inválido");
  const ref = text(i.ref, 80);
  if (ref.length < 3) throw new BillingError("Indica el número de operación o referencia del pago");
  const r = await retryBusy(() => db.saasInvoice.updateMany({
    where: { id: i.invoiceId, tenantId: i.tenantId, status: "PENDING" },
    data: { reportedMethod: i.method, reportedRef: ref, reportedAt: new Date(), rejectedReason: null },
  }));
  if (r.count !== 1) throw new BillingError("Cobro no encontrado o ya pagado");
  await audit({ tenantId: i.tenantId, actorId: i.userId, action: "billing.payment.reported", entity: "SaasInvoice", entityId: i.invoiceId, metadata: { method: i.method } });
}

export async function confirmReportedPayment(i: { actorId: string; invoiceId: string }) {
  await assertSuper(i.actorId);
  const inv = await db.saasInvoice.findFirst({ where: { id: i.invoiceId } });
  if (!inv || inv.status !== "PENDING") throw new BillingError("Cobro no encontrado o ya pagado");
  if (!inv.reportedMethod || !inv.reportedAt) throw new BillingError("El establecimiento no ha reportado un pago para este cobro");
  const r = await settleInvoice({ invoiceId: inv.id, method: inv.reportedMethod as PaymentMethodKind, provider: "MANUAL", providerRef: inv.reportedRef, paidById: i.actorId });
  if (!r.settled) throw new BillingError("El cobro ya no estaba pendiente");
}

export async function rejectReportedPayment(i: { actorId: string; invoiceId: string; reason: string }) {
  await assertSuper(i.actorId);
  const reason = text(i.reason, 200);
  if (reason.length < 3) throw new BillingError("Indica el motivo del rechazo");
  const inv = await db.saasInvoice.findFirst({ where: { id: i.invoiceId } });
  const r = inv ? await retryBusy(() => db.saasInvoice.updateMany({ where: { id: inv.id, status: "PENDING", reportedAt: { not: null } }, data: { reportedMethod: null, reportedRef: null, reportedAt: null, rejectedReason: reason } })) : { count: 0 };
  if (!inv || r.count !== 1) throw new BillingError("No hay un pago reportado pendiente en este cobro");
  await audit({ tenantId: inv.tenantId, actorId: i.actorId, action: "superadmin.billing.payment_rejected", entity: "SaasInvoice", entityId: inv.id, metadata: { reason } });
}

/** Registro directo de un pago recibido por fuera (el SuperAdmin ya verificó el dinero). */
export async function registerPayment(i: { actorId: string; invoiceId: string; method: PaymentMethodKind; ref: string }) {
  await assertSuper(i.actorId);
  const ref = text(i.ref, 80);
  if (ref.length < 3) throw new BillingError("Indica la referencia del pago");
  const r = await settleInvoice({ invoiceId: i.invoiceId, method: i.method, provider: "MANUAL", providerRef: ref, paidById: i.actorId });
  if (!r.settled) throw new BillingError("Cobro no encontrado o ya pagado");
}

// ---------- Ciclo de cobro (cron diario, idempotente) ----------
export type CycleResult = { checked: number; invoicesCreated: number; pastDue: number; suspended: number };
export async function runBillingCycle(now = new Date()): Promise<CycleResult> {
  const subs = await db.subscription.findMany({ where: { status: { not: "CANCELED" } }, take: 2000 });
  const res: CycleResult = { checked: subs.length, invoicesCreated: 0, pastDue: 0, suspended: 0 };
  for (const s of subs) {
    try {
      const tenant = await db.tenant.findFirst({ where: { id: s.tenantId }, include: { plan: true } });
      if (!tenant || tenant.status === "DEMO" || tenant.plan.isDemo || tenant.plan.priceCents <= 0) continue;
      const pending = await db.saasInvoice.findFirst({ where: { tenantId: s.tenantId, status: "PENDING", periodStart: s.currentPeriodEnd }, select: { id: true } });
      const actions = decideCycle(s, !!pending, now);
      if (actions.includes("CREATE_INVOICE") && (await createRenewalInvoice(s.tenantId, now))?.created) res.invoicesCreated++;
      if (actions.includes("MARK_PAST_DUE")) {
        const r = await retryBusy(() => db.subscription.updateMany({ where: { tenantId: s.tenantId, status: "ACTIVE", currentPeriodEnd: s.currentPeriodEnd }, data: { status: "PAST_DUE", graceUntil: addDays(s.currentPeriodEnd, GRACE_DAYS) } }));
        if (r.count === 1) { res.pastDue++; await audit({ tenantId: s.tenantId, actorId: null, action: "billing.past_due", entity: "Subscription", entityId: s.id }); }
      }
      if (actions.includes("SUSPEND") && tenant.status !== "SUSPENDED") {
        const did = await retryBusy(() => db.$transaction(async (tx: Tx) => {
          const t = await tx.tenant.updateMany({ where: { id: s.tenantId, status: { not: "SUSPENDED" } }, data: { status: "SUSPENDED", suspendedAt: now, suspendedReason: "Suscripción vencida (impago)", suspensionSource: "BILLING" } });
          if (t.count !== 1) return false;
          // Cierra las sesiones de todos menos el propietario, que entra a /billing para pagar
          await tx.user.updateMany({ where: { tenantId: s.tenantId, role: { not: "OWNER" } }, data: { sessionVersion: { increment: 1 } } });
          return true;
        }, TX));
        if (did) { res.suspended++; await audit({ tenantId: s.tenantId, actorId: null, action: "billing.suspended", entity: "Tenant", entityId: s.tenantId, metadata: { day: limaDate(now) } }); }
      }
    } catch (e) { console.error("[billing] error en el ciclo de un establecimiento", s.tenantId, e instanceof Error ? e.message : e); }
  }
  return res;
}

// ---------- Vistas ----------
export async function getBillingView(tenantId: string) {
  const [tenant, sub, invoices] = await Promise.all([
    db.tenant.findFirst({ where: { id: tenantId }, include: { plan: true } }),
    db.subscription.findFirst({ where: { tenantId } }),
    db.saasInvoice.findMany({ where: { tenantId }, orderBy: { periodStart: "desc" }, take: 12 }),
  ]);
  return { tenant, sub, invoices };
}
