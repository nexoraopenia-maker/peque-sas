"use server";
import { redirect } from "next/navigation";
import { loginWithCode, requireGuardian } from "@/lib/portal/auth";
import { setMarketingConsent } from "@/lib/marketing/consent";
import { revalidatePath } from "next/cache";
import { clearGuardianSession, setGuardianSession } from "@/lib/portal/session";
import { audit } from "@/lib/audit";
import { REQUEST_MESSAGE, requestCodeViaWhatsApp } from "@/lib/portal/self-service";

export async function parentLoginAction(_p: { error?: string } | undefined, form: FormData) {
  const r = await loginWithCode({
    portalCode: String(form.get("portalCode") ?? "").slice(0, 20),
    identifier: String(form.get("identifier") ?? "").slice(0, 40),
    code: String(form.get("code") ?? "").slice(0, 20),
  });
  if (!r.ok) return { error: r.error };
  await setGuardianSession(r.token);
  // El actor es un apoderado (no un usuario del personal): se registra sin actorId y con el id del apoderado
  await audit({ tenantId: r.token.tid, actorId: null, action: "portal.login", entity: "Guardian", entityId: r.token.gid });
  redirect("/parent-portal");
}

export async function parentLogoutAction() {
  await clearGuardianSession();
  redirect("/parent-portal/login");
}

/** Solicitud de código por WhatsApp: respuesta siempre genérica (no revela si el apoderado existe) y con límite de solicitudes. */
export async function requestCodeAction(_p: { message?: string } | undefined, form: FormData) {
  const r = await requestCodeViaWhatsApp({ portalCode: String(form.get("portalCode") ?? "").slice(0, 20), identifier: String(form.get("identifier") ?? "").slice(0, 40) });
  return { message: r.limited ? "Demasiadas solicitudes. Espera unos minutos o pide tu código en recepción." : REQUEST_MESSAGE };
}

/** El propio apoderado autoriza o revoca promociones (Ley 29733). El id sale de la sesión, nunca del formulario. */
export async function portalConsentAction(form: FormData) {
  const g = await requireGuardian();
  const granted = form.get("granted") === "1";
  const changed = await setMarketingConsent({ tenantId: g.tenantId, guardianId: g.id, granted, source: "PORTAL" });
  if (changed) await audit({ tenantId: g.tenantId, actorId: null, action: granted ? "consent.grant" : "consent.revoke", entity: "Guardian", entityId: g.id });
  revalidatePath("/parent-portal");
  redirect("/parent-portal");
}
