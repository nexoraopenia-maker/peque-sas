import Link from "next/link";
import { requireModule, requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { tenantDb } from "@/lib/db/tenant";
import { CheckInForm, RateForm } from "./forms";
import { createPackageAction } from "@/actions/prepaid";
import { formatSoles } from "@/lib/billing/money";
import { ErrorBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default async function PlaygroundPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  await requireModule("PLAYGROUND");
  const { user, tenantId } = await requirePermission("playground:use");
  const { e } = await searchParams;
  const tdb = tenantDb(tenantId);
  const [children, rates, packages] = await Promise.all([
    tdb.child.findMany({ orderBy: { fullName: "asc" }, take: 500, select: { id: true, fullName: true, medicalAlerts: true, allergies: true } }),
    tdb.playgroundRate.findMany({ where: { isActive: true }, orderBy: { minutes: "asc" } }),
    tdb.prepaidPackage.findMany({ where: { isActive: true }, orderBy: { minutes: "asc" } }),
  ]);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Ludoteca</h1>
        <Link href="/playground/live" className="underline">Ver en vivo →</Link>
      </div>
      <ErrorBanner message={e} />
      {hasPermission(user.role, "settings:limited") && <section className="space-y-2"><h2 className="font-semibold">Tarifas</h2><RateForm /></section>}
      <ul className="text-sm text-muted-foreground">
        {rates.map((r) => <li key={r.id}>{r.name}: {r.minutes} min · S/ {(r.priceCents / 100).toFixed(2)} · extra S/ {(r.extraMinuteCents / 100).toFixed(2)}/min</li>)}
      </ul>
      {hasPermission(user.role, "settings:limited") && (
        <section className="space-y-2">
          <h2 className="font-semibold">Paquetes de cuponera</h2>
          <form action={createPackageAction} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-4">
            <Input name="name" placeholder="Nombre (ej. 300 min)" required />
            <Input name="minutes" type="number" min="1" placeholder="Minutos" required />
            <Input name="price" inputMode="decimal" placeholder="Precio S/" required />
            <Button>Crear paquete</Button>
          </form>
          <ul className="text-sm text-muted-foreground">{packages.map((p) => <li key={p.id}>{p.name}: {p.minutes} min · {formatSoles(p.priceCents)}</li>)}</ul>
        </section>
      )}
      <section className="space-y-2">
        <h2 className="font-semibold">Registrar ingreso</h2>
        <CheckInForm
          children={children.map((c) => ({ id: c.id, name: `${c.fullName}${c.medicalAlerts || c.allergies ? " ⚠" : ""}` }))}
          rates={rates.map((r) => ({ id: r.id, label: `${r.name} · S/ ${(r.priceCents / 100).toFixed(2)}` }))}
        />
      </section>
    </div>
  );
}
