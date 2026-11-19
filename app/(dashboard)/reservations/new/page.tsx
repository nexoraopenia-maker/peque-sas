import Link from "next/link";
import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { tenantHasModule } from "@/lib/plans/modules";
import { limaDate } from "@/lib/utils/date";
import { SERVICE_LABEL, type ReservationService } from "@/lib/reservations/status";
import { createReservationAction } from "@/actions/reservations";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function NewReservationPage({ searchParams }: { searchParams: Promise<{ e?: string; date?: string }> }) {
  const { user, tenantId } = await requirePermission("reservations:write");
  const q = await searchParams;
  const tdb = tenantDb(tenantId);
  const [children, spaces] = await Promise.all([
    tdb.child.findMany({ orderBy: { fullName: "asc" }, take: 500, select: { id: true, fullName: true } }),
    tdb.reservationSpace.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
  const services = (Object.keys(SERVICE_LABEL) as ReservationService[]).filter((s) =>
    s === "GUARDERIA" ? tenantHasModule(user.tenant?.modules, "DAYCARE") : tenantHasModule(user.tenant?.modules, "PLAYGROUND"));
  const sel = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Nueva reserva</h1><Link href="/reservations" className="underline">← Calendario</Link></div>
      <ErrorBanner message={q.e} />
      <form action={createReservationAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-3">
        <label className="text-sm">Servicio<select name="serviceType" required className={sel}>{services.map((s) => <option key={s} value={s}>{SERVICE_LABEL[s]}</option>)}</select></label>
        <label className="text-sm">Espacio (cumpleaños / evento)<select name="spaceId" className={sel}><option value="">—</option>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name} (hasta {s.capacity})</option>)}</select></label>
        <label className="text-sm">Menor (opcional)<select name="childId" className={sel}><option value="">Externo / sin registrar</option>{children.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}</select></label>
        <label className="text-sm">Contacto<Input name="contactName" required maxLength={120} /></label>
        <label className="text-sm">Teléfono<Input name="contactPhone" maxLength={20} /></label>
        <label className="text-sm">Asistentes<Input name="attendees" type="number" min="1" defaultValue={1} required /></label>
        <label className="text-sm">Fecha<Input name="date" type="date" min={limaDate()} defaultValue={q.date ?? limaDate()} required /></label>
        <label className="text-sm">Inicio<Input name="startTime" type="time" defaultValue="10:00" required /></label>
        <label className="text-sm">Fin<Input name="endTime" type="time" defaultValue="12:00" required /></label>
        <label className="text-sm">Total (S/)<Input name="total" inputMode="decimal" defaultValue="0.00" required /></label>
        <label className="text-sm">Adelanto requerido (S/)<Input name="advanceRequired" inputMode="decimal" defaultValue="0.00" required /></label>
        <label className="text-sm">Paquete<Input name="packageName" maxLength={80} placeholder="Ej. Cumpleaños básico" /></label>
        <label className="text-sm sm:col-span-3">Detalles (decoración, alimentos, servicios adicionales)<Input name="details" maxLength={1000} /></label>
        <label className="text-sm sm:col-span-3">Observaciones<Input name="notes" maxLength={500} /></label>
        <Button className="sm:col-span-3">Reservar (se valida cupo y espacio al guardar)</Button>
      </form>
    </div>
  );
}
