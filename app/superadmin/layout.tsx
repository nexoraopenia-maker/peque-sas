import Link from "next/link";
import { requireSuperAdmin } from "@/lib/rbac";
import { logoutAction } from "@/actions/auth";

export const dynamic = "force-dynamic";

// Contexto administrativo global, separado del panel de los establecimientos. Sin datos de menores ni de familias.
export default async function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSuperAdmin();
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-3 text-sm">
        <b>PequesSaaS · SuperAdmin</b>
        <Link href="/superadmin/dashboard" className="underline">Panel</Link>
        <Link href="/superadmin/demos/new" className="underline">Nueva demo</Link>
        <span className="ml-auto text-muted-foreground">{user.name}</span>
        <form action={logoutAction}><button className="underline">Cerrar sesión</button></form>
      </header>
      <main className="p-4 md:p-8">{children}</main>
    </div>
  );
}
