import { randomUUID } from "node:crypto";
import { requireModule, requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { tenantDb } from "@/lib/db/tenant";
import { formatSoles } from "@/lib/billing/money";
import { isMonthString, limaDate } from "@/lib/utils/date";
import { generateInvoicesAction, payInvoiceAction } from "@/actions/invoices";
import { ErrorBanner } from "@/components/dashboard/banner";
import { PaymentFields } from "@/components/dashboard/payment-fields";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const STATUS = { PENDING: "Pendiente", PAID: "Pagada", VOID: "Anulada" } as const;

export default async function SubscriptionsPage({ searchParams }: { searchParams: Promise<{ e?: string; month?: string }> }) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("cash:use");
  const q = await searchParams;
  const month = q.month && isMonthString(q.month) ? q.month : limaDate().slice(0, 7);
  const tdb = tenantDb(tenantId);
  const invoices = await tdb.daycareInvoice.findMany({ where: { period: month }, orderBy: { createdAt: "asc" } });
  const kids = await tdb.child.findMany({ where: { id: { in: invoices.map((i) => i.childId) } }, select: { id: true, fullName: true } });
  const name = new Map(kids.map((k) => [k.id, k.fullName]));
  const pending = invoices.filter((i) => i.status === "PENDING").reduce((n, i) => n + i.amountCents, 0);
  const paid = invoices.filter((i) => i.status === "PAID").reduce((n, i) => n + i.amountCents, 0);
  const input = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Mensualidades de guardería</h1>
      <ErrorBanner message={q.e} />
      <div className="flex flex-wrap items-end gap-3">
        <form method="GET" className="flex items-end gap-2"><input type="month" name="month" defaultValue={month} className={input} /><button className="h-9 rounded-md border border-input px-3 text-sm">Ver</button></form>
        {hasPermission(user.role, "daycare:manage") && (
          <form action={generateInvoicesAction}><input type="hidden" name="period" value={month} /><Button variant="outline">Generar mensualidades de {month}</Button></form>
        )}
      </div>
      <p className="text-sm text-muted-foreground">Por cobrar {formatSoles(pending)} · Cobrado {formatSoles(paid)}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {invoices.length === 0 && <li className="p-4 text-sm text-muted-foreground">No hay mensualidades generadas para este periodo.</li>}
        {invoices.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <span><b>{name.get(i.childId) ?? "—"}</b> · vence {i.dueDate} · {formatSoles(i.amountCents)} · {STATUS[i.status]}</span>
            {i.status === "PENDING" && (
              <form action={payInvoiceAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="invoiceId" value={i.id} /><input type="hidden" name="key" value={randomUUID()} />
                <PaymentFields /><Button size="sm">Cobrar</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
