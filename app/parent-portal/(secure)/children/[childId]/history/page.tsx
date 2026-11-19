import { requireGuardian } from "@/lib/portal/auth";
import { attendanceMonth, dayLog, incidents, playgroundHistory, requireMyChild } from "@/lib/portal/data";
import { ChildNav } from "@/components/portal/child-nav";
import { isDateString, isMonthString, limaDate } from "@/lib/utils/date";
import { formatSoles } from "@/lib/billing/money";

export const dynamic = "force-dynamic";
const tm = (d: Date | null) => (d ? d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" }) : "—");
const dt = (d: Date) => d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" });
const TYPE = { FALL: "Caída", ALLERGY: "Alergia", BEHAVIOR: "Conducta", HEALTH: "Salud", OTHER: "Otro" } as const;

export default async function HistoryPage({ params, searchParams }: { params: Promise<{ childId: string }>; searchParams: Promise<{ month?: string; date?: string }> }) {
  const g = await requireGuardian();
  const { childId } = await params;
  const q = await searchParams;
  const mine = await requireMyChild({ id: g.id, tenantId: g.tenantId }, childId);
  const month = q.month && isMonthString(q.month) ? q.month : limaDate().slice(0, 7);
  const date = q.date && isDateString(q.date) ? q.date : limaDate();
  const [att, log, sessions, inc] = await Promise.all([attendanceMonth(mine, month), dayLog(mine, date), playgroundHistory(mine), incidents(mine)]);
  const input = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="space-y-5">
      <ChildNav childId={childId} name={mine.fullName} active="/history" />
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Asistencia a guardería</h2>
        <form method="GET" className="flex items-end gap-2"><input type="month" name="month" defaultValue={month} className={input} /><button className="h-9 rounded-md border border-input px-3">Ver</button></form>
        <p className="text-muted-foreground">Presente {att.filter((a) => a.status === "PRESENT").length} · Tardanzas {att.filter((a) => a.lateMinutes > 0).length} · Ausencias registradas {att.filter((a) => a.status === "ABSENT").length}</p>
        <ul className="space-y-0.5">
          {att.map((a) => <li key={a.date}>{a.date} — {a.status === "ABSENT" ? "Ausente" : `Ingreso ${tm(a.checkInAt)}${a.lateMinutes ? ` (tardanza ${a.lateMinutes} min)` : ""} · Salida ${tm(a.checkOutAt)}`}</li>)}
          {att.length === 0 && <li className="text-muted-foreground">Sin registros en el mes.</li>}
        </ul>
      </section>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Bitácora de la pizarra</h2>
        <form method="GET" className="flex items-end gap-2"><input type="date" name="date" defaultValue={date} className={input} /><button className="h-9 rounded-md border border-input px-3">Ver</button></form>
        <ul className="space-y-0.5">
          {log.map((l) => <li key={l.id}>{tm(l.at)} — {l.text}</li>)}
          {log.length === 0 && <li className="text-muted-foreground">Sin registros ese día.</li>}
        </ul>
      </section>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Visitas a la ludoteca</h2>
        <ul className="space-y-0.5">
          {sessions.map((s) => <li key={s.id}>{dt(s.checkInAt)} → {s.status === "OPEN" ? "en curso" : tm(s.checkOutAt)} · {s.contractedMinutes} min{s.amountCents != null ? ` · ${formatSoles(s.amountCents)}` : ""}</li>)}
          {sessions.length === 0 && <li className="text-muted-foreground">Sin visitas.</li>}
        </ul>
      </section>
      <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Incidencias</h2>
        <ul className="space-y-0.5">
          {inc.map((i) => <li key={i.id}>{i.date} · {i.area} · {TYPE[i.type]} — {i.description}</li>)}
          {inc.length === 0 && <li className="text-muted-foreground">Sin incidencias registradas.</li>}
        </ul>
      </section>
    </div>
  );
}
