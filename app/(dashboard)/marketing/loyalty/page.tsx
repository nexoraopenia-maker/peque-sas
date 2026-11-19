import Link from "next/link";
import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { db } from "@/lib/db";
import { getLoyaltyConfig, loyaltyBalance } from "@/lib/marketing/loyalty";
import { saveLoyaltyAction } from "@/actions/marketing";
import { formatSoles } from "@/lib/billing/money";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const TYPE = { EARN: "Acreditado", REDEEM: "Canjeado", EXPIRE: "Vencido", ADJUST: "Ajuste" } as const;

export default async function LoyaltyPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string; q?: string }> }) {
  const { user, tenantId } = await requirePermission("coupons:view");
  const { e, ok, q } = await searchParams;
  const cfg = await getLoyaltyConfig(tenantId);
  const canConfig = hasPermission(user.role, "loyalty:configure");
  const term = (q ?? "").trim().slice(0, 40);
  const found = term
    ? await db.guardian.findMany({ where: { tenantId, OR: [{ dni: term }, { phoneDigits: term.replace(/\D/g, "") || "—" }, { fullName: { contains: term } }] }, take: 5, select: { id: true, fullName: true, dni: true, marketingConsent: true } })
    : [];
  const detail = found.length === 1 ? await loyaltyBalance(tenantId, found[0]!.id) : null;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Puntos de fidelización</h1><Link href="/marketing" className="underline">← Marketing</Link></div>
      <ErrorBanner message={e} /><OkBanner message={ok} />
      <section className="space-y-2 rounded-lg border border-border p-4">
        <h2 className="font-semibold">Reglas del programa</h2>
        {canConfig ? (
          <form action={saveLoyaltyAction} className="grid gap-2 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" name="enabled" defaultChecked={cfg.enabled} /> Programa activo</label>
            <label className="text-sm">Puntos por cada S/ 1.00 pagado<Input name="pointsPerSol" type="number" min="0" step="1" defaultValue={cfg.pointsPerSol} required /></label>
            <label className="text-sm">Vencen a los (días, 0 = nunca)<Input name="expiryDays" type="number" min="0" step="1" defaultValue={cfg.expiryDays} required /></label>
            <label className="text-sm">Valor de cada punto al canjear (S/)<Input name="pointValue" inputMode="decimal" defaultValue={(cfg.centsPerPoint / 100).toFixed(2)} required /></label>
            <label className="text-sm">Máximo canjeable por venta (%)<Input name="maxRedeemPercent" type="number" min="1" max="100" step="1" defaultValue={cfg.maxRedeemPercent} required /></label>
            <Button className="sm:col-span-3">Guardar</Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{cfg.enabled ? "Activo" : "Desactivado"} · {cfg.pointsPerSol} pto(s) por S/ 1.00 · vencen {cfg.expiryDays ? `a los ${cfg.expiryDays} días` : "nunca"} · cada punto vale {formatSoles(cfg.centsPerPoint)} · tope {cfg.maxRedeemPercent}% de la venta</p>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Consultar saldo de un apoderado</h2>
        <form method="GET" className="flex gap-2"><Input name="q" defaultValue={term} placeholder="DNI, teléfono o nombre" className="max-w-xs" /><Button variant="outline">Buscar</Button></form>
        {term && found.length === 0 && <p className="text-sm text-muted-foreground">Sin resultados.</p>}
        {found.length > 1 && <ul className="text-sm">{found.map((g) => <li key={g.id}><Link className="underline" href={`/marketing/loyalty?q=${g.dni ?? g.fullName}`}>{g.fullName}</Link></li>)}</ul>}
        {detail && found[0] && (
          <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">{found[0].fullName}</p>
            <p>Disponibles: <b>{detail.available}</b> · Por vencer en 30 días: {detail.expiringSoon}</p>
            <table className="w-full"><thead className="text-left text-muted-foreground"><tr><th>Fecha</th><th>Movimiento</th><th>Puntos</th><th>Saldo</th></tr></thead>
              <tbody>{detail.recent.map((m) => <tr key={m.id} className="border-t border-border"><td>{m.createdAt.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}</td><td>{TYPE[m.type]}</td><td>{m.points}</td><td>{m.balanceAfter}</td></tr>)}</tbody></table>
          </div>
        )}
      </section>
    </div>
  );
}
