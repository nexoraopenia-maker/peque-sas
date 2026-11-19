import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { ProductForm, MovementForm } from "./forms";

export default async function ProductsPage() {
  const { tenantId } = await requirePermission("inventory:manage");
  const products = await tenantDb(tenantId).product.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Inventario</h1>
      <ProductForm />
      <MovementForm products={products.map((p) => ({ id: p.id, name: p.name }))} />
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground"><tr><th className="p-2">Producto</th><th>SKU</th><th>Precio</th><th>Stock</th></tr></thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} className="border-t border-border">
              <td className="p-2">{p.name}</td>
              <td>{p.sku ?? "—"}</td>
              <td>S/ {(p.priceCents / 100).toFixed(2)}</td>
              <td className={p.stock <= p.minStock ? "font-bold text-amber-400" : ""}>{p.stock} {p.unit}{p.stock <= p.minStock && " ⚠"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
