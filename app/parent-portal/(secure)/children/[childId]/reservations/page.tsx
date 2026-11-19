import { requireGuardian } from "@/lib/portal/auth";
import { requireMyChild, reservations } from "@/lib/portal/data";
import { ChildNav } from "@/components/portal/child-nav";
import { formatSoles } from "@/lib/billing/money";
import { balanceCents, SERVICE_LABEL, STATUS_LABEL } from "@/lib/reservations/status";

export const dynamic = "force-dynamic";

export default async function ReservationsPortalPage({ params }: { params: Promise<{ childId: string }> }) {
  const g = await requireGuardian();
  const { childId } = await params;
  const mine = await requireMyChild({ id: g.id, tenantId: g.tenantId }, childId);
  const r = await reservations(mine);
  const row = (x: (typeof r.upcoming)[number]) => (
    <li key={x.id}>{x.date} {x.startTime}–{x.endTime} · {SERVICE_LABEL[x.serviceType]}{x.packageName ? ` (${x.packageName})` : ""} · {x.attendees} pers. · {STATUS_LABEL[x.status]} · pagado {formatSoles(x.advancePaidCents)} · saldo {formatSoles(balanceCents(x))}</li>
  );
  return (
    <div className="space-y-5">
      <ChildNav childId={childId} name={mine.fullName} active="/reservations" />
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Próximas reservas y cumpleaños</h2>
        <ul className="space-y-0.5">{r.upcoming.map(row)}{r.upcoming.length === 0 && <li className="text-muted-foreground">No hay reservas próximas.</li>}</ul>
      </section>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Anteriores</h2>
        <ul className="space-y-0.5">{r.past.map(row)}{r.past.length === 0 && <li className="text-muted-foreground">Sin historial.</li>}</ul>
      </section>
      <p className="text-xs text-muted-foreground">Para reservar o modificar, contacta al establecimiento.</p>
    </div>
  );
}
