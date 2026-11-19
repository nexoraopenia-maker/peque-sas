"use server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, destroySession } from "@/lib/auth/session";
import { loginSchema } from "@/lib/validation/auth";

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const GENERIC = "Credenciales inválidas";

export async function loginAction(_prev: { error?: string } | undefined, form: FormData) {
  const parsed = loginSchema.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: GENERIC };

  const user = await db.user.findUnique({ where: { email: parsed.data.email }, include: { tenant: { select: { status: true, demoExpiresAt: true, suspensionSource: true } } } });
  if (!user || !user.isActive) return { error: GENERIC };
  if (user.lockedUntil && user.lockedUntil > new Date()) return { error: "Cuenta bloqueada temporalmente" };

  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    const fails = user.failedLogins + 1;
    await db.user.update({
      where: { id: user.id },
      data: { failedLogins: fails, lockedUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS) : null },
    });
    return { error: GENERIC };
  }

  // Tras validar la contraseña (no revela nada a quien no la conoce): avisar si el establecimiento no puede operar
  if (user.role !== "SUPERADMIN" && user.tenant) {
    if (user.tenant.status === "SUSPENDED") {
      // Impago: solo el propietario puede entrar (a /billing) para regularizar el pago
      if (user.tenant.suspensionSource === "BILLING") {
        if (user.role !== "OWNER") return { error: "La suscripción de este establecimiento está vencida. El propietario debe regularizar el pago para reactivar el acceso." };
      } else return { error: "El acceso de este establecimiento está suspendido. Contacta a soporte." };
    }
    if (user.tenant.status === "DEMO" && user.tenant.demoExpiresAt && user.tenant.demoExpiresAt < new Date()) return { error: "La demostración de este establecimiento venció. Contacta a soporte." };
  }
  await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  await db.auditLog.create({ data: { tenantId: user.tenantId, actorId: user.id, action: "auth.login" } });
  await createSession({ uid: user.id, sv: user.sessionVersion, sa: user.role === "SUPERADMIN" && user.tenantId === null });
  redirect(user.role === "SUPERADMIN" ? "/superadmin/dashboard" : user.tenant?.status === "SUSPENDED" ? "/billing" : "/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
