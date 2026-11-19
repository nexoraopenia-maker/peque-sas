import Link from "next/link";
import { z } from "zod";
import { requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { formatSoles } from "@/lib/billing/money";
import { KIND_NAME, docNumber } from "@/lib/sunat/pure";
import { retryAllAction } from "@/actions/sunat";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const ST = { PENDING: "Pendiente", ACCEPTED: "Aceptado", REJECTED: "Rechazado", FAILED: "Falló" } as const;
const COLOR = { PENDING: "text-amber-300", ACCEPTED: "text-green-300", REJECTED: "text-red-300", FAILED: "text-red-300" } as const;
const q = z.object({
  e: z.string().max(300).optional(), ok: z.string().max(200).optional(),
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "FAILED"]).optional().catch(undefined),
  kind: z.enum(["BOLETA", "FACTURA", "CREDIT_NOTE"]).optional().catch(undefined),
  from: z.iso.date().optional().catch(undefined), to: z.iso.date().optional().catch(undefined),
});
const when = (d: Date | null) => (d ? d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }) : "—");

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenantId } = await requirePermission("sunat:manage");
  const f = q.parse(await searchParams);
  const where = { tenantId, ...(f.status ? { status: f.status } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.from || f.to ? { issueDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}) };
  const [docs, counts, cfg] = await Promise.all([
    db.sunatDocument.findMany({ where, orderBy: [{ issueDate: "desc" }, { number: "desc" }], take: 200, select: { id: true, kind: true, status: true, serie: true, number: true, issueDate: true, customerName: true, totalCents: true, attempts: true, nextAttemptAt: true, lastError: true, creditedAt: true, provider: true } }),
    db.sunatDocument.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
    db.sunatConfig.findFirst({ where: { tenantId }, select: { enabled: true, provider: true } }),
  ]);
  const n = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
  const input = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Comprobantes electrónicos</h1>
      <ErrorBanner message={f.e} /><OkBanner message={f.ok} />
      {!cfg?.enabled && <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">La facturación electrónica no está activa. {cfg ? "" : "Configúrala en "}<Link href="/settings/sunat" className="underline">Facturación SUNAT</Link>.</p>}
      {cfg?.provider === "MOCK" && <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">Modo SIMULADO: los comprobantes no se envían a SUNAT ni tienen validez tributaria.</p>}
      <section className="grid gap-3 sm:grid-cols-4">
        {(["ACCEPTED", "PENDING", "REJECTED", "FAILED"] as const).map((s) => (
          <Link key={s} href={`/reports/invoices?status=${s}`} className="rounded-lg border border-border bg-card p-3"><p className="text-xs text-muted-foreground">{ST[s]}</p><p className={`text-lg font-bold ${COLOR[s]}`}>{n(s)}</p></Link>
        ))}
      </section>
      <div className="flex flex-wrap items-end gap-3">
        <form method="GET" className="flex flex-wrap items-end gap-2">
          <label className="text-sm">Estado <select name="status" defaultValue={f.status ?? ""} className={input}><option value="">Todos</option>{Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="text-sm">Tipo <select name="kind" defaultValue={f.kind ?? ""} className={input}><option value="">Todos</option>{Object.entries(KIND_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="text-sm">Desde <input type="date" name="from" defaultValue={f.from} className={input} /></label>
          <label className="text-sm">Hasta <input type="date" name="to" defaultValue={f.to} className={input} /></label>
          <button className="h-9 rounded-md border border-input px-3 text-sm">Filtrar</button>
        </form>
        <form action={retryAllAction}><Button size="sm" variant="outline" disabled={n("PENDING") === 0}>Reintentar pendientes ahora</Button></form>
      </div>
      <p className="text-xs text-muted-foreground">Los pendientes se reintentan solos con espera creciente (1, 5, 15 min, 1, 3, 6, 12 y 24 h); tras 8 intentos pasan a «Falló» y se reintentan a mano.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground"><tr><th className="p-2">Comprobante</th><th>Tipo</th><th>Fecha</th><th>Cliente</th><th className="text-right">Total</th><th>Estado</th><th>Error / detalle</th></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-t border-border align-top">
                <td className="p-2"><Link href={`/reports/invoices/${d.id}`} className="underline">{docNumber(d.serie, d.number)}</Link></td>
                <td>{KIND_NAME[d.kind]}{d.provider === "MOCK" ? " (sim.)" : ""}</td><td>{d.issueDate}</td><td>{d.customerName}</td>
                <td className="text-right">{formatSoles(d.totalCents)}</td>
                <td className={COLOR[d.status]}>{ST[d.status]}{d.creditedAt ? " · anulado" : ""}</td>
                <td className="max-w-xs text-xs text-muted-foreground">{d.lastError ?? "—"}{d.status === "PENDING" ? ` · intento ${d.attempts}${d.nextAttemptAt ? `, próximo ${when(d.nextAttemptAt)}` : ""}` : ""}</td>
              </tr>
            ))}
            {docs.length === 0 && <tr><td className="p-2 text-muted-foreground" colSpan={7}>Sin comprobantes.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
