import Link from "next/link";

const TABS = [["", "Resumen"], ["/history", "Historial"], ["/finances", "Finanzas"], ["/reservations", "Reservas"]] as const;

export function ChildNav({ childId, name, active }: { childId: string; name: string; active: string }) {
  return (
    <div className="mb-4 space-y-2">
      <p className="text-sm"><Link href="/parent-portal" className="underline">← Mis hijos</Link></p>
      <h1 className="text-2xl font-bold">{name}</h1>
      <nav className="flex gap-2 text-sm">
        {TABS.map(([path, label]) => (
          <Link key={path} href={`/parent-portal/children/${childId}${path}`} className={`rounded-md border px-3 py-1 ${active === path ? "border-primary bg-accent" : "border-border"}`}>{label}</Link>
        ))}
      </nav>
    </div>
  );
}
