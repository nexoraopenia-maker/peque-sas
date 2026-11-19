import { requireGuardian } from "@/lib/portal/auth";
import { childOverview, dayLog, recentNews, requireMyChild } from "@/lib/portal/data";
import { ChildNav } from "@/components/portal/child-nav";
import { limaDate } from "@/lib/utils/date";
import { elapsedMs, formatDuration, light, remainingMs } from "@/lib/playground/time";

export const dynamic = "force-dynamic";
const tm = (d: Date | null) => (d ? d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" }) : "—");
const DOT = { green: "🟢 Con tiempo", yellow: "🟡 Por terminar", red: "🔴 Tiempo excedido" } as const;

export default async function ChildPage({ params }: { params: Promise<{ childId: string }> }) {
  const g = await requireGuardian();
  const { childId } = await params;
  const mine = await requireMyChild({ id: g.id, tenantId: g.tenantId }, childId); // 404 si no es tu hijo
  const [o, log, news] = await Promise.all([childOverview(mine), dayLog(mine, limaDate()), recentNews(mine)]);
  const now = new Date();
  const p = o.profile;
  return (
    <div className="space-y-5">
      <ChildNav childId={childId} name={mine.fullName} active="" />

      <section className="space-y-1 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Estado actual</h2>
        {o.openPlayground ? (
          <p>🎈 En ludoteca desde las {tm(o.openPlayground.checkInAt)} · transcurrido {formatDuration(elapsedMs(o.openPlayground, now))} · {DOT[light(o.openPlayground, now)]}
            {remainingMs(o.openPlayground, now) > 0 ? ` · restan ${formatDuration(remainingMs(o.openPlayground, now))}` : ""}</p>
        ) : <p className="text-muted-foreground">No está en la ludoteca.</p>}
        {o.enrollment ? (
          o.attendance?.status === "PRESENT" ? <p>🏫 Guardería: ingresó a las {tm(o.attendance.checkInAt)}{o.attendance.lateMinutes ? ` (tardanza ${o.attendance.lateMinutes} min)` : ""}{o.attendance.checkOutAt ? ` · salió a las ${tm(o.attendance.checkOutAt)}` : " · presente ahora"}</p>
          : o.attendance?.status === "ABSENT" ? <p>🏫 Guardería: ausente hoy</p>
          : <p className="text-muted-foreground">🏫 Guardería (horario {o.enrollment.entryTime}–{o.enrollment.exitTime}): sin registro hoy.</p>
        ) : null}
      </section>

      {(o.child.allergies || o.child.medicalAlerts) && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <h2 className="font-semibold text-amber-300">⚠ Alergias y alertas médicas</h2>
          {o.child.allergies && <p>Alergias: {o.child.allergies}</p>}
          {o.child.medicalAlerts && <p>Alertas: {o.child.medicalAlerts}</p>}
        </section>
      )}

      <section className="space-y-1 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Ficha</h2>
        <p>Nacimiento: {o.child.birthDate ? o.child.birthDate.toISOString().slice(0, 10) : "—"}</p>
        {p ? (
          <>
            <p>Grupo sanguíneo: {p.bloodType ?? "—"} · Seguro: {p.insurance ?? "—"}</p>
            <p>Pediatra: {p.pediatrician ?? "—"}{p.pediatricianPhone ? ` (${p.pediatricianPhone})` : ""}</p>
            <p>Medicamentos: {p.medications ?? "—"}</p>
            <p>Alimentación: {p.dietaryNotes ?? "—"}</p>
            <p>Contacto de emergencia: {p.emergencyContactName ?? "—"}{p.emergencyContactPhone ? ` (${p.emergencyContactPhone})` : ""}</p>
            <p>Autorización de fotografías: {p.photoConsent ? "Sí" : "No"}</p>
          </>
        ) : <p className="text-muted-foreground">El establecimiento aún no completó la ficha médica.</p>}
        <p>Autorizados a recoger: {o.pickups.map((x) => `${x.fullName}${x.relationship ? ` (${x.relationship})` : ""}`).join(", ") || "solo los apoderados"}</p>
      </section>

      <section className="space-y-1 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Bitácora de hoy (guardería)</h2>
        <ul className="space-y-1">
          {log.map((l) => <li key={l.id}>{tm(l.at)} — {l.text}</li>)}
          {log.length === 0 && <li className="text-muted-foreground">Sin registros hoy.</li>}
        </ul>
      </section>

      <section className="space-y-1 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Novedades recientes</h2>
        <ul className="space-y-1">
          {news.map((n) => <li key={n.id}><span className="text-muted-foreground">{n.createdAt.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" })}</span> — {n.message}</li>)}
          {news.length === 0 && <li className="text-muted-foreground">Sin novedades.</li>}
        </ul>
      </section>
    </div>
  );
}
