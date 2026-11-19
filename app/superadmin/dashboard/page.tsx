import Link from "next/link";
import { requireSuperAdmin } from "@/lib/rbac";
import { getMetrics, listPlans, listTenants } from "@/lib/superadmin/service";
import { MODULE_KEYS, MODULE_LABEL } from "@/lib/superadmin/pure";
import { createPlanAction } from "@/actions/superadmin";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const nf = new Intl.NumberFormat("es-PE");
const mb = (b: number) => (b / 1024 / 1024).toFixed(2);
const day = (d: Date | null) => (d ? d.toLocaleDateString("es-PE", { timeZone: "America/Lima" }) : "—");
const STATUS = { ACTIVE: "Activo", SUSPENDED: "Suspendido", DEMO: "Demo" } as const;

export default async function SuperAdminDashboard({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const admin = await requireSuperAdmin();
  const q = await searchParams;
  const [m, tenants, plans] = await Promise.all([getMetrics(admin.id), listTenants(admin.id), listPlans(admin.id)]);
  const cards: [string, string][] = [
    ["Establecimientos", `${m.tenants.total}`], ["Activos", `${m.tenants.active}`], ["Demos vigentes", `${m.tenants.demo}`], ["Demos vencidas", `${m.tenants.demoExpired}`], ["Suspendidos", `${m.tenants.suspended}`],
    [`Tokens IA (${m.month})`, nf.format(m.tokens.inputMonth + m.tokens.outputMonth)], ["Tokens IA (total)", nf.format(m.tokens.inputTotal + m.tokens.outputTotal)], ["Respuestas del bot (mes)", nf.format(m.tokens.repliesMonth)],
    ["Ventas (mes)", nf.format(m.transactions.salesMonth)], ["Ventas (total)", nf.format(m.transactions.salesTotal)],
    ["Comprobantes (mes)", nf.format(m.transactions.documentsMonth)], ["Comprobantes aceptados (total)", nf.format(m.transactions.documentsAcceptedTotal)], ["Comprobantes por reintentar", nf.format(m.transactions.documentsPending)],
    ["Almacenamiento usado", `${mb(m.storage.totalBytes)} MB`], ["Sobre su límite", `${m.storage.tenantsOverLimit}`],
    ["Ingreso mensual recurrente", `S/ ${(m.billing.mrrCents / 100).toFixed(2)}`], ["Suscripciones al día", `${m.billing.activeSubscriptions}`], ["Suscripciones vencidas", `${m.billing.pastDue}`], ["Pagos por confirmar", `${m.billing.reportedPayments}`], ["Cobros pendientes", `S/ ${(m.billing.pendingInvoicesCents / 100).toFixed(2)}`],
  ];
  const label = "block text-sm";
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Panel global</h1>
      <ErrorBanner message={q.e} /><OkBanner message={q.ok} />
      <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(([k, v]) => <div key={k} className="rounded-lg border border-border bg-card p-3"><p className="text-xs text-muted-foreground">{k}</p><p className="text-lg font-bold">{v}</p></div>)}
      </section>
      <p className="text-xs text-muted-foreground">Almacenamiento = PDF/XML de comprobantes guardados en la base (aún no hay otros archivos). Tokens = entrada + salida del chatbot. Estos paneles solo muestran agregados: nunca datos de menores ni de familias.</p>

      <section className="space-y-2">
        <div className="flex items-center justify-between"><h2 className="font-semibold">Establecimientos</h2><Link href="/superadmin/demos/new" className="text-sm underline">+ Nueva demo</Link></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="p-2">Nombre</th><th>Estado</th><th>Plan</th><th>Alta</th><th>Vence demo</th><th>Usuarios</th><th>Ventas mes</th><th>Tokens mes</th><th>Almac.</th></tr></thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="p-2"><Link href={`/superadmin/tenants/${t.id}`} className="underline">{t.name}</Link></td>
                  <td className={t.status === "SUSPENDED" || t.demoExpired ? "text-red-300" : t.status === "DEMO" ? "text-amber-300" : "text-green-300"}>{t.demoExpired ? "Demo vencida" : STATUS[t.status]}</td>
                  <td>{t.planName}</td><td>{day(t.createdAt)}</td><td>{day(t.demoExpiresAt)}</td><td>{t.users}/{t.maxUsers}</td><td>{nf.format(t.salesMonth)}</td><td>{nf.format(t.tokensMonth)}</td><td>{mb(t.storageBytes)}/{t.storageMb} MB</td>
                </tr>
              ))}
              {tenants.length === 0 && <tr><td className="p-2 text-muted-foreground" colSpan={9}>Sin establecimientos.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Planes</h2>
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {plans.map((p) => <li key={p.id} className="flex flex-wrap justify-between gap-2 p-2"><span>{p.name}{p.isDemo ? " (demo)" : ""}</span><span className="text-muted-foreground">{p.priceCents > 0 ? `S/ ${(p.priceCents / 100).toFixed(2)} / ${p.billingPeriodDays} días` : "gratis"} · {p.maxUsers} usuarios · {p.storageMb} MB · bot {p.botMonthlyReplies}/mes · {p._count.tenants} establecimientos</span></li>)}
          {plans.length === 0 && <li className="p-2 text-muted-foreground">Sin planes. Crea uno para poder asignarlo.</li>}
        </ul>
        <form action={createPlanAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-4">
          <h3 className="font-semibold sm:col-span-4">Nuevo plan</h3>
          <label className={label}>Nombre<Input name="name" required maxLength={60} /></label>
          <label className={label}>Usuarios máx.<Input name="maxUsers" type="number" min={1} defaultValue={5} required /></label>
          <label className={label}>Almacenamiento (MB)<Input name="storageMb" type="number" min={10} defaultValue={500} required /></label>
          <label className={label}>Respuestas del bot / mes<Input name="botMonthlyReplies" type="number" min={0} defaultValue={300} required /></label>
          <label className={label}>Precio (S/ por periodo, 0 = gratis)<Input name="price" inputMode="decimal" defaultValue="0" required /></label>
          <label className={label}>Días del periodo<Input name="billingPeriodDays" type="number" min={1} max={366} defaultValue={30} required /></label>
          <fieldset className="flex flex-wrap gap-3 text-sm sm:col-span-4">
            {MODULE_KEYS.map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" name="modules" value={k} defaultChecked={k === "PLAYGROUND"} /> {MODULE_LABEL[k]}</label>)}
            <label className="flex items-center gap-1"><input type="checkbox" name="automationsEnabled" /> Automatizaciones (chatbot)</label>
            <label className="flex items-center gap-1"><input type="checkbox" name="reportsEnabled" defaultChecked /> Reportes</label>
          </fieldset>
          <Button className="sm:col-span-4 sm:w-fit">Crear plan</Button>
        </form>
      </section>
    </div>
  );
}
