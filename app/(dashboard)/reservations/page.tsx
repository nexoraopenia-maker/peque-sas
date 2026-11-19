import Link from "next/link";
import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { tenantDb } from "@/lib/db/tenant";
import { tenantHasModule } from "@/lib/plans/modules";
import { limaDate } from "@/lib/utils/date";
import { addDays, addMonths, DAY_NAMES, isDate, monthGrid, weekDays, weekStart } from "@/lib/reservations/calendar";
import { hourSlots, slotRemaining } from "@/lib/reservations/availability";
import { balanceCents, SERVICE_LABEL, STATUS_LABEL, type ReservationStatus } from "@/lib/reservations/status";
import { formatSoles } from "@/lib/billing/money";
import { ErrorBanner } from "@/components/dashboard/banner";

export const dynamic = "force-dynamic";
const VIEWS = { day: "Día", week: "Semana", month: "Mes", agenda: "Agenda" } as const;
type View = keyof typeof VIEWS;
const COLOR: Record<ReservationStatus, string> = {
  PENDING: "bg-amber-500/20 text-amber-300", CONFIRMED: "bg-green-500/20 text-green-300",
  COMPLETED: "bg-sky-500/20 text-sky-300", CANCELLED: "bg-zinc-500/20 text-zinc-400 line-through", NO_SHOW: "bg-red-500/20 text-red-300",
};

type Item = { id: string; date: string; startTime: string; endTime: string; serviceType: keyof typeof SERVICE_LABEL; status: ReservationStatus; contactName: string; attendees: number; totalAmountCents: number; advancePaidCents: number };

