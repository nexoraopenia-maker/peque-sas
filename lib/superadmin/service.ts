import "server-only";
import { db } from "@/lib/db";
import { BillingError, retryBusy, type Tx } from "@/lib/billing/service";
import { ForbiddenError } from "@/lib/rbac";
import { generateTempPassword, hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { limaDate } from "@/lib/utils/date";
import { checkExpiry, endOfLimaDay, planSchema } from "./pure";
import { syncSubscription } from "@/lib/subscriptions/service";
import { GRACE_DAYS, addDays } from "@/lib/subscriptions/pure";

/**
 * Operaciones globales del SuperAdmin. Reglas:
 *  - TODA función verifica de nuevo en la base de datos que el actor sea un SUPERADMIN activo y global (defensa en profundidad:
 *    aunque una página o acción olvidara su guardia, un usuario de establecimiento no puede ejecutar nada de aquí).
 *  - Toda operación sobre un establecimiento queda auditada con tenantId del establecimiento afectado y acción `superadmin.*`.
 *  - Solo se exponen agregados y metadatos de cuenta: nunca nombres ni datos de menores o familias.
 */
const TX = { maxWait: 10_000, timeout: 60_000 } as const;

export async function assertSuperAdmin(actorId: string) {
  const u = await db.user.findFirst({ where: { id: actorId } });
  if (!u || !u.isActive || u.role !== "SUPERADMIN" || u.tenantId !== null) throw new ForbiddenError("Solo el SuperAdmin puede realizar esta operación");
  return u;
}

const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000-05:00`);
const num = (v: unknown) => Number(v ?? 0);

export type TenantRow = {
  id: string; name: string; businessType: string; status: "ACTIVE" | "SUSPENDED" | "DEMO"; demoExpired: boolean; planName: string; planIsDemo: boolean;
  createdAt: Date; demoExpiresAt: Date | null; suspendedAt: Date | null; users: number; maxUsers: number;
  salesMonth: number; documentsMonth: number; tokensMonth: number; storageBytes: number; storageMb: number;
};

/** Listado global con consumo del mes (agregados por establecimiento). */
export async function listTenants(actorId: string, now = new Date()): Promise<TenantRow[]> {
  await assertSuperAdmin(actorId);
  const month = limaDate(now).slice(0, 7), from = monthStart(month);
  const [tenants, users, sales, docs, tokens, storage] = await Promise.all([
    db.tenant.findMany({ orderBy: { createdAt: "desc" }, take: 500, include: { plan: true } }),
    db.user.groupBy({ by: ["tenantId"], where: { isActive: true, tenantId: { not: null } }, _count: true }),
    db.sale.groupBy({ by: ["tenantId"], where: { createdAt: { gte: from } }, _count: true }),
    db.sunatDocument.groupBy({ by: ["tenantId"], where: { createdAt: { gte: from } }, _count: true }),
    db.botUsage.groupBy({ by: ["tenantId"], where: { month }, _sum: { inputTokens: true, outputTokens: true } }),
    db.$queryRaw<{ tenantId: string; bytes: bigint | number }[]>`SELECT "tenantId", COALESCE(SUM(COALESCE(LENGTH("pdf"),0) + COALESCE(LENGTH("xml"),0)),0) AS bytes FROM "SunatDocument" GROUP BY "tenantId"`,
  ]);
  const by = <T extends { tenantId: string | null }>(l: T[]) => new Map(l.map((x) => [x.tenantId, x]));
  const U = by(users), S = by(sales), D = by(docs), K = by(tokens), B = new Map(storage.map((x) => [x.tenantId, num(x.bytes)]));
  return tenants.map((t) => ({
    id: t.id, name: t.name, businessType: t.businessType, status: t.status, planName: t.plan.name, planIsDemo: t.plan.isDemo, createdAt: t.createdAt,
    demoExpiresAt: t.demoExpiresAt, suspendedAt: t.suspendedAt, demoExpired: t.status === "DEMO" && !!t.demoExpiresAt && t.demoExpiresAt < now,
    users: U.get(t.id)?._count ?? 0, maxUsers: t.plan.maxUsers, salesMonth: S.get(t.id)?._count ?? 0, documentsMonth: D.get(t.id)?._count ?? 0,
    tokensMonth: num(K.get(t.id)?._sum.inputTokens) + num(K.get(t.id)?._sum.outputTokens), storageBytes: B.get(t.id) ?? 0, storageMb: t.plan.storageMb,
  }));
}

export type GlobalMetrics = {
  month: string; tenants: { total: number; active: number; demo: number; demoExpired: number; suspended: number };
  tokens: { inputMonth: number; outputMonth: number; inputTotal: number; outputTotal: number; repliesMonth: number };
  transactions: { salesMonth: number; salesTotal: number; documentsMonth: number; documentsTotal: number; documentsAcceptedTotal: number; documentsPending: number };
  storage: { totalBytes: number; tenantsOverLimit: number };
  billing: { mrrCents: number; activeSubscriptions: number; pastDue: number; reportedPayments: number; pendingInvoicesCents: number };
};

export async function getMetrics(actorId: string, now = new Date()): Promise<GlobalMetrics> {
  await assertSuperAdmin(actorId);
  const month = limaDate(now).slice(0, 7), from = monthStart(month);
  const [byStatus, expired, tokM, tokT, replies, salesM, salesT, docM, docT, docOk, docPend, storage, plans, subs, reported, pendingInv] = await Promise.all([
    db.tenant.groupBy({ by: ["status"], _count: true }),
    db.tenant.count({ where: { status: "DEMO", demoExpiresAt: { lt: now } } }),
    db.botUsage.aggregate({ where: { month }, _sum: { inputTokens: true, outputTokens: true } }),
    db.botUsage.aggregate({ _sum: { inputTokens: true, outputTokens: true } }),
    db.botUsage.count({ where: { month } }),
    db.sale.count({ where: { createdAt: { gte: from } } }), db.sale.count(),
    db.sunatDocument.count({ where: { createdAt: { gte: from } } }), db.sunatDocument.count(),
    db.sunatDocument.count({ where: { status: "ACCEPTED" } }), db.sunatDocument.count({ where: { status: { in: ["PENDING", "FAILED"] } } }),
    db.$queryRaw<{ tenantId: string; bytes: bigint | number }[]>`SELECT "tenantId", COALESCE(SUM(COALESCE(LENGTH("pdf"),0) + COALESCE(LENGTH("xml"),0)),0) AS bytes FROM "SunatDocument" GROUP BY "tenantId"`,
    db.tenant.findMany({ select: { id: true, plan: { select: { storageMb: true } } } }),
    db.subscription.findMany({ where: { status: { not: "CANCELED" } }, select: { status: true, planId: true } }),
    db.saasInvoice.count({ where: { status: "PENDING", reportedAt: { not: null } } }),
    db.saasInvoice.aggregate({ where: { status: "PENDING" }, _sum: { amountCents: true } }),
  ]);
  const prices = new Map((await db.plan.findMany({ where: { id: { in: [...new Set(subs.map((x) => x.planId))] } }, select: { id: true, priceCents: true, billingPeriodDays: true } })).map((p) => [p.id, p]));
  const st = (s: string) => byStatus.find((x) => x.status === s)?._count ?? 0;
  const limit = new Map(plans.map((t) => [t.id, t.plan.storageMb * 1024 * 1024]));
  return {
    month,
    tenants: { total: byStatus.reduce((n, x) => n + x._count, 0), active: st("ACTIVE"), demo: st("DEMO") - expired, demoExpired: expired, suspended: st("SUSPENDED") },
    tokens: { inputMonth: num(tokM._sum.inputTokens), outputMonth: num(tokM._sum.outputTokens), inputTotal: num(tokT._sum.inputTokens), outputTotal: num(tokT._sum.outputTokens), repliesMonth: replies },
    transactions: { salesMonth: salesM, salesTotal: salesT, documentsMonth: docM, documentsTotal: docT, documentsAcceptedTotal: docOk, documentsPending: docPend },
    storage: { totalBytes: storage.reduce((n, x) => n + num(x.bytes), 0), tenantsOverLimit: storage.filter((x) => num(x.bytes) > (limit.get(x.tenantId) ?? Infinity)).length },
    // Ingreso mensual recurrente: precio normalizado a 30 días de cada suscripción vigente o vencida sin cancelar
    billing: { mrrCents: subs.reduce((n, x) => { const p = prices.get(x.planId); return n + (p ? Math.round((p.priceCents * 30) / p.billingPeriodDays) : 0); }, 0), activeSubscriptions: subs.filter((x) => x.status === "ACTIVE").length, pastDue: subs.filter((x) => x.status === "PAST_DUE").length, reportedPayments: reported, pendingInvoicesCents: num(pendingInv._sum.amountCents) },
  };
}

export const listPlans = async (actorId: string) => { await assertSuperAdmin(actorId); return db.plan.findMany({ orderBy: [{ isDemo: "asc" }, { name: "asc" }], include: { _count: { select: { tenants: true } } } }); };

export async function getTenantDetail(actorId: string, tenantId: string) {
  await assertSuperAdmin(actorId);
  const t = await db.tenant.findFirst({ where: { id: tenantId }, include: { plan: true } });
  if (!t) return null;
  const month = limaDate().slice(0, 7);
  const [users, children, guardians, sales, docs, tokens, bytes, events, subscription, invoices] = await Promise.all([
    db.user.findMany({ where: { tenantId }, select: { id: true, name: true, email: true, role: true, isActive: true, mustChangePassword: true, lockedUntil: true }, orderBy: { role: "asc" } }),
    db.child.count({ where: { tenantId } }), db.guardian.count({ where: { tenantId } }), db.sale.count({ where: { tenantId } }), db.sunatDocument.count({ where: { tenantId } }),
    db.botUsage.aggregate({ where: { tenantId, month }, _sum: { inputTokens: true, outputTokens: true } }),
    db.$queryRaw<{ bytes: bigint | number | null }[]>`SELECT COALESCE(SUM(COALESCE(LENGTH("pdf"),0) + COALESCE(LENGTH("xml"),0)),0) AS bytes FROM "SunatDocument" WHERE "tenantId" = ${tenantId}`,
    db.auditLog.findMany({ where: { tenantId, action: { startsWith: "superadmin." } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, action: true, createdAt: true, actorId: true, metadata: true } }),
    db.subscription.findFirst({ where: { tenantId } }),
    db.saasInvoice.findMany({ where: { tenantId }, orderBy: { periodStart: "desc" }, take: 12 }),
  ]);
  return { tenant: t, users, counts: { children, guardians, sales, documents: docs }, tokensMonth: num(tokens._sum.inputTokens) + num(tokens._sum.outputTokens), storageBytes: num(bytes[0]?.bytes), events, subscription, invoices };
}

const now0 = () => new Date();

export async function suspendTenant(i: { actorId: string; tenantId: string; reason: string }) {
  await assertSuperAdmin(i.actorId);
  const reason = i.reason.trim();
  if (reason.length < 5 || reason.length > 300) throw new BillingError("Indica el motivo de la suspensión (5 a 300 caracteres)");
  await retryBusy(() => db.$transaction(async (tx: Tx) => {
    const t = await tx.tenant.findFirst({ where: { id: i.tenantId } });
    if (!t) throw new BillingError("Establecimiento no encontrado");
    if (t.status === "SUSPENDED") throw new BillingError("El establecimiento ya está suspendido");
    await tx.tenant.updateMany({ where: { id: t.id }, data: { status: "SUSPENDED", suspendedAt: now0(), suspendedReason: reason, suspensionSource: "ADMIN" } });
    // Cierra de inmediato las sesiones de todos sus usuarios
    await tx.user.updateMany({ where: { tenantId: t.id }, data: { sessionVersion: { increment: 1 } } });
  }, TX));
  await audit({ tenantId: i.tenantId, actorId: i.actorId, action: "superadmin.tenant.suspend", entity: "Tenant", entityId: i.tenantId, metadata: { reason } });
}

export async function reactivateTenant(i: { actorId: string; tenantId: string }) {
  await assertSuperAdmin(i.actorId);
  const to = await retryBusy(() => db.$transaction(async (tx: Tx) => {
    const t = await tx.tenant.findFirst({ where: { id: i.tenantId }, include: { plan: true } });
    if (!t) throw new BillingError("Establecimiento no encontrado");
    if (t.status !== "SUSPENDED") throw new BillingError("El establecimiento no está suspendido");
    const status = t.plan.isDemo || t.demoExpiresAt ? "DEMO" : "ACTIVE";
    await tx.tenant.updateMany({ where: { id: t.id }, data: { status, suspendedAt: null, suspendedReason: null, suspensionSource: null } });
    // Reactivar un bloqueo por impago sin pago: se concede una gracia nueva para que el ciclo no lo bloquee de inmediato
    if (t.suspensionSource === "BILLING") await tx.subscription.updateMany({ where: { tenantId: t.id, status: "PAST_DUE" }, data: { graceUntil: addDays(now0(), GRACE_DAYS) } });
    return status;
  }, TX));
  await audit({ tenantId: i.tenantId, actorId: i.actorId, action: "superadmin.tenant.reactivate", entity: "Tenant", entityId: i.tenantId, metadata: { status: to } });
}

/** Cambia el plan. No borra datos: solo cambian límites y módulos habilitados. */
export async function changeTenantPlan(i: { actorId: string; tenantId: string; planId: string; now?: Date }) {
  await assertSuperAdmin(i.actorId);
  const now = i.now ?? now0();
  const info = await retryBusy(() => db.$transaction(async (tx: Tx) => {
    const [t, plan] = await Promise.all([tx.tenant.findFirst({ where: { id: i.tenantId } }), tx.plan.findFirst({ where: { id: i.planId } })]);
    if (!t) throw new BillingError("Establecimiento no encontrado");
    if (!plan) throw new BillingError("Plan no encontrado");
    if (t.planId === plan.id) throw new BillingError("El establecimiento ya tiene ese plan");
    const active = await tx.user.count({ where: { tenantId: t.id, isActive: true } });
    if (active > plan.maxUsers) throw new BillingError(`El plan admite ${plan.maxUsers} usuarios y el establecimiento tiene ${active} activos: desactiva usuarios antes de bajar de plan`);
    const data: Record<string, unknown> = { planId: plan.id, modules: plan.modules as never };
    if (t.status !== "SUSPENDED") {
      if (plan.isDemo) { data.status = "DEMO"; data.demoExpiresAt = t.demoExpiresAt ?? endOfLimaDay(limaDate(new Date(now.getTime() + 14 * 86_400_000))); }
      else { data.status = "ACTIVE"; data.demoExpiresAt = null; }
    }
    await tx.tenant.updateMany({ where: { id: t.id }, data });
    await syncSubscription(tx, t.id, plan, now);
    return { from: t.planId, to: plan.id };
  }, TX));
  await audit({ tenantId: i.tenantId, actorId: i.actorId, action: "superadmin.tenant.plan", entity: "Tenant", entityId: i.tenantId, metadata: info });
}

export async function setDemoExpiry(i: { actorId: string; tenantId: string; day: string; now?: Date }) {
  await assertSuperAdmin(i.actorId);
  const bad = checkExpiry(i.day, i.now); if (bad) throw new BillingError(bad);
  const t = await db.tenant.findFirst({ where: { id: i.tenantId }, include: { plan: true } });
  if (!t) throw new BillingError("Establecimiento no encontrado");
  if (!t.plan.isDemo && !t.demoExpiresAt) throw new BillingError("Solo los establecimientos demo tienen vencimiento");
  await retryBusy(() => db.tenant.updateMany({ where: { id: t.id }, data: { demoExpiresAt: endOfLimaDay(i.day) } }));
  await audit({ tenantId: i.tenantId, actorId: i.actorId, action: "superadmin.tenant.demo_expiry", entity: "Tenant", entityId: i.tenantId, metadata: { day: i.day } });
}

/** Restablecimiento seguro: contraseña temporal nueva (se muestra una vez), cambio obligatorio y cierre de sesiones del propietario. */
export async function resetOwnerPassword(i: { actorId: string; tenantId: string }): Promise<{ email: string; tempPassword: string }> {
  await assertSuperAdmin(i.actorId);
  const owner = await db.user.findFirst({ where: { tenantId: i.tenantId, role: "OWNER", isActive: true }, orderBy: { createdAt: "asc" } });
  if (!owner) throw new BillingError("El establecimiento no tiene un propietario activo");
  const tempPassword = generateTempPassword();
  await retryBusy(async () => db.user.updateMany({ where: { id: owner.id, tenantId: i.tenantId }, data: { passwordHash: await hashPassword(tempPassword), mustChangePassword: true, sessionVersion: { increment: 1 }, failedLogins: 0, lockedUntil: null } }));
  await audit({ tenantId: i.tenantId, actorId: i.actorId, action: "superadmin.owner.password_reset", entity: "User", entityId: owner.id });
  return { email: owner.email, tempPassword };
}

export async function createPlan(i: { actorId: string; raw: unknown }) {
  await assertSuperAdmin(i.actorId);
  const p = planSchema.safeParse(i.raw);
  if (!p.success) throw new BillingError(p.error.issues[0]?.message ?? "Revisa los datos del plan");
  if (await db.plan.findFirst({ where: { name: p.data.name } })) throw new BillingError("Ya existe un plan con ese nombre");
  const plan = await retryBusy(() => db.plan.create({ data: { ...p.data, modules: p.data.modules, whatsappEnabled: p.data.modules.includes("WHATSAPP") } }));
  await audit({ tenantId: null, actorId: i.actorId, action: "superadmin.plan.create", entity: "Plan", entityId: plan.id, metadata: { name: plan.name } });
  return plan.id;
}
