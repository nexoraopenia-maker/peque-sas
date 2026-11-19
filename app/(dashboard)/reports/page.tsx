import Link from "next/link";
import { z } from "zod";
import { requirePermission, requireFeature } from "@/lib/rbac";
import { getReport } from "@/lib/reports/service";
import { addDaysStr, formatMargin, GRANULARITIES, GRANULARITY_LABEL, mondayOf, validateRange } from "@/lib/reports/pure";
import { CATEGORY_LABEL, SOURCE_LABEL, type ExpenseCategory, type ExpenseSource } from "@/lib/expenses/pure";
import { formatSoles } from "@/lib/billing/money";
import { limaDate } from "@/lib/utils/date";
import { ErrorBanner } from "@/components/dashboard/banner";

export const dynamic = "force-dynamic";
const KIND = { PLAYGROUND: "Ludoteca", PREPAID_PACKAGE: "Cuponera", DAYCARE_FEE: "Mensualidad", POS: "Venta de productos", RESERVATION_PAYMENT: "Reservas" } as Record<string, string>;
const q = z.object({ from: z.iso.date().optional().catch(undefined), to: z.iso.date().optional().catch(undefined), g: z.enum(GRANULARITIES).optional().catch(undefined) });

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenantId } = await requirePermission("reports:view");
  await requireFeature("REPORTS");
  const f = q.parse(await searchParams);
  const today = limaDate();
  const from = f.from ?? `${today.slice(0, 7)}-01`, to = f.to ?? today, g = f.g ?? "DAY";
  const bad = validateRange(from, to);
  const r = bad ? null : await getReport(tenantId, from, to, g);
  const presets: [string, string, string, typeof g][] = [
    ["Hoy", today, today, "DAY"], ["Esta semana", mondayOf(today), today, "DAY"], ["Este mes", `${today.slice(0, 7)}-01`, today, "WEEK"], ["Últimos 90 días", addDaysStr(today, -89), today, "MONTH"],
  ];
  const input = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  const qs = `from=${from}&to=${to}&g=${g}`;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Reportes financieros</h1>
      <ErrorBanner message={bad ?? undefined} />
      <form method="GET" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">Desde <input type="date" name="from" defaultValue={from} className={input} /></label>
        <label className="text-sm">Hasta <input type="date" name="to" defaultValue={to} className={input} /></label>
        <label className="text-sm">Desglose <select name="g" defaultValue={g} className={input}>{GRANULARITIES.map((x) => <option key={x} value={x}>{GRANULARITY_LABEL[x]}</option>)}</select></label>
        <button className="h-9 rounded-md border border-input px-3 text-sm">Ver</button>
      </form>
      <p className="flex flex-wrap gap-3 text-sm">{presets.map(([l, a, b, x]) => <Link key={l} className="underline" href={`/reports?from=${a}&to=${b}&g=${x}`}>{l}</Link>)}</p>
      {r && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[["Ingresos cobrados", formatSoles(r.income.totalCents), `${r.income.salesCount} ventas`], ["Egresos", formatSoles(r.expenses.totalCents), `${r.expenses.count} gastos`],
              ["Utilidad", formatSoles(r.profitCents), r.profitCents < 0 ? "Pérdida en el periodo" : "Ingresos − egresos"], ["Margen", formatMargin(r.marginBp), "Utilidad / ingresos"]].map(([k, v, s]) => (
              <div key={k} className="rounded-lg border border-border bg-card p-3"><p className="text-xs text-muted-foreground">{k}</p><p className={"text-lg font-bold" + (k === "Utilidad" && r.profitCents < 0 ? " text-red-400" : "")}>{v}</p><p className="text-xs text-muted-foreground">{s}</p></div>
            ))}
          </section>
          <p className="flex flex-wrap gap-4 text-sm">
            <Link className="underline" href={`/reports/export?type=summary&format=csv&${qs}`}>Descargar CSV</Link>
            <Link className="underline" href={`/reports/export?type=summary&format=pdf&${qs}`}>Descargar PDF</Link>
            <Link className="underline" href={`/reports/export?type=expenses&format=csv&from=${from}&to=${to}`}>Gastos CSV</Link>
            <Link className="underline" href={`/reports/export?type=expenses&format=pdf&from=${from}&to=${to}`}>Gastos PDF</Link>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground"><tr><th className="p-2">Periodo</th><th className="text-right">Ingresos</th><th className="text-right">Egresos</th><th className="text-right">Utilidad</th><th className="text-right">Margen</th></tr></thead>
              <tbody>{r.periods.map((p) => (
                <tr key={p.key} className="border-t border-border"><td className="p-2">{p.label}</td><td className="text-right">{formatSoles(p.incomeCents)}</td><td className="text-right">{formatSoles(p.expenseCents)}</td>
                  <td className={"text-right font-medium" + (p.profitCents < 0 ? " text-red-400" : "")}>{formatSoles(p.profitCents)}</td><td className="text-right">{formatMargin(p.marginBp)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <section className="grid gap-4 md:grid-cols-3 text-sm">
            <div><h2 className="mb-1 font-semibold">Ingresos por tipo</h2>{Object.entries(r.income.byKind).map(([k, v]) => <p key={k} className="flex justify-between"><span>{KIND[k] ?? k}</span><span>{formatSoles(v)}</span></p>)}
              <p className="mt-2 flex justify-between text-muted-foreground"><span>Descuentos otorgados (ya descontados)</span><span>{formatSoles(r.income.discountsCents)}</span></p></div>
            <div><h2 className="mb-1 font-semibold">Ingresos por medio</h2>
              {([["Efectivo", r.income.byMethod.cash], ["Yape/Plin", r.income.byMethod.yapePlin], ["Tarjeta", r.income.byMethod.card], ["Transferencia", r.income.byMethod.transfer]] as [string, number][]).map(([k, v]) => <p key={k} className="flex justify-between"><span>{k}</span><span>{formatSoles(v)}</span></p>)}</div>
            <div><h2 className="mb-1 font-semibold">Egresos por categoría</h2>
              {(Object.keys(CATEGORY_LABEL) as ExpenseCategory[]).map((c) => <p key={c} className="flex justify-between"><span>{CATEGORY_LABEL[c]}</span><span>{formatSoles(r.expenses.byCategory[c])}</span></p>)}
              <h2 className="mb-1 mt-3 font-semibold">Egresos por origen</h2>
              {(Object.keys(SOURCE_LABEL) as ExpenseSource[]).map((s) => <p key={s} className="flex justify-between"><span>{SOURCE_LABEL[s]}</span><span>{formatSoles(r.expenses.bySource[s])}</span></p>)}</div>
          </section>
          <p className="text-xs text-muted-foreground">Base caja: ingresos = ventas cobradas (netas de cupones y puntos); egresos = gastos vigentes (no anulados). Mensualidades pendientes de cobro: {formatSoles(r.receivableCents)} (no incluidas en ingresos).</p>
        </>
      )}
    </div>
  );
}
