import Link from "next/link";
import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { tenantDb } from "@/lib/db/tenant";
import { limaDate } from "@/lib/utils/date";
import { addDays } from "@/lib/reservations/calendar";
import { balanceCents, SERVICE_LABEL } from "@/lib/reservations/status";
import { formatSoles } from "@/lib/billing/money";
import { reservationStatusAction } from "@/actions/reservations";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

// Recordatorios MANUALES: el envío automático por WhatsApp depende de la Fase 11.
export default async function RemindersPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { user, tenantId } = await requirePermission("reservations:read");
  const { e } = await searchParams;
  const today = limaDate();
  const rows = await tenantDb(tenantId).reservation.findMany({
    where: { status: { in: ["PENDING", "CONFIRMED"] }, date: { gte: today, lte: addDays(today, 2) } },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  const canWrite = hasPermission(user.role, "reservations:write");
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Recordatorios</h1><Link href="/reservations" className="underline">← Calendario</Link></div>
      <ErrorBanner message={e} />
      <p className="text-sm text-muted-foreground">Reservas de hoy y los próximos 2 días. El envío automático por WhatsApp se habilitará en la Fase 11; por ahora se avisa por teléfono y se marca aquí.</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <span><Link href={`/reservations/${r.id}`} className="underline"><b>{r.date} {r.startTime}</b> {SERVICE_LABEL[r.serviceType]}</Link> · {r.contactName}{r.contactPhone ? ` · ${r.contactPhone}` : ""} · saldo {formatSoles(balanceCents(r))} · {r.reminderSentAt ? "✔ recordado" : "⏳ por recordar"}</span>
            {canWrite && !r.reminderSentAt && (
              <form action={reservationStatusAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="op" value="remind" /><input type="hidden" name="back" value="reminders" /><Button size="sm" variant="outline">Marcar como recordado</Button></form>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="p-3 text-muted-foreground">No hay reservas próximas.</li>}
      </ul>
    </div>
  );
}
