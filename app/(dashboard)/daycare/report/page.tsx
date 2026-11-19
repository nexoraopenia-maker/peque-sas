import Link from "next/link";
import { requireModule, requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { describeLog } from "@/lib/daycare/log";
import { isDateString, limaDate } from "@/lib/utils/date";

export const dynamic = "force-dynamic";
const t = (d: Date) => d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" });

// Vista previa de lo que verán los padres: solo registros marcados como visibles.
export default async function ReportPage({ searchParams }: { searchParams: Promise<{ childId?: string; date?: string }> }) {
  await requireModule("DAYCARE");
  const { tenantId } = await requirePermission("daycare:attendance");
  const q = await searchParams;
  const date = q.date && isDateString(q.date) ? q.date : limaDate();
  const tdb = tenantDb(tenantId);
  const enrolled = await tdb.enrollment.findMany({ where: { status: "ACTIVE" }, include: { child: { select: { fullName: true } } } });
  const childId = q.childId && enrolled.some((e) => e.childId === q.childId) ? q.childId : enrolled[0]?.childId;
  const [att, logs] = childId
    ? await Promise.all([
        tdb.daycareAttendance.findFirst({ where: { childId, date } }),
        tdb.daycareLog.findMany({ where: { childId, date, visibleToParents: true }, orderBy: { occurredAt: "asc" } }),
      ])
    : [null, []];
  const input = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Reporte diario</h1><Link href="/daycare" className="underline">← Guardería</Link></div>
      <form method="GET" className="flex flex-wrap items-end gap-2">
        <select name="childId" defaultValue={childId} className={input}>{enrolled.map((e) => <option key={e.childId} value={e.childId}>{e.child.fullName}</option>)}</select>
        <input type="date" name="date" defaultValue={date} className={input} />
        <button className="h-9 rounded-md border border-input px-3 text-sm">Ver</button>
      </form>
      <section className="rounded-lg border border-border p-4 text-sm">
        <p className="font-medium">{att?.status === "PRESENT" ? `Asistió · ingreso ${att.checkInAt ? t(att.checkInAt) : "—"}${att.checkOutAt ? ` · salida ${t(att.checkOutAt)}` : ""}` : att?.status === "ABSENT" ? "Ausente" : "Sin registro de asistencia"}</p>
        <ul className="mt-2 space-y-1">
          {logs.map((l) => <li key={l.id}>{t(l.occurredAt)} — {describeLog(l as never)}</li>)}
          {logs.length === 0 && <li className="text-muted-foreground">Sin registros para este día.</li>}
        </ul>
      </section>
    </div>
  );
}
