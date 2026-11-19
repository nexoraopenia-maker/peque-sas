"use server";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/rbac";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { changePasswordSchema } from "@/lib/validation/schemas";
import { audit } from "@/lib/audit";

export async function changePasswordAction(_p: { error?: string } | undefined, form: FormData) {
  const user = await requireUser();
  const parsed = changePasswordSchema.safeParse({ current: form.get("current"), next: form.get("next"), confirm: form.get("confirm") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  if (!(await verifyPassword(parsed.data.current, user.passwordHash))) return { error: "Contraseña actual incorrecta" };

  let updated;
  try {
    updated = await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.next), mustChangePassword: false, sessionVersion: { increment: 1 } },
    });
    await audit({ tenantId: user.tenantId, actorId: user.id, action: "auth.password_change" });
    await createSession({ uid: updated.id, sv: updated.sessionVersion, sa: updated.role === "SUPERADMIN" && updated.tenantId === null });
  } catch (err) {
    // Sin datos sensibles en logs: solo tipo y mensaje del error (visible en Vercel → Logs)
    console.error("[password] cambio de contraseña falló:", err instanceof Error ? `${err.name}: ${err.message}` : "error desconocido");
    return { error: "No se pudo cambiar la contraseña. Inténtalo de nuevo; si persiste, contacta a soporte." };
  }
  redirect(updated.role === "SUPERADMIN" ? "/superadmin/dashboard" : "/dashboard");
}
