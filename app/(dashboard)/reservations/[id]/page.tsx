import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { db } from "@/lib/db";
import { tenantDb } from "@/lib/db/tenant";
import { formatSoles } from "@/lib/billing/money";
import { getOpenSession } from "@/lib/billing/service";
import { balanceCents, isActive, SERVICE_LABEL, STATUS_LABEL } from "@/lib/reservations/status";
import { addChecklistItemAction, payReservationAction, reservationStatusAction, sendReservationReminderAction, toggleChecklistItemAction } from "@/actions/reservations";
import { loadActive } from "@/lib/whatsapp/service";
import { ErrorBanner } from "@/components/dashboard/banner";
import { PaymentFields } from "@/components/dashboard/payment-fields";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const when = (d: Date | null) => (d ? d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }) : "—");

function StatusBtn({ id, op, label, variant = "outline" as const }: { id: string; op: string; label: string; variant?: "outline" | "destructive" }) {
  return <form action={reservationStatusAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={op} /><Button size="sm" variant={variant}>{label}</Button></form>;
}

export default async function ReservationDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ e?: string }> }) {
  const { user, tenantId } = await requirePermission("reservations:read");
  const { id } = await params;
  const { e } = await searchParams;
  const tdb = tenantDb(tenantId);
  const r = await tdb.reservation.findFirst({ where: { id }, include: { checklist: { orderBy: { createdAt: "asc" } } } });
  if (!r) notFound(); // un id de otro establecimiento da 404
  const waActive = !!(await loadActive(tenantId));
  const [sales, space, child, openCash] = await Promise.all([
    db.sale.findMany({ where: { tenantId, reservationId: id }, orderBy: { createdAt: "asc" } }),
    r.spaceId ? tdb.reservationSpace.findFirst({ where: { id: r.spaceId } }) : null,
    r.childId ? tdb.child.findFirst({ where: { id: r.childId }, select: { fullName: true } }) : null,
    getOpenSession(tenantId),
  ]);
  const balance = balanceCents(r);
  const canWrite = hasPermission(user.role, "reservations:write");
  const canCharge = hasPermission(user.role, "cash:use");
  const active = isActive(r.status);
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">{SERVICE_LABEL[r.serviceType]} · {r.date} {r.startTime}–{r.endTime}</h1><Link href={`/reservations?view=day&date=${r.date}`} className="underline">← Calendario</Link></div>
      <ErrorBanner message={e} />
      <section className="grid gap-2 rounded-lg border border-border p-4 text-sm sm:grid-cols-2">
        <p>Estado: <b>{STATUS_LABEL[r.status]}</b></p>
        <p>Contacto: {r.contactName}{r.contactPhone ? ` · ${r.contactPhone}` : ""}</p>
        <p>Asistentes: {r.attendees}{space ? ` · Espacio: ${space.name}` : ""}</p>
        <p>Menor: {child?.fullName ?? "Externo / sin registrar"}</p>
        {r.packageName && <p>Paquete: {r.packageName}</p>}
        {r.details && <p className="sm:col-span-2">Detalles: {r.details}</p>}
        {r.notes && <p className="sm:col-span-2">Observaciones: {r.notes}</p>}
        <p>Total: {formatSoles(r.totalAmountCents)} · Adelanto requerido: {formatSoles(r.advanceRequiredCents)}</p>
        <p>Pagado: {formatSoles(r.advancePaidCents)} · <b className={balance > 0 ? "text-amber-300" : "text-green-300"}>Saldo: {formatSoles(balance)}</b></p>
        <p>Recordatorio: {r.reminderSentAt ? `enviado ${when(r.reminderSentAt)}` : "pendiente"}</p>
      </section>

      {canWrite && active && (
        <section className="flex flex-wrap items-center gap-2">
          {r.status === "PENDING" && <StatusBtn id={r.id} op="confirm" label="Confirmar" />}
          {r.status === "CONFIRMED" && <StatusBtn id={r.id} op="complete" label="Completar (requiere saldo 0)" />}
          {r.status === "CONFIRMED" && <StatusBtn id={r.id} op="noshow" label="No asistió" />}
          {waActive && r.contactPhone && !r.reminderSentAt && (
            <form action={sendReservationReminderAction}><input type="hidden" name="id" value={r.id} /><Button size="sm">Enviar recordatorio por WhatsApp</Button></form>
          )}
          <StatusBtn id={r.id} op="remind" label="Marcar recordatorio enviado" />
          <form action={reservationStatusAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="op" value="cancel" />
            {r.advancePaidCents > 0 && <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="retain" /> El adelanto no se devuelve</label>}
            <Button size="sm" variant="destructive">Cancelar reserva</Button>
          </form>
        </section>
      )}

      {canCharge && active && balance > 0 && (
        <section className="space-y-2 rounded-lg border border-border p-4">
          <h2 className="font-semibold">Cobrar (adelanto / abono / saldo)</h2>
          {!openCash && <p className="text-sm text-amber-300">No hay turno de caja abierto: <Link href="/cash-register" className="underline">abrir turno</Link> para cobrar.</p>}
          <form action={payReservationAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="key" value={randomUUID()} />
            <input name="payAmount" inputMode="decimal" required defaultValue={(Math.max(0, Math.min(balance, r.advanceRequiredCents - r.advancePaidCents) || balance) / 100).toFixed(2)} className={sel + " w-28"} aria-label="Monto a cobrar (S/)" />
            <PaymentFields />
            <Button size="sm" disabled={!openCash}>Cobrar</Button>
          </form>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">Pagos registrados en caja</h2>
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {sales.map((s) => <li key={s.id} className="flex justify-between p-2"><Link href={`/cash-register/sales/${s.id}`} className="underline">{when(s.createdAt)}</Link><span>{formatSoles(s.totalCents)}</span></li>)}
          {sales.length === 0 && <li className="p-2 text-muted-foreground">Sin pagos.</li>}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Checklist de preparación</h2>
        <ul className="space-y-1 text-sm">
          {r.checklist.map((c) => (
            <li key={c.id}>
              <form action={toggleChecklistItemAction} className="flex items-center gap-2">
                <input type="hidden" name="id" value={r.id} /><input type="hidden" name="itemId" value={c.id} /><input type="hidden" name="done" value={String(!c.done)} />
                <button className="size-6 rounded border border-input" aria-label={c.done ? "Desmarcar" : "Marcar"} disabled={!canWrite}>{c.done ? "✓" : ""}</button>
                <span className={c.done ? "line-through text-muted-foreground" : ""}>{c.label}</span>
              </form>
            </li>
          ))}
        </ul>
        {canWrite && active && (
          <form action={addChecklistItemAction} className="flex gap-2"><input type="hidden" name="id" value={r.id} /><Input name="label" placeholder="Tarea (decoración, torta, sonido…)" required className="max-w-xs" /><Button size="sm" variant="outline">Agregar</Button></form>
        )}
      </section>
    </div>
  );
}
