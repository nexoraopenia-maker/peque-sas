import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { formatSoles } from "@/lib/billing/money";
import { hasPermission } from "@/lib/rbac/permissions";
import { getSunatConfig } from "@/lib/sunat/config";
import { KIND_NAME, docNumber } from "@/lib/sunat/pure";
import { issueDocumentAction } from "@/actions/sunat";
import { ErrorBanner } from "@/components/dashboard/banner";
import { VoucherFields } from "@/components/dashboard/voucher-fields";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const KIND = { PLAYGROUND: "Ludoteca", PREPAID_PACKAGE: "Cuponera", DAYCARE_FEE: "Mensualidad", POS: "Venta de productos", RESERVATION_PAYMENT: "Pago de reserva" } as const;

// Comprobante interno (no es un comprobante electrónico SUNAT). El comprobante electrónico, si existe, se muestra debajo.
export default async function SalePage({ params, searchParams }: { params: Promise<{ saleId: string }>; searchParams: Promise<{ e?: string }> }) {
  const { user, tenantId } = await requirePermission("cash:use");
  const { saleId } = await params;
  const { e } = await searchParams;
  const sale = await db.sale.findFirst({ where: { id: saleId, tenantId }, include: { items: true } });
  if (!sale) notFound();
  const [cfg, doc] = await Promise.all([
    getSunatConfig(tenantId),
    db.sunatDocument.findFirst({ where: { tenantId, saleId: sale.id }, select: { id: true, kind: true, status: true, serie: true, number: true, lastError: true, creditedAt: true, pdf: true } }),
  ]);
  const canIssue = hasPermission(user.role, "sunat:issue"), canManage = hasPermission(user.role, "sunat:manage");
  const lines: [string, number][] = [["Efectivo", sale.cashCents], ["Yape/Plin", sale.yapePlinCents], ["Tarjeta", sale.cardCents], ["Transferencia", sale.transferCents]];
  return (
    <div className="mx-auto max-w-md space-y-3">
      <h1 className="text-2xl font-bold">Comprobante interno</h1>
      <ErrorBanner message={e} />
      <p className="text-sm text-muted-foreground">{KIND[sale.kind]} · {sale.createdAt.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" })} · #{sale.id.slice(0, 8)}</p>
      <div className="rounded-lg border border-border p-3 text-sm">
        {sale.items.map((i) => <p key={i.id} className="flex justify-between"><span>{i.description}{i.quantity > 1 && i.kind !== "PREPAID_CREDIT" ? ` × ${i.quantity}` : ""}</span><span>{formatSoles(i.totalCents)}</span></p>)}
        <p className="mt-2 flex justify-between border-t border-border pt-2 text-base font-bold"><span>Total</span><span>{formatSoles(sale.totalCents)}</span></p>
        {lines.filter(([, v]) => v > 0).map(([k, v]) => <p key={k} className="flex justify-between text-muted-foreground"><span>Pagado con {k}</span><span>{formatSoles(v)}</span></p>)}
        {(sale.pointsEarned > 0 || sale.pointsRedeemed > 0) && <p className="mt-1 text-xs text-muted-foreground">Puntos: {sale.pointsEarned > 0 ? `+${sale.pointsEarned} acreditados` : ""}{sale.pointsEarned > 0 && sale.pointsRedeemed > 0 ? " · " : ""}{sale.pointsRedeemed > 0 ? `−${sale.pointsRedeemed} canjeados` : ""}</p>}
      </div>
      {cfg?.enabled && (
        <section className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <h2 className="font-semibold">Comprobante electrónico</h2>
          {doc ? (
            <>
              <p>{KIND_NAME[doc.kind]} {docNumber(doc.serie, doc.number)} · {doc.status === "ACCEPTED" ? "Aceptado" : doc.status === "REJECTED" ? "Rechazado" : doc.status === "FAILED" ? "Falló" : "Pendiente de envío (se reintenta solo)"}{doc.creditedAt ? " · anulado" : ""}</p>
              {doc.lastError && <p className="text-xs text-red-300">{doc.lastError}</p>}
              <p className="flex gap-4 underline">
                {doc.pdf && canIssue && <Link href={`/reports/invoices/${doc.id}/file?kind=pdf`}>Descargar PDF</Link>}
                {canManage && <Link href={`/reports/invoices/${doc.id}`}>Detalle</Link>}
              </p>
            </>
          ) : sale.totalCents <= 0 ? <p className="text-muted-foreground">Sin importe a pagar: no genera comprobante.</p> : canIssue ? (
            <form action={issueDocumentAction} className="space-y-2">
              <input type="hidden" name="saleId" value={sale.id} />
              <p className="text-muted-foreground">Esta venta aún no tiene comprobante electrónico.</p>
              <VoucherFields />
              <Button size="sm">Emitir comprobante</Button>
            </form>
          ) : <p className="text-muted-foreground">Sin comprobante electrónico.</p>}
        </section>
      )}
      <p className="flex gap-4 text-sm underline"><Link href="/cash-register">← Caja</Link><Link href="/playground/live">Ludoteca</Link></p>
    </div>
  );
}
