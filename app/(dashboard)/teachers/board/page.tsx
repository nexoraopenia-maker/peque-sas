import { requireModule, requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { tenantDb } from "@/lib/db/tenant";
import { limaDate } from "@/lib/utils/date";
import { describeLog, LEVELS, SUBTYPES } from "@/lib/daycare/log";
import { addLogAction, endNapAction, startNapAction } from "@/actions/teacherboard";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { ErrorBanner } from "@/components/dashboard/banner";

export const dynamic = "force-dynamic";
const tm = (d: Date) => d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" });
const EMOJI: Record<string, string> = { HAPPY: "😀", CALM: "🙂", TIRED: "😴", UPSET: "😟", SICK: "🤒" };
// Botones grandes (≥48 px) para uso táctil en tablet
const BTN = "min-h-12 min-w-24 flex-1 rounded-xl border border-border bg-card px-3 py-2 text-base font-medium active:scale-95 active:bg-accent";

function LogBtn({ childId, kind, subtype, level, label }: { childId: string; kind: string; subtype?: string; level?: string; label: string }) {
  return (
    <form action={addLogAction} className="flex">
      <input type="hidden" name="childId" value={childId} />
      <input type="hidden" name="kind" value={kind} />
      {subtype && <input type="hidden" name="subtype" value={subtype} />}
      {level && <input type="hidden" name="level" value={level} />}
      <button className={BTN}>{label}</button>
    </form>
  );
}

export default async function BoardPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  await requireModule("DAYCARE");
  const { tenantId } = await requirePermission("teacherboard:use");
  const { e } = await searchParams;
  const tdb = tenantDb(tenantId);
  const date = limaDate();
  const present = await tdb.daycareAttendance.findMany({
    where: { date, status: "PRESENT", checkInAt: { not: null }, checkOutAt: null },
    orderBy: { checkInAt: "asc" },
    include: { child: { select: { fullName: true, allergies: true, medicalAlerts: true } } },
  });
  const logs = await tdb.daycareLog.findMany({ where: { date, childId: { in: present.map((p) => p.childId) } }, orderBy: { occurredAt: "desc" } });
  const users = await db.user.findMany({ where: { tenantId }, select: { id: true, name: true } });
  const who = new Map(users.map((u) => [u.id, u.name]));

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={60} />
      <h1 className="text-2xl font-bold">Pizarra · {present.length} presentes</h1>
      <ErrorBanner message={e} />
      {present.length === 0 && <p className="text-muted-foreground">No hay menores presentes. Registra el ingreso en Guardería.</p>}
      <div className="grid gap-4 xl:grid-cols-2">
        {present.map((p) => {
          const mine = logs.filter((l) => l.childId === p.childId);
          const nap = mine.find((l) => l.kind === "NAP" && !l.endedAt);
          return (
            <section key={p.id} className="space-y-3 rounded-2xl border border-border p-4">
              <header>
                <h2 className="text-xl font-bold">{p.child.fullName}</h2>
                {(p.child.allergies || p.child.medicalAlerts) && (
                  <p className="mt-1 rounded-lg bg-amber-500/15 p-2 text-base font-semibold text-amber-300">⚠ {[p.child.allergies, p.child.medicalAlerts].filter(Boolean).join(" · ")}</p>
                )}
              </header>

              <div>
                <p className="mb-1 text-sm text-muted-foreground">Siesta</p>
                {nap ? (
                  <form action={endNapAction} className="flex items-center gap-3">
                    <input type="hidden" name="childId" value={p.childId} />
                    <span>😴 Durmiendo desde {tm(nap.occurredAt)}</span>
                    <button className={BTN}>Despertó</button>
                  </form>
                ) : (
                  <form action={startNapAction} className="flex"><input type="hidden" name="childId" value={p.childId} /><button className={BTN}>😴 Se durmió</button></form>
                )}
              </div>

              <details>
                <summary className="min-h-12 cursor-pointer py-3 text-base font-medium">🍽 Alimentación</summary>
                {Object.entries(SUBTYPES.MEAL).map(([k, label]) => (
                  <div key={k} className="mb-2">
                    <p className="text-sm text-muted-foreground">{label}</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(LEVELS).map(([lv, ll]) => <LogBtn key={lv} childId={p.childId} kind="MEAL" subtype={k} level={lv} label={ll} />)}
                    </div>
                  </div>
                ))}
              </details>

              <div>
                <p className="mb-1 text-sm text-muted-foreground">Pañal</p>
                <div className="flex flex-wrap gap-2">{Object.entries(SUBTYPES.DIAPER).map(([k, l]) => <LogBtn key={k} childId={p.childId} kind="DIAPER" subtype={k} label={l} />)}</div>
              </div>
              <div>
                <p className="mb-1 text-sm text-muted-foreground">Higiene</p>
                <div className="flex flex-wrap gap-2">{Object.entries(SUBTYPES.HYGIENE).map(([k, l]) => <LogBtn key={k} childId={p.childId} kind="HYGIENE" subtype={k} label={l} />)}</div>
              </div>
              <div>
                <p className="mb-1 text-sm text-muted-foreground">Estado de ánimo</p>
                <div className="flex flex-wrap gap-2">{Object.entries(SUBTYPES.MOOD).map(([k, l]) => <LogBtn key={k} childId={p.childId} kind="MOOD" subtype={k} label={`${EMOJI[k]} ${l}`} />)}</div>
              </div>
              <form action={addLogAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="childId" value={p.childId} /><input type="hidden" name="kind" value="NOTE" />
                <input name="notes" required minLength={2} maxLength={500} placeholder="Observación" className="min-h-12 flex-1 rounded-xl border border-input bg-transparent px-3 text-base" />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="visible" defaultChecked className="size-5" /> Visible a padres</label>
                <button className={BTN + " flex-none"}>Guardar</button>
              </form>

              <ul className="space-y-1 border-t border-border pt-2 text-sm">
                {mine.slice(0, 6).map((l) => <li key={l.id}>{tm(l.occurredAt)} — {describeLog(l as never)} <span className="text-muted-foreground">· {who.get(l.recordedById) ?? "—"}</span></li>)}
                {mine.length === 0 && <li className="text-muted-foreground">Sin registros hoy.</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
