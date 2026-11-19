import Link from "next/link";
import { requireModule, requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createIncidentAction } from "@/actions/daycare";

export const dynamic = "force-dynamic";
const TYPES = { FALL: "Caída", ALLERGY: "Alergia", BEHAVIOR: "Conducta", HEALTH: "Salud", OTHER: "Otro" } as const;

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  await requireModule("DAYCARE");
  const { tenantId } = await requirePermission("daycare:attendance");
  const { e } = await searchParams;
  const tdb = tenantDb(tenantId);
  const [enrolled, incidents] = await Promise.all([
    tdb.enrollment.findMany({ where: { status: "ACTIVE" }, include: { child: { select: { fullName: true } } } }),
    tdb.daycareIncident.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { child: { select: { fullName: true } } } }),
  ]);
  const sel = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Incidencias de guardería</h1><Link href="/daycare" className="underline">← Guardería</Link></div>
      <ErrorBanner message={e} />
      <form action={createIncidentAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-4">
        <select name="childId" required className={sel}>{enrolled.map((en) => <option key={en.childId} value={en.childId}>{en.child.fullName}</option>)}</select>
        <select name="type" className={sel}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <Input name="description" placeholder="Descripción" required className="sm:col-span-2" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="parentNotified" /> Se avisó al apoderado</label>
        <Button className="sm:col-span-3">Registrar incidencia</Button>
      </form>
      <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {incidents.map((i) => (
          <li key={i.id} className="p-3"><b>{i.child.fullName}</b> · {i.date} · {TYPES[i.type]} · {i.description} {i.parentNotified ? "· apoderado avisado" : ""}</li>
        ))}
        {incidents.length === 0 && <li className="p-3 text-muted-foreground">Sin incidencias.</li>}
      </ul>
    </div>
  );
}
