import { requireSuperAdmin } from "@/lib/rbac";
import { DemoForm } from "./form";

export const dynamic = "force-dynamic";
export default async function NewDemoPage() {
  await requireSuperAdmin();
  const d = new Date(Date.now() - 5 * 3600_000 + 14 * 86_400_000).toISOString().slice(0, 10);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold">Nueva cuenta demo</h1>
      <p className="text-sm text-muted-foreground">Crea un establecimiento de prueba con datos FICTICIOS (familias, productos de POS, tarifas de ludoteca, cuponeras, espacios y empleados) para demostraciones. Nunca uses datos reales de clientes.</p>
      <DemoForm defaultExpiry={d} />
    </div>
  );
}
