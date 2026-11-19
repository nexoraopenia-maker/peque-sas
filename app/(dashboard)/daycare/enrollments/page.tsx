import Link from "next/link";
import { requireModule, requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { limaDate } from "@/lib/utils/date";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { closeEnrollmentAction, createEnrollmentAction } from "@/actions/daycare";

export const dynamic = "force-dynamic";
const STATUS = { ACTIVE: "Activa", ENDED: "Finalizada", CANCELLED: "Anulada" } as const;

export default async function EnrollmentsPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  await requireModule("DAYCARE");
  const { tenantId } = await requirePermission("daycare:manage");
  const { e } = await searchParams;
  const tdb = tenantDb(tenantId);
  const [children, enrollments] = await Promise.all([
    tdb.child.findMany({ orderBy: { fullName: "asc" }, take: 500, select: { id: true, fullName: true } }),
    tdb.enrollment.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200, include: { child: { select: { fullName: true } } } }),
  ]);
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Matrículas</h1><Link href="/daycare" className="underline">← Guardería</Link></div>
      <ErrorBanner message={e} />
      <form action={createEnrollmentAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-4">
        <select name="childId" required className={sel}>{children.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}</select>
        <Input name="schoolYear" type="number" defaultValue={new Date().getFullYear()} required />
        <Input name="startDate" type="date" defaultValue={limaDate()} required />
        <Input name="monthlyFeeCents" type="number" step="0.01" min="0" placeholder="Mensualidad S/" required />
        <label className="text-sm">Entrada <Input name="entryTime" type="time" defaultValue="08:00" required /></label>
        <label className="text-sm">Salida <Input name="exitTime" type="time" defaultValue="17:00" required /></label>
        <Button className="sm:col-span-2 self-end">Matricular</Button>
      </form>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {enrollments.map((en) => (
          <li key={en.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
            <span><b>{en.child.fullName}</b> · {en.schoolYear} · desde {en.startDate}{en.endDate ? ` hasta ${en.endDate}` : ""} · {en.entryTime}–{en.exitTime} · S/ {(en.monthlyFeeCents / 100).toFixed(2)}/mes · {STATUS[en.status]}</span>
            {en.status === "ACTIVE" && (
              <span className="flex gap-3">
                <form action={closeEnrollmentAction}><input type="hidden" name="id" value={en.id} /><input type="hidden" name="status" value="ENDED" /><button className="underline">Finalizar</button></form>
                <form action={closeEnrollmentAction}><input type="hidden" name="id" value={en.id} /><input type="hidden" name="status" value="CANCELLED" /><button className="underline">Anular</button></form>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
