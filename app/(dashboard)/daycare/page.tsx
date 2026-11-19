import Link from "next/link";
import { requireModule, requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { tenantDb } from "@/lib/db/tenant";
import { limaDate } from "@/lib/utils/date";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Button } from "@/components/ui/button";
import { checkInAction, checkOutAction, markAbsentAction } from "@/actions/daycare";

export const dynamic = "force-dynamic";
const time = (d: Date | null) => (d ? d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" }) : "—");

export default async function DaycarePage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("daycare:attendance");
  const { e } = await searchParams;
  const tdb = tenantDb(tenantId);
  const today = limaDate();
  const [enrollments, attendances] = await Promise.all([
    tdb.enrollment.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      include: {
        child: {
          select: {
            fullName: true, allergies: true, medicalAlerts: true,
            guardians: { where: { canPickup: true }, include: { guardian: { select: { fullName: true } } } },
            authorizedPickups: { where: { isActive: true }, select: { id: true, fullName: true, relationship: true } },
          },
        },
      },
    }),
    tdb.daycareAttendance.findMany({ where: { date: today } }),
  ]);
  const byChild = new Map(attendances.map((a) => [a.childId, a]));
  const present = attendances.filter((a) => a.status === "PRESENT").length;
  const absent = attendances.filter((a) => a.status === "ABSENT").length;
  const late = attendances.filter((a) => a.lateMinutes > 0).length;
  const manage = hasPermission(user.role, "daycare:manage");
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Guardería · {today}</h1>
        <nav className="flex flex-wrap gap-3 text-sm underline">
          {manage && <Link href="/daycare/enrollments">Matrículas</Link>}
          <Link href="/daycare/attendance">Asistencia mensual</Link>
          <Link href="/daycare/incidents">Incidencias</Link>
          <Link href="/daycare/report">Reporte a padres</Link>
          {hasPermission(user.role, "teacherboard:use") && <Link href="/teachers/board">Pizarra →</Link>}
        </nav>
      </div>
      <ErrorBanner message={e} />
      <p className="text-sm text-muted-foreground">Matriculados {enrollments.length} · Presentes {present} · Ausentes {absent} · Tardanzas {late}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {enrollments.length === 0 && <li className="p-4 text-sm text-muted-foreground">No hay matrículas activas.</li>}
        {enrollments.map((en) => {
          const a = byChild.get(en.childId);
          const options = [
            ...en.child.guardians.map((g) => ({ v: `G:${g.guardianId}`, l: `${g.guardian.fullName} (apoderado)` })),
            ...en.child.authorizedPickups.map((p) => ({ v: `A:${p.id}`, l: `${p.fullName} (autorizado${p.relationship ? `, ${p.relationship}` : ""})` })),
          ];
          return (
            <li key={en.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">
                  <Link href={`/daycare/children/${en.childId}`} className="underline">{en.child.fullName}</Link>{" "}
                  <span className="text-xs text-muted-foreground">{en.entryTime}–{en.exitTime}</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {!a && "Sin registro hoy"}
                  {a?.status === "ABSENT" && "Ausente"}
                  {a?.status === "PRESENT" && `Ingreso ${time(a.checkInAt)}${a.lateMinutes ? ` (tardanza ${a.lateMinutes} min)` : ""}${a.checkOutAt ? ` · Salida ${time(a.checkOutAt)} · Retiró ${a.pickedUpBy}` : ""}`}
                </p>
                {(en.child.allergies || en.child.medicalAlerts) && <p className="text-sm text-amber-400">⚠ {[en.child.allergies, en.child.medicalAlerts].filter(Boolean).join(" · ")}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(!a || a.status === "ABSENT") && (
                  <form action={checkInAction}><input type="hidden" name="childId" value={en.childId} /><Button size="sm">Ingreso</Button></form>
                )}
                {!a && (
                  <form action={markAbsentAction}><input type="hidden" name="childId" value={en.childId} /><Button size="sm" variant="outline">Ausente</Button></form>
                )}
                {a?.status === "PRESENT" && !a.checkOutAt && (
                  <form action={checkOutAction} className="flex items-center gap-2">
                    <input type="hidden" name="attendanceId" value={a.id} />
                    <select name="pickup" required defaultValue="" className={sel}>
                      <option value="" disabled>¿Quién retira?</option>
                      {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                    <Button size="sm" variant="outline" disabled={options.length === 0}>Salida</Button>
                  </form>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
