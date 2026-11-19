import { requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { setWorkerActiveAction } from "@/actions/workers";
import { WorkerForm } from "./form";

export default async function UsersPage() {
  const { user, tenantId } = await requirePermission("users:manage");
  const users = await db.user.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Trabajadores</h1>
      <WorkerForm />
      <ul className="divide-y divide-border rounded-lg border border-border">
        {users.map((u) => (
          <li key={u.id} className="flex items-center justify-between p-4">
            <div>
              <p className="font-medium">{u.name} {!u.isActive && <span className="text-xs text-red-400">(inactivo)</span>}</p>
              <p className="text-sm text-muted-foreground">{u.email} · {u.role}</p>
            </div>
            {u.id !== user.id && u.role !== "OWNER" && (
              <form action={setWorkerActiveAction}>
                <input type="hidden" name="id" value={u.id} />
                <input type="hidden" name="active" value={String(!u.isActive)} />
                <button className="text-sm underline">{u.isActive ? "Desactivar" : "Reactivar"}</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
