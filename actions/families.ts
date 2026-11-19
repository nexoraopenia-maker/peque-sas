"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { familySchema } from "@/lib/validation/schemas";
import { audit } from "@/lib/audit";
import { guardianIdentity } from "@/lib/portal/identity";

export async function createFamilyAction(_p: { error?: string; ok?: boolean } | undefined, form: FormData) {
  const { user, tenantId } = await requirePermission("families:write");
  const parsed = familySchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Revisa los datos del formulario" };
  const d = parsed.data;
  const tdb = tenantDb(tenantId);

  const childId = await tdb.$transaction(async (tx) => {
    const guardian = await tx.guardian.create({
      data: { fullName: d.guardianName, ...guardianIdentity({ dni: d.guardianDni, phone: d.guardianPhone }), phone: d.guardianPhone, email: d.guardianEmail } as never,
    });
    const child = await tx.child.create({
      data: { fullName: d.childName, birthDate: d.childBirthDate, allergies: d.allergies, medicalAlerts: d.medicalAlerts } as never,
    });
    await tx.childGuardian.create({
      data: { childId: child.id, guardianId: guardian.id, relationship: d.relationship, canPickup: true, isEmergencyContact: true } as never,
    });
    return child.id;
  });

  await audit({ tenantId, actorId: user.id, action: "family.create", entity: "Child", entityId: childId });
  revalidatePath("/families");
  return { ok: true };
}
