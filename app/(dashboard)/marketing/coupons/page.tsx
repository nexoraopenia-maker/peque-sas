import Link from "next/link";
import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";
import { listCoupons } from "@/lib/marketing/coupons";
import { formatSoles } from "@/lib/billing/money";
import { createCouponAction, toggleCouponAction } from "@/actions/marketing";
import { ErrorBanner, OkBanner } from "@/components/dashboard/banner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
const day = (d: Date | null) => (d ? d.toLocaleDateString("es-PE", { timeZone: "America/Lima" }) : "—");

export default async function CouponsPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { user, tenantId } = await requirePermission("coupons:view");
  const { e, ok } = await searchParams;
  const canManage = hasPermission(user.role, "coupons:manage");
  const coupons = await listCoupons(tenantId);
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Cupones</h1><Link href="/marketing" className="underline">← Marketing</Link></div>
      <ErrorBanner message={e} /><OkBanner message={ok} />
      {!canManage && <p className="text-sm text-muted-foreground">Solo el propietario y los administradores pueden crear o modificar cupones. Aquí puedes consultarlos; se aplican al cobrar en Caja.</p>}
      {canManage && (
        <form action={createCouponAction} className="grid gap-2 rounded-lg border border-border p-4 sm:grid-cols-3">
          <label className="text-sm">Código<Input name="code" required minLength={3} maxLength={32} placeholder="VERANO10" /></label>
          <label className="text-sm">Tipo<select name="type" className={sel + " w-full"}><option value="PERCENTAGE">Porcentaje (%)</option><option value="FIXED_CENTS">Monto fijo (S/)</option></select></label>
          <label className="text-sm">Valor (% entero o S/)<Input name="value" required inputMode="decimal" placeholder="10" /></label>
          <label className="text-sm">Vigente desde<Input name="validFrom" type="date" /></label>
          <label className="text-sm">Vigente hasta<Input name="validUntil" type="date" /></label>
          <label className="text-sm">Compra mínima (S/)<Input name="minPurchase" inputMode="decimal" defaultValue="0.00" /></label>
          <label className="text-sm">Límite global de usos<Input name="maxUses" type="number" min="1" placeholder="Sin límite" /></label>
          <label className="text-sm">Límite por familia<Input name="maxUsesPerGuardian" type="number" min="1" placeholder="Sin límite" /></label>
          <label className="text-sm">Descripción<Input name="description" maxLength={200} /></label>
          <Button className="sm:col-span-3">Crear cupón</Button>
        </form>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground"><tr><th className="p-2">Código</th><th>Descuento</th><th>Vigencia</th><th>Mínimo</th><th>Usos</th><th>Por familia</th><th>Estado</th>{canManage && <th />}</tr></thead>
          <tbody>
            {coupons.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="p-2 font-mono">{c.code}</td>
                <td>{c.type === "PERCENTAGE" ? `${c.value}%` : formatSoles(c.value)}</td>
                <td>{day(c.validFrom)} → {day(c.validUntil)}</td>
                <td>{c.minPurchaseCents ? formatSoles(c.minPurchaseCents) : "—"}</td>
                <td>{c.usesCount}{c.maxUses ? ` / ${c.maxUses}` : ""}</td>
                <td>{c.maxUsesPerGuardian ?? "—"}</td>
                <td>{c.isActive ? "Activo" : "Desactivado"}</td>
                {canManage && <td><form action={toggleCouponAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="active" value={c.isActive ? "0" : "1"} /><button className="underline">{c.isActive ? "Desactivar" : "Activar"}</button></form></td>}
              </tr>
            ))}
            {coupons.length === 0 && <tr><td className="p-2 text-muted-foreground">Aún no hay cupones.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
