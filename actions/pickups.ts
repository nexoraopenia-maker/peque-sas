"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { authorizedPickupSchema } from "@/lib/validation/schemas";
import { audit } from "@/lib/audit";

type State = { error?: string; ok?: boolean } | undefined;

export async function addAuthorizedPickupAction(_p: State, form: FormData): Promise<State> {
  const { user, tenantId } = await requirePermission("families:write");
  const parsed = authorizedPickupSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Revisa los datos" };
  const tdb = tenantDb(tenantId);
  if (!(await tdb.child.findFirst({ where: { id: parsed.data.childId } }))) return { error: "Menor no válido" };
  const p = await tdb.authorizedPickup.create({ data: { ...parsed.data, createdById: user.id } as never });
  await audit({ tenantId, actorId: user.id, action: "pickup.authorize", entity: "AuthorizedPickup", entityId: p.id });
  revalidatePath("/families");
  return { ok: true };
}

export async function revokeAuthorizedPickupAction(form: FormData) {
  const { user, tenantId } = await requirePermission("families:write");
  const id = String(form.get("id") ?? "");
  const r = await tenantDb(tenantId).authorizedPickup.updateMany({ where: { id }, data: { isActive: false } });
  if (r.count) await audit({ tenantId, actorId: user.id, action: "pickup.revoke", entity: "AuthorizedPickup", entityId: id });
  revalidatePath("/families");
}
