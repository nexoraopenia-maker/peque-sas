"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/rbac";
import { BillingError } from "@/lib/billing/errors";
import { createUserWithinLimit, setUserActiveWithinLimit } from "@/lib/plans/limits";
import { db } from "@/lib/db";
import { workerSchema } from "@/lib/validation/schemas";
import { generateTempPassword, hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";

type State = { error?: string; created?: { email: string; tempPassword: string } } | undefined;

export async function createWorkerAction(_p: State, form: FormData): Promise<State> {
  const { user, tenantId } = await requirePermission("users:manage");
  const parsed = workerSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Revisa los datos del formulario" };

  const tempPassword = generateTempPassword();
  let created;
  try {
    // El tope del plan se verifica y el usuario se crea en la misma transacción (sin carreras)
    created = await createUserWithinLimit(tenantId, { ...parsed.data, passwordHash: await hashPassword(tempPassword) });
  } catch (e) {
    if (e instanceof BillingError) return { error: e.message };
    throw e;
  }
  await audit({ tenantId, actorId: user.id, action: "user.create", entity: "User", entityId: created.id, metadata: { role: created.role } });
  revalidatePath("/settings/users");
  // La contraseña temporal se muestra una sola vez; no se almacena en claro.
  return { created: { email: created.email, tempPassword } };
}

export async function setWorkerActiveAction(form: FormData) {
  const { user, tenantId } = await requirePermission("users:manage");
  const id = String(form.get("id") ?? "");
  const active = form.get("active") === "true";
  if (id === user.id) return;
  let changed = false;
  try { changed = await setUserActiveWithinLimit(tenantId, id, active); }
  catch (e) { if (e instanceof BillingError) redirect(`/settings/users?e=${encodeURIComponent(e.message)}`); throw e; }
  if (changed) await audit({ tenantId, actorId: user.id, action: active ? "user.activate" : "user.deactivate", entity: "User", entityId: id });
  revalidatePath("/settings/users");
}
