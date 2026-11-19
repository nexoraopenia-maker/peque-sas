import { requireGuardian } from "@/lib/portal/auth";
import { finances, requireMyChild } from "@/lib/portal/data";
import { ChildNav } from "@/components/portal/child-nav";
import { formatSoles } from "@/lib/billing/money";
import { limaDate } from "@/lib/utils/date";

export const dynamic = "force-dynamic";
const dt = (d: Date) => d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" });
const LEDGER = { PURCHASE: "Compra", CONSUME: "Consumo", ADJUST: "Ajuste" } as const;
const SALE = { PLAYGROUND: "Ludoteca", PREPAID_PACKAGE: "Cuponera", DAYCARE_FEE: "Mensualidad", POS: "Compra", RESERVATION_PAYMENT: "Reserva" } as const;
const INV = { PENDING: "Pendiente", PAID: "Pagada", VOID: "Anulada" } as const;

export default async function FinancesPage({ params }: { params: Promise<{ childId: string }> }) {
  const g = await requireGuardian();
  const { childId } = await params;
  const mine = await requireMyChild({ id: g.id, tenantId: g.tenantId }, childId);
  const f = await finances(mine);
  const today = limaDate();
  return (
    <div className="space-y-5">
      <ChildNav childId={childId} name={mine.fullName} active="/finances" />
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Cuponera</p><p className="text-xl font-bold">{f.prepaidMinutes} min</p></div>
        <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Mensualidades pendientes</p><p className="text-xl font-bold">{formatSoles(f.pendingCents)}</p></div>
        <div className={`rounded-lg border p-3 ${f.overdueCents > 0 ? "border-red-500/50" : "border-border"}`}><p className="text-xs text-muted-foreground">Deuda vencida</p><p className={`text-xl font-bold ${f.overdueCents > 0 ? "text-red-400" : ""}`}>{formatSoles(f.overdueCents)}</p></div>
      </section>
      <p className="text-xs text-muted-foreground">Los pagos se realizan en el establecimiento. Esta vista es solo informativa.</p>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Mensualidades</h2>
        <ul className="space-y-0.5">
          {f.invoices.map((i) => <li key={i.id}>{i.period} · vence {i.dueDate} · {formatSoles(i.amountCents)} · <b className={i.status === "PENDING" && i.dueDate < today ? "text-red-400" : ""}>{i.status === "PENDING" && i.dueDate < today ? "Vencida" : INV[i.status]}</b>{i.paidAt ? ` (${dt(i.paidAt)})` : ""}</li>)}
          {f.invoices.length === 0 && <li className="text-muted-foreground">Sin mensualidades.</li>}
        </ul>
      </section>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Movimientos de la cuponera</h2>
        <ul className="space-y-0.5">
          {f.ledger.map((l) => <li key={l.id}>{dt(l.createdAt)} · {LEDGER[l.type]} {l.minutes > 0 ? "+" : ""}{l.minutes} min · saldo {l.balanceAfter} min</li>)}
          {f.ledger.length === 0 && <li className="text-muted-foreground">Sin movimientos.</li>}
        </ul>
      </section>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Pagos recientes</h2>
        <ul className="space-y-0.5">
          {f.sales.map((s) => <li key={s.id}>{dt(s.createdAt)} · {SALE[s.kind]} · {formatSoles(s.totalCents)}</li>)}
          {f.sales.length === 0 && <li className="text-muted-foreground">Sin pagos.</li>}
        </ul>
      </section>
    </div>
  );
}
