"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { PortalError, issueAccessCode, revokeGuardianAccess } from "@/lib/portal/auth";
import { generatePortalCode } from "@/lib/portal/identity";
import { audit } from "@/lib/audit";
import { describeSendFailure, notifyPortalCode } from "@/lib/whatsapp/notify";

const BACK = "/settings/portal";

export async function setPortalAction(form: FormData) {
  const { user, tenantId } = await requirePermission("settings:limited");
  const op = String(form.get("op") ?? "");
  if (op === "disable") {
    await db.tenant.update({ where: { id: tenantId }, data: { portalEnabled: false } });
  } else if (op === "enable" || op === "regenerate") {
    for (let i = 0; i < 5; i++) {
      try {
        await db.tenant.update({ where: { id: tenantId }, data: { portalEnabled: true, portalCode: generatePortalCode() } });
        break;
      } catch (e) { if (i === 4 || !/UNIQUE|constraint/i.test(String(e))) throw e; }
    }
  } else return;
  await audit({ tenantId, actorId: user.id, action: `portal.${op}` });
  revalidatePath(BACK);
}

type IssueState = { error?: string; code?: string; guardianName?: string; minutes?: number; portalCode?: string; whatsapp?: string } | undefined;

/** El código se devuelve UNA vez en la respuesta (no en la URL) para que el personal se lo entregue al apoderado. */
export async function issueAccessCodeAction(_p: IssueState, form: FormData): Promise<IssueState> {
  const { user, tenantId } = await requirePermission("families:write");
  try {
    const r = await issueAccessCode({ tenantId, guardianId: String(form.get("guardianId") ?? ""), createdById: user.id });
    await audit({ tenantId, actorId: user.id, action: "portal.code.issue", entity: "Guardian", entityId: String(form.get("guardianId")) });
    let whatsapp: string | undefined;
    if (form.get("sendWhatsApp") === "on") {
      const w = await notifyPortalCode({ tenantId, guardianId: String(form.get("guardianId")), code: r.code, minutes: 15, sentById: user.id });
      whatsapp = w.ok ? "Enviado por WhatsApp al teléfono registrado" : `No se envió por WhatsApp: ${describeSendFailure(w)}`;
    }
    return { code: r.code, guardianName: r.guardianName, minutes: 15, portalCode: r.portalCode, whatsapp };
  } catch (e) {
    if (e instanceof PortalError) return { error: e.message };
    throw e;
  }
}

export async function revokeAccessAction(form: FormData) {
  const { user, tenantId } = await requirePermission("families:write");
  const guardianId = String(form.get("guardianId") ?? "");
  try { await revokeGuardianAccess(tenantId, guardianId); } catch (e) { if (!(e instanceof PortalError)) throw e; return; }
  await audit({ tenantId, actorId: user.id, action: "portal.revoke", entity: "Guardian", entityId: guardianId });
  revalidatePath("/families");
}

export async function blockGuardianAction(form: FormData) {
  const { user, tenantId } = await requirePermission("families:write");
  const guardianId = String(form.get("guardianId") ?? "");
  const block = form.get("block") === "true";
  const r = await db.guardian.updateMany({ where: { id: guardianId, tenantId }, data: { portalBlocked: block, portalSessionVersion: { increment: 1 } } });
  if (r.count) await audit({ tenantId, actorId: user.id, action: block ? "portal.block" : "portal.unblock", entity: "Guardian", entityId: guardianId });
  revalidatePath("/families");
}
