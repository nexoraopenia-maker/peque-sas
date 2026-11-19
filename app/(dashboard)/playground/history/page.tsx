import Link from "next/link";
import { z } from "zod";
import { requireModule, requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";

export const dynamic = "force-dynamic";

const q = z.object({
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  childId: z.string().max(64).optional().catch(undefined),
});
// Perú no tiene horario de verano: UTC-5 fijo
const peru = (d: string, end = false) => new Date(`${d}T${end ? "23:59:59.999" : "00:00:00.000"}-05:00`);
const fmt = (d: Date | null) =>
  d ? d.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }) : "—";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireModule("PLAYGROUND");
  const { tenantId } = await requirePermission("playground:use");
  const f = q.parse(await searchParams);
  const tdb = tenantDb(tenantId);

  const [children, sessions] = await Promise.all([
    tdb.child.findMany({ orderBy: { fullName: "asc" }, take: 500, select: { id: true, fullName: true } }),
    tdb.playgroundSession.findMany({
      where: {
        ...(f.childId ? { childId: f.childId } : {}),
        ...(f.from || f.to
          ? { checkInAt: { ...(f.from ? { gte: peru(f.from) } : {}), ...(f.to ? { lte: peru(f.to, true) } : {}) } }
          : {}),
      },
      orderBy: { checkInAt: "desc" },
      take: 200,
      include: { child: { select: { fullName: true } } },
    }),
  ]);
  const incidents = await tdb.playgroundIncident.findMany({
    where: { sessionId: { in: sessions.map((s) => s.id) } },
    select: { sessionId: true, type: true, description: true },
  });
  const bySession = new Map<string, typeof incidents>();
  for (const i of incidents) bySession.set(i.sessionId!, [...(bySession.get(i.sessionId!) ?? []), i]);
  const total = sessions.reduce((n, s) => n + (s.amountCents ?? 0), 0);
  const input = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Historial de ludoteca</h1>
        <Link href="/playground/live" className="underline">← En vivo</Link>
      </div>
      <form method="GET" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">Desde <input type="date" name="from" defaultValue={f.from} className={input} /></label>
        <label className="text-sm">Hasta <input type="date" name="to" defaultValue={f.to} className={input} /></label>
        <label className="text-sm">
          Menor{" "}
          <select name="childId" defaultValue={f.childId ?? ""} className={input}>
            <option value="">Todos</option>
            {children.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
          </select>
        </label>
        <button className="h-9 rounded-md border border-input px-3 text-sm">Filtrar</button>
      </form>
      <p className="text-sm text-muted-foreground">
        {sessions.length} sesiones · Importe de sesiones cerradas: S/ {(total / 100).toFixed(2)}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr><th className="p-2">Menor</th><th>Entrada</th><th>Salida</th><th>Contratado</th><th>Importe</th><th>Retiró</th><th>Incidencias</th></tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-t border-border align-top">
                <td className="p-2">{s.child.fullName}</td>
                <td>{fmt(s.checkInAt)}</td>
                <td>{s.status === "OPEN" ? "En curso" : fmt(s.checkOutAt)}</td>
                <td>{s.contractedMinutes}m</td>
                <td>{s.amountCents == null ? "—" : `S/ ${(s.amountCents / 100).toFixed(2)}`}</td>
                <td>{s.pickedUpBy ?? "—"}</td>
                <td>{(bySession.get(s.id) ?? []).map((i) => `${i.type}: ${i.description}`).join(" | ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
