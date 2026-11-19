import { requireBillingUser } from "@/lib/rbac";
import { getBillingView } from "@/lib/subscriptions/service";
import { getGateway } from "@/lib/subscriptions/gateway";
import { dueInfo } from "@/lib/subscriptions/pure";
import { usageSummary } from "@/lib/plans/limits";
import { FEATURE_LABEL, pctUsed } from "@/lib/plans/pure";
import { formatSoles } from "@/lib/billing/money";
import { reportPaymentAction, startCheckoutAction } from "@/actions/billing";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const day = (d: Date | null) => (d ? d.toLocaleDateString("es-PE", { timeZone: "America/Lima" }) : "—");
const ST = { PENDING: "Pendiente", PAID: "Pagado", VOID: "Anulado" } as const;
const mb = (b: number) => (b / 1024 / 1024).toFixed(1);

function Bar({ label, used, max, fmt = String }: { label: string; used: number; max: number; fmt?: (n: number) => string }) {
  const p = pctUsed(used, max);
  return (
    <div className="space-y-1 text-sm">
      <p className="flex justify-between"><span>{label}</span><span className={p >= 100 ? "text-red-300" : p >= 80 ? "text-amber-300" : "text-muted-foreground"}>{fmt(used)} / {fmt(max)}</span></p>
      <div className="h-2 rounded bg-muted"><div className={`h-2 rounded ${p >= 100 ? "bg-red-400" : p >= 80 ? "bg-amber-400" : "bg-green-400"}`} style={{ width: `${p}%` }} /></div>
    </div>
  );
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { tenantId, locked } = await requireBillingUser();
  const q = await searchParams;
  const [v, usage] = await Promise.all([getBillingView(tenantId), usageSummary(tenantId)]);
  const gw = getGateway();
  const due = dueInfo(v.sub, new Date());
  const instructions = process.env.BILLING_MANUAL_INSTRUCTIONS;
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Suscripción y uso del plan</h1>
      <ErrorBanner message={q.e} /><OkBanner message={q.ok} />
      {locked && <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">El acceso de tu establecimiento está bloqueado por falta de pago. Paga el cobro pendiente para reactivarlo; tus datos están a salvo.</p>}
      <section className="space-y-1 rounded-lg border border-border p-3 text-sm">
        <p>Plan: <b>{v.tenant?.plan.name}</b>{v.tenant && v.tenant.plan.priceCents > 0 ? ` · ${formatSoles(v.tenant.plan.priceCents)} cada ${v.tenant.plan.billingPeriodDays} días` : " · sin cobro"}</p>
        {v.sub ? (
          <p>Estado: <b>{due?.state === "PAST_DUE" ? "Vencida" : v.sub.status === "CANCELED" ? "Cancelada" : "Al día"}</b> · Vigente hasta {day(v.sub.currentPeriodEnd)}{v.sub.status === "PAST_DUE" && v.sub.graceUntil ? ` · bloqueo el ${day(v.sub.graceUntil)} si no se paga` : ""}</p>
        ) : <p className="text-muted-foreground">Tu plan no tiene cobros.</p>}
      </section>
      <section className="space-y-3 rounded-lg border border-border p-3">
        <h2 className="font-semibold">Uso de tu plan</h2>
        <Bar label="Usuarios activos" used={usage.users.used} max={usage.users.max} />
        <Bar label={`Respuestas del chatbot (${usage.bot.month})`} used={usage.bot.used} max={usage.bot.max} />
        <Bar label="Almacenamiento (MB)" used={usage.storage.usedBytes} max={usage.storage.maxBytes} fmt={(n) => mb(n)} />
        <p className="text-xs text-muted-foreground">Incluye: {(Object.keys(usage.features) as (keyof typeof usage.features)[]).filter((f) => usage.features[f]).map((f) => FEATURE_LABEL[f]).join(", ") || "funciones básicas"}.</p>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Cobros</h2>
        {v.invoices.length === 0 && <p className="text-sm text-muted-foreground">Aún no hay cobros.</p>}
        {v.invoices.map((i) => (
          <div key={i.id} className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p className="flex flex-wrap justify-between gap-2"><span>{i.planName} · {day(i.periodStart)} al {day(i.periodEnd)}</span><span><b>{formatSoles(i.amountCents)}</b> · {ST[i.status]}{i.paidAt ? ` el ${day(i.paidAt)}${i.method ? ` (${i.method})` : ""}` : ""}</span></p>
            {i.status === "PENDING" && (
              <div className="space-y-2">
                {i.rejectedReason && <p className="text-red-300">Tu pago reportado fue rechazado: {i.rejectedReason}</p>}
                {i.reportedAt && <p className="text-amber-300">Pago reportado ({i.reportedMethod}, ref. {i.reportedRef}): pendiente de confirmación.</p>}
                <div className="flex flex-wrap items-end gap-3">
                  {gw && <form action={startCheckoutAction}><input type="hidden" name="invoiceId" value={i.id} /><Button size="sm">Pagar en línea (tarjeta / Yape)</Button></form>}
                  <form action={reportPaymentAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="invoiceId" value={i.id} />
                    <select name="method" className={sel} aria-label="Medio de pago"><option value="YAPE">Yape</option><option value="PLIN">Plin</option><option value="TRANSFER">Transferencia</option></select>
                    <Input name="ref" required minLength={3} maxLength={80} placeholder="N.º de operación" className="w-44" />
                    <Button size="sm" variant="outline">Reportar pago</Button>
                  </form>
                </div>
                {instructions && <p className="text-xs text-muted-foreground">{instructions}</p>}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
