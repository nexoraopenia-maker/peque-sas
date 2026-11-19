import Link from "next/link";
import { logoutAction } from "@/actions/auth";
import { tenantHasModule, type ModuleKey } from "@/lib/plans/modules";
import { hasPermission, type Role, type Permission } from "@/lib/rbac/permissions";
import type { Feature } from "@/lib/plans/pure";

const ITEMS: { href: string; label: string; perm: Permission; module?: ModuleKey; feature?: Feature }[] = [
  { href: "/dashboard", label: "Dashboard", perm: "dashboard:view" },
  { href: "/families", label: "Familias", perm: "families:read" },
  { href: "/playground", label: "Ludoteca", perm: "playground:use", module: "PLAYGROUND" },
  { href: "/daycare", label: "Guardería", perm: "daycare:attendance", module: "DAYCARE" },
  { href: "/teachers/board", label: "Pizarra", perm: "teacherboard:use", module: "DAYCARE" },
  { href: "/reservations", label: "Reservas", perm: "reservations:read" },
  { href: "/cash-register", label: "Caja", perm: "cash:use" },
  { href: "/subscriptions", label: "Mensualidades", perm: "cash:use", module: "DAYCARE" },
  { href: "/products", label: "Inventario", perm: "inventory:manage" },
  { href: "/expenses", label: "Gastos", perm: "expenses:record" },
  { href: "/reports", label: "Reportes", perm: "reports:view", feature: "REPORTS" },
  { href: "/reports/invoices", label: "Comprobantes", perm: "sunat:manage" },
  { href: "/marketing", label: "Marketing", perm: "coupons:view" },
  { href: "/whatsapp/inbox", label: "Bandeja WhatsApp", perm: "whatsapp:use", feature: "WHATSAPP" },
  { href: "/settings/whatsapp", label: "WhatsApp", perm: "whatsapp:configure", feature: "WHATSAPP" },
  { href: "/settings/whatsapp/bot", label: "Chatbot", perm: "whatsapp:configure", feature: "WHATSAPP" },
  { href: "/billing", label: "Suscripción", perm: "settings:manage" },
  { href: "/settings/sunat", label: "Facturación SUNAT", perm: "settings:manage", feature: "SUNAT" },
  { href: "/settings/portal", label: "Portal de padres", perm: "settings:limited" },
  { href: "/settings/users", label: "Trabajadores", perm: "users:manage" },
];

export function Sidebar({ role, tenantName, userName, modules, features }: { role: Role; tenantName: string; userName: string; modules: unknown; features: Record<Feature, boolean> }) {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 border-b border-border p-4 md:min-h-screen md:w-60 md:border-r md:border-b-0">
      <div>
        <p className="font-bold">PequesSaaS</p>
        <p className="text-sm text-muted-foreground">{tenantName}</p>
      </div>
      <nav className="flex flex-wrap gap-1 md:flex-col">
        {ITEMS.filter((i) => hasPermission(role, i.perm) && (!i.module || tenantHasModule(modules, i.module)) && (!i.feature || features[i.feature])).map((i) => (
          <Link key={i.href} href={i.href} className="rounded-md px-3 py-2 text-sm hover:bg-accent">{i.label}</Link>
        ))}
      </nav>
      <form action={logoutAction} className="mt-auto text-sm">
        <p className="text-muted-foreground">{userName} · {role}</p>
        <button className="underline">Cerrar sesión</button>
      </form>
    </aside>
  );
}
