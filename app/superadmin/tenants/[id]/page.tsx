import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/lib/rbac";
import { getTenantDetail, listPlans } from "@/lib/superadmin/service";
import { changePlanAction, confirmPaymentAction, reactivateTenantAction, registerPaymentAction, rejectPaymentAction, setDemoExpiryAction, suspendTenantAction } from "@/actions/superadmin";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { ResetOwnerForm } from "./reset-form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const when = (d: Date | null) => (d ? d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }) : "—");

export default async function TenantDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ e?: string; ok?: string }> }) {
  const admin = await requireSuperAdmin();
  const { id } = await params, q = await searchParams;
  const [d, plans] = await Promise.all([getTenantDetail(admin.id, id), listPlans(admin.id)]);
  if (!d) notFound();
  const t = d.tenant;
  const expired = t.status === "DEMO" && t.demoExpiresAt && t.demoExpiresAt < new Date();
  const modules = Array.isArray(t.modules) ? (t.modules as string[]).join(", ") : "—";
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <p className="text-sm"><Link href="/superadmin/dashboard" className="underline">← Panel</Link></p>
      <h1 className="text-2xl font-bold">{t.name}</h1>
      <ErrorBanner message={q.e} /><OkBanner message={q.ok} />
      <section className="space-y-1 rounded-lg border border-border p-3 text-sm">
        <p>Estado: <b>{expired ? "Demo vencida" : t.status === "SUSPENDED" ? "Suspendido" : t.status === "DEMO" ? "Demo" : "Activo"}</b> · Tipo: {t.businessType} · Alta: {when(t.createdAt)}</p>
        <p>Plan: <b>{t.plan.name}</b> · {t.plan.maxUsers} usuarios · {t.plan.storageMb} MB · bot {t.plan.botMonthlyReplies}/mes · Módulos: {modules}</p>
        {t.demoExpiresAt && <p>Vence la demo: {when(t.demoExpiresAt)}</p>}
        {t.suspendedAt && <p className="text-red-300">Suspendido el {when(t.suspendedAt)}: {t.suspendedReason}</p>}
        <p>Uso: {d.counts.sales} ventas · {d.counts.documents} comprobantes · {d.tokensMonth} tokens IA este mes · {(d.storageBytes / 1024 / 1024).toFixed(2)} MB · {d.counts.children} menores y {d.counts.guardians} apoderados (solo conteos)</p>
      </section>
      <section className="rounded-lg border border-border p-3 text-sm">
        <h2 className="mb-1 font-semibold">Usuarios</h2>
        {d.users.map((u) => <p key={u.id} className="flex flex-wrap justify-between gap-2"><span>{u.name} · {u.email}</span><span className="text-muted-foreground">{u.role}{u.isActive ? "" : " · inactivo"}{u.mustChangePassword ? " · cambio de contraseña pendiente" : ""}</span></p>)}
      </section>

      <section className="flex flex-wrap gap-3 rounded-lg border border-border p-3 text-sm">
        {t.status === "SUSPENDED" ? (
          <form action={reactivateTenantAction}><input type="hidden" name="tenantId" value={t.id} /><Button size="sm">Reactivar acceso</Button></form>
        ) : (
          <form action={suspendTenantAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="tenantId" value={t.id} />
            <Input name="reason" required minLength={5} maxLength={300} placeholder="Motivo de la suspensión" className="w-72" />
            <Button size="sm" variant="destructive">Suspender acceso</Button>
          </form>
        )}
        <form action={changePlanAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="tenantId" value={t.id} />
          <select name="planId" required defaultValue="" className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="" disabled>Cambiar de plan…</option>
            {plans.filter((p) => p.id !== t.planId).map((p) => <option key={p.id} value={p.id}>{p.name}{p.isDemo ? " (demo)" : ""}</option>)}
          </select>
          <Button size="sm" variant="outline">Cambiar plan</Button>
        </form>
        {(t.plan.isDemo || t.demoExpiresAt) && (
          <form action={setDemoExpiryAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="tenantId" value={t.id} />
            <input type="date" name="day" required className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
            <Button size="sm" variant="outline">Cambiar vencimiento</Button>
          </form>
        )}
      </section>
      <section className="space-y-2 rounded-lg border border-border p-3 text-sm">
        <h2 className="font-semibold">Suscripción y cobros</h2>
        {d.subscription ? <p>Estado: <b>{d.subscription.status === "PAST_DUE" ? "Vencida" : d.subscription.status === "CANCELED" ? "Cancelada" : "Al día"}</b> · Periodo hasta {when(d.subscription.currentPeriodEnd)}{d.subscription.graceUntil ? ` · gracia hasta ${when(d.subscription.graceUntil)}` : ""}{t.suspensionSource ? ` · suspensión: ${t.suspensionSource === "BILLING" ? "por impago" : "manual"}` : ""}</p> : <p className="text-muted-foreground">Sin suscripción (plan gratuito o demo).</p>}
        {d.invoices.map((i) => (
          <div key={i.id} className="space-y-1 rounded-md border border-border p-2">
            <p className="flex flex-wrap justify-between gap-2"><span>{i.planName} · {when(i.periodStart)} → {when(i.periodEnd)}</span><span><b>S/ {(i.amountCents / 100).toFixed(2)}</b> · {i.status === "PAID" ? `Pagado ${i.method ?? ""} (${i.provider ?? ""})` : i.status === "VOID" ? "Anulado" : "Pendiente"}</span></p>
            {i.status === "PENDING" && i.reportedAt && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-amber-300">Reportado: {i.reportedMethod} · ref. {i.reportedRef}</span>
                <form action={confirmPaymentAction}><input type="hidden" name="tenantId" value={t.id} /><input type="hidden" name="invoiceId" value={i.id} /><Button size="sm">Confirmar pago</Button></form>
                <form action={rejectPaymentAction} className="flex items-center gap-1"><input type="hidden" name="tenantId" value={t.id} /><input type="hidden" name="invoiceId" value={i.id} /><Input name="reason" required minLength={3} maxLength={200} placeholder="Motivo" className="w-48" /><Button size="sm" variant="destructive">Rechazar</Button></form>
              </div>
            )}
            {i.status === "PENDING" && (
              <form action={registerPaymentAction} className="flex flex-wrap items-center gap-1">
                <input type="hidden" name="tenantId" value={t.id} /><input type="hidden" name="invoiceId" value={i.id} />
                <select name="method" className="h-9 rounded-md border border-input bg-background px-2 text-sm"><option value="YAPE">Yape</option><option value="PLIN">Plin</option><option value="TRANSFER">Transferencia</option><option value="CARD">Tarjeta</option><option value="OTHER">Otro</option></select>
                <Input name="ref" required minLength={3} maxLength={80} placeholder="Referencia" className="w-40" /><Button size="sm" variant="outline">Registrar pago recibido</Button>
              </form>
            )}
          </div>
        ))}
      </section>
      <ResetOwnerForm tenantId={t.id} />
      <section className="rounded-lg border border-border p-3 text-sm">
        <h2 className="mb-1 font-semibold">Historial de acciones de SuperAdmin</h2>
        {d.events.map((e) => <p key={e.id} className="flex justify-between gap-2"><span>{e.action}</span><span className="text-muted-foreground">{when(e.createdAt)}</span></p>)}
        {d.events.length === 0 && <p className="text-muted-foreground">Sin acciones registradas.</p>}
      </section>
    </div>
  );
}
