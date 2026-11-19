import Link from "next/link";
import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { limaDate } from "@/lib/utils/date";
import { createBlockAction, createSpaceAction, deleteBlockAction } from "@/actions/reservations";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function ReservationSettingsPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { tenantId } = await requirePermission("settings:limited");
  const { e } = await searchParams;
  const tdb = tenantDb(tenantId);
  const [spaces, blocks] = await Promise.all([
    tdb.reservationSpace.findMany({ orderBy: { name: "asc" } }),
    tdb.scheduleBlock.findMany({ where: { date: { gte: limaDate() } }, orderBy: [{ date: "asc" }, { startTime: "asc" }], take: 100 }),
  ]);
  const name = new Map(spaces.map((s) => [s.id, s.name]));
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Espacios y bloqueos</h1><Link href="/reservations" className="underline">← Calendario</Link></div>
      <ErrorBanner message={e} />
      <section className="space-y-2">
        <h2 className="font-semibold">Espacios (salas de cumpleaños, salones de eventos)</h2>
        <form action={createSpaceAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
          <Input name="name" placeholder="Nombre" required className="w-48" /><Input name="capacity" type="number" min="1" placeholder="Capacidad" required className="w-28" /><Button>Crear espacio</Button>
        </form>
        <ul className="text-sm text-muted-foreground">{spaces.map((s) => <li key={s.id}>{s.name} · hasta {s.capacity} personas</li>)}</ul>
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Bloquear horarios</h2>
        <form action={createBlockAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
          <Input name="date" type="date" min={limaDate()} required className="w-40" /><Input name="startTime" type="time" required className="w-28" /><Input name="endTime" type="time" required className="w-28" />
          <select name="spaceId" className={sel}><option value="">Todo el local</option>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <Input name="reason" placeholder="Motivo" required className="w-48" /><Button>Bloquear</Button>
        </form>
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {blocks.map((b) => (
            <li key={b.id} className="flex items-center justify-between p-2"><span>{b.date} {b.startTime}–{b.endTime} · {b.spaceId ? name.get(b.spaceId) ?? "espacio" : "todo el local"} · {b.reason}</span>
              <form action={deleteBlockAction}><input type="hidden" name="id" value={b.id} /><button className="underline">Quitar</button></form></li>
          ))}
          {blocks.length === 0 && <li className="p-2 text-muted-foreground">Sin bloqueos próximos.</li>}
        </ul>
      </section>
    </div>
  );
}
