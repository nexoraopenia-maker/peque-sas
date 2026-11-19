import Link from "next/link";
import { z } from "zod";
import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { getOpenSession } from "@/lib/billing/service";
import { formatSoles } from "@/lib/billing/money";
import { getCashierLimit, listExpenses } from "@/lib/expenses/service";
import { CATEGORIES, CATEGORY_LABEL, SOURCE_LABEL } from "@/lib/expenses/pure";
import { setCashierLimitAction, voidExpenseAction } from "@/actions/expenses";
import { ExpenseForm } from "@/components/dashboard/expense-form";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { limaDate } from "@/lib/utils/date";

export const dynamic = "force-dynamic";
const q = z.object({
  e: z.string().max(300).optional(), ok: z.string().max(200).optional(),
  from: z.iso.date().optional().catch(undefined), to: z.iso.date().optional().catch(undefined), cat: z.enum(CATEGORIES).optional().catch(undefined),
});

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { user, tenantId } = await requirePermission("expenses:record");
  const f = q.parse(await searchParams);
  const canManage = hasPermission(user.role, "expenses:manage");
  const open = await getOpenSession(tenantId);
  const limit = await getCashierLimit(tenantId);
  const from = f.from ?? `${limaDate().slice(0, 7)}-01`, to = f.to ?? limaDate();
  // El cajero solo ve los gastos de su turno abierto; el propietario/administrador ve todo el periodo.
  const list = canManage ? await listExpenses(tenantId, { from, to, category: f.cat, includeVoided: true }) : open ? await listExpenses(tenantId, { sessionId: open.id, includeVoided: true }) : [];
  const total = list.filter((e) => !e.voidedAt).reduce((n, e) => n + e.amountCents, 0);
  const input = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Gastos</h1>
      <ErrorBanner message={f.e} /><OkBanner message={f.ok} />
      {!open && <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">No hay turno de caja abierto: no se pueden pagar gastos con el efectivo del cajón.{canManage ? " Los pagos por otros medios sí se pueden registrar." : ""}</p>}
      <ExpenseForm canManage={canManage} back="/expenses" limitCents={limit} />
      {hasPermission(user.role, "settings:manage") && (
        <form action={setCashierLimitAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3 text-sm">
          <label>Tope por gasto del cajero (S/)<input name="limit" inputMode="decimal" required defaultValue={(limit / 100).toFixed(2)} className={input + " ml-2 w-28"} /></label>
          <button className="h-9 rounded-md border border-input px-3">Guardar tope</button>
          <span className="text-xs text-muted-foreground">Los cajeros solo registran gastos de insumos pagados del cajón hasta este monto (0 = no pueden registrar).</span>
        </form>
      )}
      {canManage && (
        <form method="GET" className="flex flex-wrap items-end gap-2">
          <label className="text-sm">Desde <input type="date" name="from" defaultValue={from} className={input} /></label>
          <label className="text-sm">Hasta <input type="date" name="to" defaultValue={to} className={input} /></label>
          <label className="text-sm">Categoría <select name="cat" defaultValue={f.cat ?? ""} className={input}><option value="">Todas</option>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></label>
          <button className="h-9 rounded-md border border-input px-3 text-sm">Filtrar</button>
          <Link href={`/reports/export?type=expenses&format=csv&from=${from}&to=${to}`} className="text-sm underline">CSV</Link>
          <Link href={`/reports/export?type=expenses&format=pdf&from=${from}&to=${to}`} className="text-sm underline">PDF</Link>
        </form>
      )}
      <p className="text-sm text-muted-foreground">{canManage ? `${from} al ${to}` : "Turno abierto"} · {list.filter((e) => !e.voidedAt).length} gastos · Total vigente {formatSoles(total)}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground"><tr><th className="p-2">Fecha</th><th>Categoría</th><th>Descripción</th><th>Pagado con</th><th className="text-right">Monto</th>{canManage && <th />}</tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className={"border-t border-border align-top" + (e.voidedAt ? " text-muted-foreground line-through" : "")}>
                <td className="p-2">{e.expenseDate}</td><td>{CATEGORY_LABEL[e.category]}</td>
                <td>{e.description}{e.supplier ? ` · ${e.supplier}` : ""}{e.voidedAt ? ` (anulado: ${e.voidReason})` : ""}</td>
                <td>{SOURCE_LABEL[e.source]}</td><td className="text-right">{formatSoles(e.amountCents)}</td>
                {canManage && <td>{!e.voidedAt && (
                  <form action={voidExpenseAction} className="flex gap-1"><input type="hidden" name="id" value={e.id} />
                    <input name="reason" required minLength={3} maxLength={200} placeholder="Motivo" className="h-8 w-32 rounded-md border border-input bg-background px-2 text-xs" /><button className="text-xs underline">Anular</button></form>
                )}</td>}
              </tr>
            ))}
            {list.length === 0 && <tr><td className="p-2 text-muted-foreground">Sin gastos.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