function Chip({ r, long = false }: { r: Item; long?: boolean }) {
  return (
    <Link href={`/reservations/${r.id}`} className={`block rounded px-1.5 py-0.5 text-xs ${COLOR[r.status]}`} title={`${SERVICE_LABEL[r.serviceType]} · ${STATUS_LABEL[r.status]}`}>
      {r.startTime} {long ? `${SERVICE_LABEL[r.serviceType]} · ` : ""}{r.contactName}{long ? ` · ${r.attendees} pers. · saldo ${formatSoles(balanceCents(r))}` : ""}
    </Link>
  );
}

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string; e?: string }> }) {
  const { user, tenantId } = await requirePermission("reservations:read");
  const q = await searchParams;
  const today = limaDate();
  const view: View = q.view && q.view in VIEWS ? (q.view as View) : "week";
  const date = q.date && isDate(q.date) ? q.date : today;
  const month = date.slice(0, 7);

  const range: [string, string] =
    view === "day" ? [date, date]
    : view === "week" ? [weekStart(date), addDays(weekStart(date), 6)]
    : view === "month" ? (() => { const g = monthGrid(month); return [g[0]![0]!, g.at(-1)!.at(-1)!] as [string, string]; })()
    : [date, addDays(date, 30)];

  const tdb = tenantDb(tenantId);
  const [rows, blocks, openSessions] = await Promise.all([
    tdb.reservation.findMany({ where: { date: { gte: range[0], lte: range[1] } }, orderBy: [{ date: "asc" }, { startTime: "asc" }], take: 1000 }),
    tdb.scheduleBlock.findMany({ where: { date: { gte: range[0], lte: range[1] } }, orderBy: [{ date: "asc" }, { startTime: "asc" }] }),
    view === "day" && date === today ? tdb.playgroundSession.count({ where: { status: "OPEN" } }) : Promise.resolve(0),
  ]);
  const items = rows as unknown as Item[];
  const byDate = new Map<string, Item[]>();
  for (const r of items) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const blocksByDate = new Map<string, typeof blocks>();
  for (const b of blocks) blocksByDate.set(b.date, [...(blocksByDate.get(b.date) ?? []), b]);

  const capacity = user.tenant?.playgroundCapacity ?? 0;
  const hasLudo = tenantHasModule(user.tenant?.modules, "PLAYGROUND");
  const link = (v: View, d: string) => `/reservations?view=${v}&date=${d}`;
  const step = view === "day" ? 1 : view === "week" ? 7 : 30;
  const prev = view === "month" ? `${addMonths(month, -1)}-01` : addDays(date, -step);
  const next = view === "month" ? `${addMonths(month, 1)}-01` : addDays(date, step);
  const title = view === "day" ? date : view === "week" ? `${range[0]} → ${range[1]}` : view === "month" ? month : `Próximos 30 días desde ${date}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Reservas</h1>
        <nav className="flex flex-wrap gap-3 text-sm underline">
          {hasPermission(user.role, "reservations:write") && <Link href="/reservations/new">+ Nueva reserva</Link>}
          <Link href="/reservations/reminders">Recordatorios</Link>
          {hasPermission(user.role, "settings:limited") && <Link href="/reservations/settings">Espacios y bloqueos</Link>}
        </nav>
      </div>
      <ErrorBanner message={q.e} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {(Object.keys(VIEWS) as View[]).map((v) => (
          <Link key={v} href={link(v, date)} className={`rounded-md border px-3 py-1 ${v === view ? "border-primary bg-accent" : "border-border"}`}>{VIEWS[v]}</Link>
        ))}
        <span className="mx-2 flex items-center gap-2">
          <Link href={link(view, prev)} className="rounded-md border border-border px-2 py-1" aria-label="Anterior">←</Link>
          <Link href={link(view, today)} className="rounded-md border border-border px-2 py-1">Hoy</Link>
          <Link href={link(view, next)} className="rounded-md border border-border px-2 py-1" aria-label="Siguiente">→</Link>
        </span>
        <b>{title}</b>
      </div>

      {view === "day" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-2">
            <h2 className="font-semibold">Reservas del día</h2>
            {(blocksByDate.get(date) ?? []).map((b) => <p key={b.id} className="rounded bg-zinc-500/20 px-2 py-1 text-sm">🚫 {b.startTime}–{b.endTime} {b.reason}{b.spaceId ? " (espacio)" : " (todo el local)"}</p>)}
            {(byDate.get(date) ?? []).map((r) => <Chip key={r.id} r={r} long />)}
            {!(byDate.get(date) ?? []).length && <p className="text-sm text-muted-foreground">Sin reservas.</p>}
          </section>
          {hasLudo && (
            <section className="space-y-2">
              <h2 className="font-semibold">Cupos de ludoteca (aforo {capacity})</h2>
              <table className="w-full text-sm">
                <tbody>
                  {hourSlots().map(([s, e]) => {
                    const nowH = new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Lima" });
                    const occ = date === today && s <= nowH && nowH < e ? openSessions : 0;
                    const free = slotRemaining(capacity, items, "LUDOTECA", s, e, occ);
                    const blocked = (blocksByDate.get(date) ?? []).some((b) => !b.spaceId && b.startTime < e && b.endTime > s);
                    return (
                      <tr key={s} className="border-t border-border"><td className="py-1">{s}–{e}</td>
                        <td className={blocked ? "text-zinc-400" : free === 0 ? "text-red-400" : free <= capacity * 0.25 ? "text-amber-300" : "text-green-300"}>{blocked ? "Bloqueado" : `${free} libres`}</td></tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}

      {view === "week" && (
        <div className="grid gap-2 md:grid-cols-7">
          {weekDays(date).map((d, i) => (
            <section key={d} className={`min-h-24 space-y-1 rounded-lg border p-2 ${d === today ? "border-primary" : "border-border"}`}>
              <Link href={link("day", d)} className="block text-xs font-semibold underline">{DAY_NAMES[i]} {d.slice(8)}</Link>
              {(blocksByDate.get(d) ?? []).map((b) => <p key={b.id} className="rounded bg-zinc-500/20 px-1 text-xs">🚫 {b.reason}</p>)}
              {(byDate.get(d) ?? []).map((r) => <Chip key={r.id} r={r} />)}
            </section>
          ))}
        </div>
      )}

      {view === "month" && (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-xs">
            <thead><tr>{DAY_NAMES.map((n) => <th key={n} className="p-1 text-left text-muted-foreground">{n}</th>)}</tr></thead>
            <tbody>
              {monthGrid(month).map((w) => (
                <tr key={w[0]}>{w.map((d) => {
                  const list = byDate.get(d) ?? [];
                  return (
                    <td key={d} className={`h-24 align-top border border-border p-1 ${d.slice(0, 7) !== month ? "opacity-40" : ""} ${d === today ? "bg-accent/40" : ""}`}>
                      <Link href={link("day", d)} className="font-semibold underline">{+d.slice(8)}</Link>
                      <div className="mt-1 space-y-0.5">
                        {list.slice(0, 3).map((r) => <Chip key={r.id} r={r} />)}
                        {list.length > 3 && <Link href={link("day", d)} className="text-muted-foreground underline">+{list.length - 3} más</Link>}
                      </div>
                    </td>
                  );
                })}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "agenda" && (
        <div className="space-y-3">
          {[...byDate.keys()].sort().map((d) => (
            <section key={d}>
              <h2 className="text-sm font-semibold"><Link href={link("day", d)} className="underline">{d}</Link></h2>
              <div className="mt-1 space-y-1">{byDate.get(d)!.map((r) => <Chip key={r.id} r={r} long />)}</div>
            </section>
          ))}
          {byDate.size === 0 && <p className="text-sm text-muted-foreground">No hay reservas en este periodo.</p>}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Verde confirmada · ámbar pendiente · azul completada · rojo no asistió · gris cancelada.</p>
    </div>
  );
}
