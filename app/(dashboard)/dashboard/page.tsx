import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";

export default async function DashboardPage() {
  const { tenantId } = await requirePermission("dashboard:view");
  const tdb = tenantDb(tenantId);
  const [guardians, children, products] = await Promise.all([
    tdb.guardian.count(),
    tdb.child.count(),
    tdb.product.findMany({ where: { isActive: true }, select: { stock: true, minStock: true } }),
  ]);
  const lowStock = products.filter((p) => p.stock <= p.minStock).length;
  const cards = [
    { label: "Apoderados", value: guardians },
    { label: "Menores registrados", value: children },
    { label: "Productos con stock bajo", value: lowStock },
  ];
  return (
    <>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="mt-1 text-sm text-muted-foreground">Ventas, caja y reservas se mostrarán al implementar sus módulos.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className="text-3xl font-bold">{c.value}</p>
          </div>
        ))}
      </div>
    </>
  );
}
