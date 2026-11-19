import Link from "next/link";
import { requireModule, requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { daysInMonth, isMonthString, limaDate } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireModule("DAYCARE");
  const { tenantId } = await requirePermission("daycare:attendance");
  const { month: m } = await searchParams;
  const month = m && isMonthString(m) ? m : limaDate().slice(0, 7);
  const n = daysInMonth(month);
  const tdb = tenantDb(tenantId);
  const records = await tdb.daycareAttendance.findMany({
    where: { date: { gte: `${month}-01`, lte: `${month}-${String(n).padStart(2, "0")}` } },
    include: { child: { select: { fullName: true } } },
  });
  const rows = new Map<string, { name: string; days: Map<number, string>; present: number; late: number; absent: number }>();
  for (const r of records) {
    const row = rows.get(r.childId) ?? { name: r.child.fullName, days: new Map(), present: 0, late: 0, absent: 0 };
    const day = Number(r.date.slice(8));
    if (r.status === "ABSENT") { row.days.set(day, "A"); row.absent++; }
    else { row.days.set(day, r.lateMinutes > 0 ? "T" : "P"); row.present++; if (r.lateMinutes > 0) row.late++; }
    rows.set(r.childId, row);
  }
  const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Asistencia {month}</h1><Link href="/daycare" className="underline">← Guardería</Link></div>
      <form method="GET" className="flex items-end gap-2">
        <input type="month" name="month" defaultValue={month} className="h-9 rounded-md border border-input bg-background px-3 text-sm" />
        <button className="h-9 rounded-md border border-input px-3 text-sm">Ver</button>
      </form>
      <p className="text-xs text-muted-foreground">P presente · T tardanza · A ausente (registrada) · — sin registro</p>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead><tr><th className="p-1 text-left">Menor</th>{Array.from({ length: n }, (_, i) => <th key={i} className="px-1">{i + 1}</th>)}<th className="px-2">P</th><th className="px-2">T</th><th className="px-2">A</th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.name} className="border-t border-border">
                <td className="whitespace-nowrap p-1">{r.name}</td>
                {Array.from({ length: n }, (_, i) => <td key={i} className="px-1 text-center">{r.days.get(i + 1) ?? "—"}</td>)}
                <td className="px-2 text-center">{r.present}</td><td className="px-2 text-center">{r.late}</td><td className="px-2 text-center">{r.absent}</td>
              </tr>
            ))}
            {list.length === 0 && <tr><td className="p-2 text-muted-foreground">Sin registros en el mes.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
