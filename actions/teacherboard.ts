"use server";
import { revalidatePath } from "next/cache";
import { requireModule, requirePermission } from "@/lib/rbac";
import { tenantDb } from "@/lib/db/tenant";
import { describeLog, logInputSchema } from "@/lib/daycare/log";
import { limaDate } from "@/lib/utils/date";
import { done } from "@/lib/utils/flow";
import { audit } from "@/lib/audit";

const BOARD = "/teachers/board";

async function ctx() {
  await requireModule("DAYCARE");
  const { user, tenantId } = await requirePermission("teacherboard:use");
  return { user, tenantId, tdb: tenantDb(tenantId) };
}

/** Solo se registra sobre menores presentes hoy (con ingreso y sin salida). */
async function requirePresent(tdb: ReturnType<typeof tenantDb>, childId: string) {
  const att = await tdb.daycareAttendance.findFirst({ where: { childId, date: limaDate(), status: "PRESENT", checkInAt: { not: null }, checkOutAt: null } });
  if (!att) done(BOARD, "El menor no está presente hoy");
}

export async function addLogAction(form: FormData) {
  const { user, tenantId, tdb } = await ctx();
  const p = logInputSchema.safeParse(Object.fromEntries(form));
  if (!p.success) done(BOARD, "Registro no válido");
  await requirePresent(tdb, p.data.childId);
  const d = p.data;
  const visible = d.kind === "NOTE" ? d.visible === "on" : true;
  const data = {
    childId: d.childId, date: limaDate(), kind: d.kind, recordedById: user.id, visibleToParents: visible,
    subtype: "subtype" in d ? d.subtype : undefined, level: "level" in d ? d.level : undefined, notes: d.notes,
  };
  const log = await tdb.$transaction(async (tx) => {
    const l = await tx.daycareLog.create({ data: data as never });
    if (visible) await tx.daycareNotification.create({ data: { childId: d.childId, logId: l.id, message: describeLog(l as never) } as never });
    return l;
  });
  await audit({ tenantId, actorId: user.id, action: "daycare.log", entity: "DaycareLog", entityId: log.id, metadata: { kind: d.kind } });
  revalidatePath(BOARD);
  done(BOARD);
}

export async function startNapAction(form: FormData) {
  const { user, tenantId, tdb } = await ctx();
  const childId = String(form.get("childId") ?? "");
  await requirePresent(tdb, childId);
  try {
    const log = await tdb.$transaction(async (tx) => {
      const l = await tx.daycareLog.create({ data: { childId, date: limaDate(), kind: "NAP", recordedById: user.id } as never });
      await tx.daycareNotification.create({ data: { childId, logId: l.id, message: describeLog(l as never) } as never });
      return l;
    });
    await audit({ tenantId, actorId: user.id, action: "daycare.nap.start", entity: "DaycareLog", entityId: log.id });
  } catch (e) {
    done(BOARD, /UNIQUE|constraint/i.test(e instanceof Error ? e.message : "") ? "El menor ya está durmiendo" : "No se pudo registrar");
  }
  revalidatePath(BOARD);
  done(BOARD);
}

export async function endNapAction(form: FormData) {
  const { user, tenantId, tdb } = await ctx();
  const childId = String(form.get("childId") ?? "");
  const nap = await tdb.daycareLog.findFirst({ where: { childId, kind: "NAP", endedAt: null } });
  if (!nap) done(BOARD, "No hay siesta en curso");
  const now = new Date();
  // condicionado a seguir abierta: dos toques no cierran dos veces
  const r = await tdb.daycareLog.updateMany({ where: { id: nap.id, endedAt: null }, data: { endedAt: now } });
  if (r.count !== 1) done(BOARD, "La siesta ya estaba cerrada");
  await tdb.daycareNotification.create({ data: { childId, logId: nap.id, message: describeLog({ ...nap, endedAt: now } as never) } as never });
  await audit({ tenantId, actorId: user.id, action: "daycare.nap.end", entity: "DaycareLog", entityId: nap.id });
  revalidatePath(BOARD);
  done(BOARD);
}
