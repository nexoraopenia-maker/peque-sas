import Link from "next/link";
import { requirePermission } from "@/lib/rbac";
import { hasPermission } from "@/lib/rbac/permissions";

export const dynamic = "force-dynamic";

export default async function MarketingPage() {
  const { user } = await requirePermission("coupons:view");
  const cards = [
    { href: "/marketing/coupons", title: "Cupones", text: "Descuentos por porcentaje o monto fijo con vigencia y límites.", show: true },
    { href: "/marketing/loyalty", title: "Puntos de fidelización", text: "Configuración del programa, saldos y movimientos por apoderado.", show: true },
    { href: "/marketing/campaigns", title: "Campañas por WhatsApp", text: "Segmentos con plantillas oficiales de Meta, solo a quienes dieron su consentimiento.", show: hasPermission(user.role, "marketing:manage") },
  ];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Marketing y fidelización</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.filter((c) => c.show).map((c) => (
          <Link key={c.href} href={c.href} className="rounded-lg border border-border bg-card p-4 hover:bg-accent">
            <p className="font-semibold">{c.title}</p><p className="mt-1 text-sm text-muted-foreground">{c.text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
