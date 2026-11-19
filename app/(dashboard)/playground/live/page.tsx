import Link from "next/link";
import { requireModule, requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { tenantDb } from "@/lib/db/tenant";
import { elapsedMs, formatDuration, light, remainingMs } from "@/lib/playground/time";
import { formatSoles } from "@/lib/billing/money";
import { getOpenSession, quotePlayground, type PlaygroundQuote } from "@/lib/billing/service";
import { PromoFields } from "@/components/dashboard/promo-fields";
import { addConsumptionAction, checkOutAction } from "@/actions/playground";
import { IncidentForm } from "../forms";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { ErrorBanner } from "@/components/dashboard/banner";
import { PaymentFields } from "@/components/dashboard/payment-fields";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const COLORS = { green: "bg-green-500", yellow: "bg-yellow-400", red: "bg-red-500" } as const;
const LABEL = { green: "Con tiempo", yellow: "Por terminar", red: "Excedido" } as const;
const sel = "h-8 rounded-md border border-input bg-background px-2 text-sm";

export default async function LivePage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const mu = await requireModule("PLAYGROUND");
  const { user, tenantId } = await requirePermission("playground:use");
  const { e } = await searchParams;
  const canCharge = hasPermission(user.role, "cash:use");
  const tdb = tenantDb(tenantId);
  const [sessions, products, openCash] = await Promise.all([
    tdb.playgroundSession.findMany({
      where: { status: "OPEN" },
      orderBy: { checkInAt: "asc" },
      include: {
        child: {
          select: {
            fullName: true, allergies: true, medicalAlerts: true, prepaidMinutes: true,
            guardians: { where: { canPickup: true }, include: { guardian: { select: { fullName: true } } } },
            authorizedPickups: { where: { isActive: true }, select: { id: true, fullName: true, relationship: true } },
          },
        },
      },
    }),
    tdb.product.findMany({ where: { isActive: true, stock: { gt: 0 } }, orderBy: { name: "asc" } }),
    getOpenSession(tenantId),
  ]);
  const now = new Date();
  const quotes = new Map<string, PlaygroundQuote>(
    await Promise.all(sessions.map(async (s) => [s.id, await quotePlayground(tenantId, s.id, now)] as const)),
  );

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Ludoteca en vivo</h1>
        <p className="text-sm text-muted-foreground">
          Aforo {sessions.length}/{mu.tenant?.playgroundCapacity} · <Link href="/playground" className="underline">Registrar ingreso</Link> · <Link href="/playground/history" className="underline">Historial</Link>
        </p>
      </div>
      <ErrorBanner message={e} />
      {canCharge && !openCash && <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">No hay turno de caja abierto: no se puede cobrar la salida. <Link href="/cash-register" className="underline">Abrir turno</Link></p>}
      {sessions.length === 0 && <p className="text-sm text-muted-foreground">No hay menores presentes.</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {sessions.map((s) => {
          const l = light(s, now);
          const q = quotes.get(s.id)!;
          const options = [
            ...s.child.guardians.map((g) => ({ value: `G:${g.guardianId}`, label: `${g.guardian.fullName} (apoderado)` })),
            ...s.child.authorizedPickups.map((a) => ({ value: `A:${a.id}`, label: `${a.fullName} (autorizado${a.relationship ? `, ${a.relationship}` : ""})` })),
          ];
          return (
            <li key={s.id} className="space-y-2 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium">{s.child.fullName} <span className="text-xs text-muted-foreground">#{s.braceletCode}</span></p>
                <span className="flex items-center gap-2 text-sm"><span className={`inline-block size-3 rounded-full ${COLORS[l]}`} />{LABEL[l]}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Entrada {s.checkInAt.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" })} · Transcurrido {formatDuration(elapsedMs(s, now))} ·
                Contratado {s.contractedMinutes}m · {remainingMs(s, now) >= 0 ? "Restan" : "Excedido"} {formatDuration(Math.abs(remainingMs(s, now)))}
              </p>
              {(s.child.allergies || s.child.medicalAlerts) && <p className="text-sm text-amber-400">⚠ {[s.child.allergies, s.child.medicalAlerts].filter(Boolean).join(" · ")}</p>}
              <IncidentForm childId={s.childId} sessionId={s.id} />

              {canCharge && (
                <form action={addConsumptionAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="sessionId" value={s.id} />
                  <select name="productId" required className={sel}>{products.map((p) => <option key={p.id} value={p.id}>{p.name} · {formatSoles(p.priceCents)} ({p.stock})</option>)}</select>
                  <input name="quantity" type="number" min="1" defaultValue={1} className={sel + " w-16"} aria-label="Cantidad" />
                  <Button size="sm" variant="outline" disabled={products.length === 0}>Agregar consumo</Button>
                </form>
              )}

              <div className="rounded-md bg-muted/40 p-2 text-sm">
                {q.items.map((i, idx) => (
                  <p key={idx} className="flex justify-between"><span>{i.description}{i.quantity > 1 && i.kind !== "PREPAID_CREDIT" ? ` × ${i.quantity}` : ""}</span><span>{formatSoles(i.totalCents)}</span></p>
                ))}
                <p className="mt-1 flex justify-between border-t border-border pt-1 font-semibold"><span>Total a cobrar (hoy {now.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" })})</span><span>{formatSoles(q.totalCents)}</span></p>
                <p className="text-xs text-muted-foreground">
                  Cuponera: saldo {q.prepaidBalance} min{q.prepaidMinutesUsed > 0 ? ` · se descontarán ${q.prepaidMinutesUsed} min` : ""}. El importe final se recalcula al cobrar.
                </p>
              </div>

              {canCharge && (
                <form action={checkOutAction} className="space-y-2">
                  <input type="hidden" name="sessionId" value={s.id} />
                  <select name="pickup" required defaultValue="" className={sel}>
                    <option value="" disabled>¿Quién retira?</option>
                    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <PromoFields withGuardian={false} />
                  <PaymentFields />
                  <Button size="sm" disabled={options.length === 0 || !openCash}>Cobrar y dar salida</Button>
                  {options.length === 0 && <p className="text-xs text-amber-400">Sin apoderado ni persona autorizada a recoger</p>}
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
