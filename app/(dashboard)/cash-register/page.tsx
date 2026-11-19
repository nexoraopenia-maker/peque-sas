import Link from "next/link";
import { randomUUID } from "node:crypto";
import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { expectedCash, formatSoles } from "@/lib/billing/money";
import { getOpenSession, sessionTotals } from "@/lib/billing/service";
import { closeCashAction, openCashAction, posSaleAction } from "@/actions/cash";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { ExpenseForm } from "@/components/dashboard/expense-form";
import { hasPermission } from "@/lib/rbac/permissions";
import { getCashierLimit } from "@/lib/expenses/service";
import { PromoFields } from "@/components/dashboard/promo-fields";
import { PaymentFields } from "@/components/dashboard/payment-fields";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
const when = (d: Date | null) => (d ? d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }) : "—");
const KIND = { PLAYGROUND: "Ludoteca", PREPAID_PACKAGE: "Cuponera", DAYCARE_FEE: "Mensualidad", POS: "Venta", RESERVATION_PAYMENT: "Reserva" } as const;

export default async function CashRegisterPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { user, tenantId } = await requirePermission("cash:use");
  const { e, ok } = await searchParams;
  const tdb = tenantDb(tenantId);
  const open = await getOpenSession(tenantId);
  const [totals, sales, products, history, users] = await Promise.all([
    open ? sessionTotals(tenantId, open.id) : null,
    open ? db.sale.findMany({ where: { tenantId, cashRegisterSessionId: open.id }, orderBy: { createdAt: "desc" }, take: 15 }) : [],
    tdb.product.findMany({ where: { isActive: true, stock: { gt: 0 } }, orderBy: { name: "asc" } }),
    db.cashRegisterSession.findMany({ where: { tenantId, status: "CLOSED" }, orderBy: { closedAt: "desc" }, take: 10 }),
    db.user.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);
  const who = new Map(users.map((u) => [u.id, u.name]));
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  const lastDiff = history[0]?.differenceCents;
  const alert = history[0] && lastDiff != null && Math.abs(lastDiff) > 500
    ? await db.whatsAppMessage.findFirst({ where: { tenantId, purpose: "CASH_ALERT", relatedId: history[0].id }, orderBy: { createdAt: "desc" }, select: { status: true, errorDetail: true } })
    : null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Caja</h1>
      <ErrorBanner message={e} />
      <OkBanner message={ok} />
      {lastDiff != null && Math.abs(lastDiff) > 500 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          El último cierre tuvo una diferencia de {formatSoles(lastDiff)} (mayor a S/ 5.00).{" "}
          {alert ? (alert.status === "FAILED" ? `El aviso por WhatsApp al propietario falló: ${alert.errorDetail ?? "error"}.` : "Se avisó al propietario por WhatsApp.") : "No se envió aviso por WhatsApp (WhatsApp no está activo o falta el teléfono del propietario)."}
        </p>
      )}

      {!open && (
        <form action={openCashAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-4">
          <label className="text-sm">Sencillo inicial (S/) <Input name="opening" inputMode="decimal" defaultValue="0.00" required /></label>
          <Button>Abrir turno</Button>
          <p className="w-full text-sm text-muted-foreground">Sin turno abierto no se pueden registrar cobros.</p>
        </form>
      )}

      {open && totals && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Turno abierto", `${when(open.openedAt)} · ${who.get(open.openedById) ?? ""}`],
              ["Sencillo inicial", formatSoles(open.openingBalanceCents)],
              ["Efectivo esperado", formatSoles(expectedCash(open.openingBalanceCents, totals.cash, open.cashRefundsCents, open.cashExpensesCents))],
              ["Ventas del turno", `${totals.count} · ${formatSoles(totals.total)}`],
              ["Efectivo", formatSoles(totals.cash)], ["Gastos del cajón", formatSoles(open.cashExpensesCents)], ["Yape/Plin", formatSoles(totals.yapePlin)],
              ["Tarjeta", formatSoles(totals.card)], ["Transferencia", formatSoles(totals.transfer)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border bg-card p-3"><p className="text-xs text-muted-foreground">{k}</p><p className="text-lg font-bold">{v}</p></div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold">Venta de productos</h2>
            <form action={posSaleAction} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
              <input type="hidden" name="key" value={randomUUID()} />
              <select name="productId" required className={sel}>{products.map((p) => <option key={p.id} value={p.id}>{p.name} · {formatSoles(p.priceCents)} ({p.stock})</option>)}</select>
              <input name="quantity" type="number" min="1" defaultValue={1} className={sel + " w-16"} aria-label="Cantidad" />
              <PromoFields />
              <PaymentFields />
              <Button disabled={products.length === 0}>Cobrar</Button>
            </form>
          </section>

          {hasPermission(user.role, "expenses:record") && (
            <section className="space-y-2">
              <h2 className="font-semibold">Gasto del turno</h2>
              <ExpenseForm canManage={hasPermission(user.role, "expenses:manage")} back="/cash-register" limitCents={await getCashierLimit(tenantId)} />
            </section>
          )}

          <section className="space-y-2">
            <h2 className="font-semibold">Últimas ventas</h2>
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {sales.map((s) => (
                <li key={s.id} className="flex justify-between p-2"><Link href={`/cash-register/sales/${s.id}`} className="underline">{KIND[s.kind]} · {when(s.createdAt)}</Link><span>{formatSoles(s.totalCents)}</span></li>
              ))}
              {sales.length === 0 && <li className="p-2 text-muted-foreground">Sin ventas en este turno.</li>}
            </ul>
          </section>

          <form action={closeCashAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-4">
            <label className="text-sm">Efectivo contado en caja (S/) <Input name="declared" inputMode="decimal" required /></label>
            <Button variant="destructive">Cerrar turno</Button>
            <p className="w-full text-sm text-muted-foreground">Diferencia = efectivo contado − efectivo esperado. Los pagos electrónicos no suman al efectivo.</p>
          </form>
        </>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">Turnos cerrados</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="p-2">Cierre</th><th>Responsable</th><th>Esperado</th><th>Declarado</th><th>Diferencia</th><th>Efectivo</th><th>Yape/Plin</th><th>Tarjeta</th><th>Transf.</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-border">
                  <td className="p-2">{when(h.closedAt)}</td><td>{who.get(h.closedById ?? "") ?? "—"}</td>
                  <td>{formatSoles(h.expectedCashCents ?? 0)}</td><td>{formatSoles(h.declaredCashCents ?? 0)}</td>
                  <td className={(h.differenceCents ?? 0) !== 0 ? "font-bold text-amber-400" : ""}>{formatSoles(h.differenceCents ?? 0)}</td>
                  <td>{formatSoles(h.cashSalesCents ?? 0)}</td><td>{formatSoles(h.yapePlinSalesCents ?? 0)}</td><td>{formatSoles(h.cardSalesCents ?? 0)}</td><td>{formatSoles(h.transferSalesCents ?? 0)}</td>
                </tr>
              ))}
              {history.length === 0 && <tr><td className="p-2 text-muted-foreground">Sin cierres.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
