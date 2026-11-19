import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { hashAccessCode, generatePortalCode, rateKeys } from "@/lib/portal/identity";
import { GENERIC_LOGIN_ERROR, PortalError, issueAccessCode, loadGuardian, loginWithCode, revokeGuardianAccess } from "@/lib/portal/auth";
import * as data from "@/lib/portal/data";
import { limaDate } from "@/lib/utils/date";
import { addDays } from "@/lib/reservations/calendar";

// Contra Turso remoto (RUN_REMOTE_TESTS=1). Prefijo único y limpieza al terminar.
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__portal_${Date.now()}`;
const PA = generatePortalCode(), PB = generatePortalCode();
let planId = "", A = "", B = "", staff = "";
let G1 = "", G2 = "", G3 = "", G4 = "", GB = "", C1 = "", C2 = "", C3 = "", CB = "";
const today = limaDate();
const keys: string[] = [];
const startedAt = new Date(); // los eventos de intentos de login creados por esta prueba se borran por ventana de tiempo

async function mkGuardian(tenantId: string, name: string, dni: string | null, phoneDigits: string | null) {
  return (await db.guardian.create({ data: { tenantId, fullName: name, dni, phone: phoneDigits, phoneDigits } })).id;
}
const link = (tenantId: string, childId: string, guardianId: string) => db.childGuardian.create({ data: { tenantId, childId, guardianId, canPickup: true } });
const notFound = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ digest: expect.stringContaining("404") });

/** Siembra datos distinguibles para un menor. */
async function seedChild(tenantId: string, childId: string, label: string, sessionId: string, withIncident = true) {
  const en = await db.enrollment.create({ data: { tenantId, childId, schoolYear: 2026, startDate: "2026-01-05", monthlyFeeCents: 10000, createdById: staff } });
  await db.daycareAttendance.create({ data: { tenantId, childId, enrollmentId: en.id, date: today, status: "PRESENT", checkInAt: new Date(), lateMinutes: 0 } });
  await db.daycareLog.create({ data: { tenantId, childId, date: today, kind: "NOTE", notes: `visible-${label}`, visibleToParents: true, recordedById: staff } });
  await db.daycareLog.create({ data: { tenantId, childId, date: today, kind: "NOTE", notes: `RESERVADA-${label}`, visibleToParents: false, recordedById: staff } });
  await db.daycareNotification.create({ data: { tenantId, childId, message: `novedad-${label}` } });
  await db.daycareInvoice.create({ data: { tenantId, enrollmentId: en.id, childId, period: "2026-01", amountCents: 10000, dueDate: "2026-01-05" } });
  await db.prepaidLedger.create({ data: { tenantId, childId, type: "PURCHASE", minutes: 30, balanceAfter: 30, createdById: staff } });
  await db.child.updateMany({ where: { id: childId, tenantId }, data: { prepaidMinutes: 30, allergies: `alergia-${label}` } });
  await db.reservation.create({ data: { tenantId, serviceType: "LUDOTECA", childId, contactName: `contacto-${label}`, date: addDays(today, 3), startTime: "10:00", endTime: "11:00", attendees: 1, totalAmountCents: 1000, createdById: staff } });
  await db.daycareProfile.create({ data: { tenantId, childId, pediatrician: `pediatra-${label}`, updatedById: staff } });
  const rate = await db.playgroundRate.create({ data: { tenantId, name: "r", minutes: 60, priceCents: 1000, extraMinuteCents: 0 } });
  await db.playgroundSession.create({ data: { tenantId, childId, rateId: rate.id, braceletCode: `B-${label}`, contractedMinutes: 60, basePriceCents: 1000, extraMinuteCents: 0, checkedInById: staff } });
  const cs = await db.cashRegisterSession.create({ data: { tenantId, openingBalanceCents: 0, openedById: staff, status: "CLOSED" } });
  await db.sale.create({ data: { tenantId, cashRegisterSessionId: cs.id, kind: "POS", totalCents: 500, cashCents: 500, childId, createdById: staff, notes: `venta-${label}` } });
  if (withIncident) await db.daycareIncident.create({ data: { tenantId, childId, date: today, type: "FALL", description: `incidente-${label}`, reportedById: staff } });
  void sessionId;
}

async function newCode(tenantId: string, guardianId: string) {
  const r = await issueAccessCode({ tenantId, guardianId, createdById: staff });
  return r.code;
}
const dniOf = async (g: string) => (await db.guardian.findFirstOrThrow({ where: { id: g } })).dni!;

run("Fase 10: portal de padres (Turso remoto)", () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "x".repeat(40);
    planId = (await db.plan.create({ data: { name: tag, modules: [] } })).id;
    A = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId, modules: ["WHATSAPP"], portalEnabled: true, portalCode: PA } })).id;
    B = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId, modules: ["WHATSAPP"], portalEnabled: true, portalCode: PB } })).id;
    staff = (await db.user.create({ data: { email: `${tag}@example.test`, name: "s", role: "OWNER", tenantId: A, passwordHash: "x" } })).id;
    C1 = (await db.child.create({ data: { tenantId: A, fullName: "Niño Uno" } })).id;
    C2 = (await db.child.create({ data: { tenantId: A, fullName: "Niño Dos" } })).id;
    C3 = (await db.child.create({ data: { tenantId: A, fullName: "Niño Tres" } })).id;
    CB = (await db.child.create({ data: { tenantId: B, fullName: "Niño Ajeno B" } })).id;
    G1 = await mkGuardian(A, "Madre Uno", "11111111", "911111111");
    G2 = await mkGuardian(A, "Madre Dos", "22222222", "922222222");
    G3 = await mkGuardian(A, "Padre Tres", "33333333", "933333333");
    G4 = await mkGuardian(A, "Sin Hijos", "44444444", "944444444");
    GB = await mkGuardian(B, "Madre B (mismo DNI que Uno)", "11111111", "911111111");
    await link(A, C1, G1); await link(A, C2, G2); await link(A, C1, G3); await link(A, C3, G3); await link(B, CB, GB);
    await seedChild(A, C1, "C1", ""); await seedChild(A, C2, "C2", ""); await seedChild(A, C3, "C3", "", false); await seedChild(B, CB, "CB", "");
    await db.child.updateMany({ where: { id: C2, tenantId: A }, data: { prepaidMinutes: 30 } });
  }, 420000); // siembra muchas filas contra Turso remoto: con latencia alta puede tardar varios minutos

  afterAll(async () => {
    const w = { where: { tenantId: { in: [A, B] } } };
    await db.parentAccessCode.deleteMany(w);
    await db.parentAuthEvent.deleteMany({ where: { OR: [{ key: { in: keys } }, { createdAt: { gte: startedAt } }] } });
    for (const m of ["saleItem", "sale", "cashRegisterSession", "daycareIncident", "playgroundSession", "playgroundRate", "daycareProfile", "reservation", "prepaidLedger", "daycareInvoice", "daycareNotification", "daycareLog", "daycareAttendance", "enrollment", "childGuardian", "child", "guardian", "auditLog", "user"] as const) {
      await (db[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany(w);
    }
    await db.tenant.deleteMany({ where: { id: { in: [A, B] } } }); await db.plan.deleteMany({ where: { id: planId } });
  }, 180000);

  // ---------- Autenticación ----------
  it("emitir código: exige portal habilitado, vínculo con menores, identidad y no bloqueo; solo se guarda el HMAC", async () => {
    await expect(issueAccessCode({ tenantId: A, guardianId: G4, createdById: staff })).rejects.toThrow(/no está vinculado/);
    await expect(issueAccessCode({ tenantId: A, guardianId: GB, createdById: staff })).rejects.toThrow(/no encontrado/); // apoderado de OTRO tenant
    const noId = await mkGuardian(A, "Sin identidad", null, null); await link(A, C3, noId);
    await expect(issueAccessCode({ tenantId: A, guardianId: noId, createdById: staff })).rejects.toThrow(/DNI o el teléfono/);
    await db.guardian.updateMany({ where: { id: G2 }, data: { portalBlocked: true } });
    await expect(issueAccessCode({ tenantId: A, guardianId: G2, createdById: staff })).rejects.toThrow(/bloqueado/);
    await db.guardian.updateMany({ where: { id: G2 }, data: { portalBlocked: false } });
    await db.tenant.updateMany({ where: { id: B }, data: { portalEnabled: false } });
    await expect(issueAccessCode({ tenantId: B, guardianId: GB, createdById: staff })).rejects.toThrow(/no está habilitado/);
    await db.tenant.updateMany({ where: { id: B }, data: { portalEnabled: true } });
    const code = await newCode(A, G1);
    expect(code).toMatch(/^\d{8}$/);
    const row = await db.parentAccessCode.findFirstOrThrow({ where: { tenantId: A, guardianId: G1 }, orderBy: { createdAt: "desc" } });
    expect(row.codeHash).toBe(hashAccessCode(row.id, code));
    expect(JSON.stringify(row)).not.toContain(code);
    await expect(db.parentAccessCode.count({ where: { tenantId: A, guardianId: G1 } })).resolves.toBe(1);
    await newCode(A, G1); // un nuevo código anula el anterior sin usar
    expect(await db.parentAccessCode.count({ where: { tenantId: A, guardianId: G1, expiresAt: { gt: new Date() }, usedAt: null } })).toBe(1);
  }, 180000);

  it("login: DNI o teléfono + código válido; uso único; el código anterior anulado no sirve", async () => {
    const old = await newCode(A, G1);
    const fresh = await newCode(A, G1);
    expect((await loginWithCode({ portalCode: PA, identifier: "11111111", code: old })).ok).toBe(false); // anulado por el nuevo
    const ok = await loginWithCode({ portalCode: PA.toLowerCase(), identifier: "11 111 111", code: `${fresh.slice(0, 4)} ${fresh.slice(4)}` });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.token).toMatchObject({ gid: G1, tid: A });
    expect((await loginWithCode({ portalCode: PA, identifier: "11111111", code: fresh })).ok).toBe(false); // ya usado
    const c2 = await newCode(A, G1);
    expect((await loginWithCode({ portalCode: PA, identifier: "+51 911 111 111", code: c2 })).ok).toBe(true); // por teléfono
  }, 180000);

  it("todas las fallas devuelven el MISMO mensaje (no revela qué dato falló)", async () => {
    const code = await newCode(A, G2);
    const msgs = await Promise.all([
      loginWithCode({ portalCode: PA, identifier: "22222222", code: "00000000" }),               // código mal
      loginWithCode({ portalCode: PA, identifier: "99999999", code }),                           // apoderado inexistente
      loginWithCode({ portalCode: "ZZZZZZZZ", identifier: "22222222", code }),                   // portal inexistente
      loginWithCode({ portalCode: PB, identifier: "22222222", code }),                           // otro establecimiento
      loginWithCode({ portalCode: PA, identifier: "abc", code }),                                // identificador inválido
      loginWithCode({ portalCode: PA, identifier: "22222222", code: "123" }),                    // formato de código inválido
    ]);
    for (const m of msgs) expect(m).toEqual({ ok: false, error: GENERIC_LOGIN_ERROR });
  }, 180000);

  it("el mismo DNI en OTRO establecimiento no permite entrar con el código de este", async () => {
    const codeA = await newCode(A, G1);
    expect((await loginWithCode({ portalCode: PB, identifier: "11111111", code: codeA })).ok).toBe(false); // portal B, DNI de G1/GB
    const codeB = await newCode(B, GB);
    expect((await loginWithCode({ portalCode: PA, identifier: "11111111", code: codeB })).ok).toBe(false);
    const okB = await loginWithCode({ portalCode: PB, identifier: "11111111", code: codeB });
    expect(okB.ok && okB.token.tid === B && okB.token.gid === GB).toBe(true); // entra a SU establecimiento, no al otro
    expect((await loginWithCode({ portalCode: PA, identifier: "11111111", code: codeA })).ok).toBe(true);
  }, 180000);

  it("5 intentos fallidos bloquean el código aunque después se envíe el correcto", async () => {
    const code = await newCode(A, G3);
    const wrong = code === "12345678" ? "87654321" : "12345678";
    for (let i = 0; i < 5; i++) await loginWithCode({ portalCode: PA, identifier: "33333333", code: wrong });
    const row = await db.parentAccessCode.findFirstOrThrow({ where: { tenantId: A, guardianId: G3 }, orderBy: { createdAt: "desc" } });
    expect(row.attempts).toBe(5);
    const r = await loginWithCode({ portalCode: PA, identifier: "33333333", code });
    expect(r.ok).toBe(false);
    keys.push(rateKeys(PA, "33333333").perIdentifier);
  }, 240000);

  it("limitación por identificador: tras 5 fallas incluso un código correcto recibe «demasiados intentos»", async () => {
    const code = await newCode(A, G2);
    const k = rateKeys(PA, "22222222");
    keys.push(k.perIdentifier, k.perPortal);
    await db.parentAuthEvent.createMany({ data: Array.from({ length: 5 }, () => ({ key: k.perIdentifier })) });
    const r = await loginWithCode({ portalCode: PA, identifier: "22222222", code });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Demasiados intentos/) });
    await db.parentAuthEvent.deleteMany({ where: { key: k.perIdentifier } });
    expect((await loginWithCode({ portalCode: PA, identifier: "22222222", code })).ok).toBe(true);
  }, 180000);

  it("las claves de intentos no guardan DNI ni teléfonos en claro", async () => {
    await loginWithCode({ portalCode: PA, identifier: "55555555", code: "00000000" });
    const k = rateKeys(PA, "55555555"); keys.push(k.perIdentifier, k.perPortal);
    const ev = await db.parentAuthEvent.findMany({ where: { key: k.perIdentifier } });
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain("55555555");
  }, 90000);

  it("código vencido no sirve", async () => {
    const code = await newCode(A, G2);
    await db.parentAccessCode.updateMany({ where: { tenantId: A, guardianId: G2, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await loginWithCode({ portalCode: PA, identifier: "22222222", code })).ok).toBe(false);
    await db.parentAuthEvent.deleteMany({ where: { key: rateKeys(PA, "22222222").perIdentifier } });
  }, 120000);

  it("dos logins simultáneos con el mismo código: solo uno entra", async () => {
    const code = await newCode(A, G2);
    const res = await Promise.all(Array.from({ length: 4 }, () => loginWithCode({ portalCode: PA, identifier: "22222222", code })));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
  }, 180000);

  it("sesiones: se invalidan al revocar, bloquear, cambiar de tenant o deshabilitar el portal", async () => {
    const code = await newCode(A, G1);
    const r = await loginWithCode({ portalCode: PA, identifier: "11111111", code });
    if (!r.ok) throw new Error("login");
    expect((await loadGuardian(r.token))?.id).toBe(G1);
    expect(await loadGuardian({ ...r.token, tid: B })).toBeNull();               // mismo gid con otro tenant
    expect(await loadGuardian({ gid: GB, tid: A, sv: 0 })).toBeNull();           // guardián de B con tid de A
    await revokeGuardianAccess(A, G1);
    expect(await loadGuardian(r.token)).toBeNull();                              // versión de sesión distinta
    await expect(revokeGuardianAccess(A, GB)).rejects.toThrow(PortalError);      // no puede revocar a un apoderado ajeno
    const g = await db.guardian.findFirstOrThrow({ where: { id: G1 } });
    const t2 = { gid: G1, tid: A, sv: g.portalSessionVersion };
    expect(await loadGuardian(t2)).not.toBeNull();
    await db.guardian.updateMany({ where: { id: G1 }, data: { portalBlocked: true } });
    expect(await loadGuardian(t2)).toBeNull();
    await db.guardian.updateMany({ where: { id: G1 }, data: { portalBlocked: false } });
    await db.tenant.updateMany({ where: { id: A }, data: { portalEnabled: false } });
    expect(await loadGuardian(t2)).toBeNull();
    await db.tenant.updateMany({ where: { id: A }, data: { portalEnabled: true } });
    expect(await loadGuardian(t2)).not.toBeNull();
  }, 240000);

  // ---------- Aislamiento de datos entre familias ----------
  it("un apoderado solo ve a SUS hijos; ningún acceso cruzado a menores de otras familias ni de otro establecimiento", async () => {
    const me1 = { id: G1, tenantId: A }, me2 = { id: G2, tenantId: A }, me3 = { id: G3, tenantId: A };
    expect((await data.myChildren(me1)).map((c) => c.id)).toEqual([C1]);
    expect((await data.myChildren(me2)).map((c) => c.id)).toEqual([C2]);
    expect((await data.myChildren(me3)).map((c) => c.id).sort()).toEqual([C1, C3].sort()); // hijo compartido
    expect(await data.myChildren({ id: G4, tenantId: A })).toEqual([]);
    expect((await data.requireMyChild(me1, C1)).childId).toBe(C1);
    expect((await data.requireMyChild(me3, C1)).childId).toBe(C1);                          // el otro apoderado del mismo menor
    await notFound(data.requireMyChild(me1, C2));                                           // hijo de otra familia
    await notFound(data.requireMyChild(me1, C3));                                           // hijo de otro apoderado
    await notFound(data.requireMyChild(me1, CB));                                           // menor de OTRO establecimiento
    await notFound(data.requireMyChild({ id: G1, tenantId: B }, CB));                       // tenant forjado
    await notFound(data.requireMyChild({ id: GB, tenantId: A }, C1));                       // apoderado de B contra menores de A
    await notFound(data.requireMyChild(me1, "inexistente"));
    await notFound(data.requireMyChild({ id: G4, tenantId: A }, C1));                       // sin hijos
  }, 240000);

  it("cada consulta devuelve solo datos del menor verificado", async () => {
    const mine = await data.requireMyChild({ id: G1, tenantId: A }, C1);
    const o = await data.childOverview(mine);
    expect(o.child.allergies).toBe("alergia-C1");
    expect(o.profile?.pediatrician).toBe("pediatra-C1");
    expect(o.attendance?.status).toBe("PRESENT");
    expect(o.openPlayground).not.toBeNull();
    expect(o.enrollment).not.toBeNull();
    const everything = JSON.stringify({
      o, log: await data.dayLog(mine, today), news: await data.recentNews(mine), att: await data.attendanceMonth(mine, today.slice(0, 7)),
      pg: await data.playgroundHistory(mine), inc: await data.incidents(mine), fin: await data.finances(mine), res: await data.reservations(mine),
    });
    for (const other of ["C2", "C3", "CB"]) expect(everything, `datos de ${other}`).not.toMatch(new RegExp(`(visible|RESERVADA|novedad|alergia|pediatra|contacto|incidente|venta|B)-${other}`));
    expect(everything).toContain("visible-C1");
    expect(everything).toContain("novedad-C1");
    expect(everything).toContain("incidente-C1");
    // reservas: exactamente la del menor (el nombre de contacto no se expone a propósito)
    const r1 = await db.reservation.findFirstOrThrow({ where: { tenantId: A, childId: C1 } });
    const res = await data.reservations(mine);
    expect(res.upcoming.map((r) => r.id)).toEqual([r1.id]);
    expect(JSON.stringify(res)).not.toContain("contacto-");
    expect(everything).not.toContain("Niño Dos");
    expect(everything).not.toContain("Niño Ajeno");
  }, 240000);

  it("la bitácora no incluye registros reservados al personal ni identifica a los trabajadores", async () => {
    const mine = await data.requireMyChild({ id: G1, tenantId: A }, C1);
    const log = await data.dayLog(mine, today);
    expect(JSON.stringify(log)).not.toContain("RESERVADA");
    expect(log.map((l) => l.text)).toContain("visible-C1");
    expect(JSON.stringify(log)).not.toContain(staff);
    expect(JSON.stringify(await data.recentNews(mine))).not.toContain(staff);
  }, 120000);

  it("finanzas: saldo, mensualidades vencidas y pagos solo del menor", async () => {
    const mine = await data.requireMyChild({ id: G1, tenantId: A }, C1);
    const f = await data.finances(mine);
    expect(f.prepaidMinutes).toBe(30);
    expect(f.invoices).toHaveLength(1);
    expect(f.overdueCount).toBe(1);               // vencida: 2026-01-05 < hoy
    expect(f.overdueCents).toBe(10000);
    expect(f.pendingCents).toBe(10000);
    expect(f.ledger).toHaveLength(1);
    expect(f.sales).toHaveLength(1);
    const f3 = await data.finances(await data.requireMyChild({ id: G3, tenantId: A }, C3));
    expect(f3.invoices).toHaveLength(1);
    expect(f3.sales[0]!.totalCents).toBe(500);
  }, 120000);

  it("el hijo compartido lo ven ambos apoderados con los mismos datos, y nadie más", async () => {
    const a = await data.childOverview(await data.requireMyChild({ id: G1, tenantId: A }, C1));
    const b = await data.childOverview(await data.requireMyChild({ id: G3, tenantId: A }, C1));
    expect(a.child.fullName).toBe(b.child.fullName);
    await notFound(data.requireMyChild({ id: G2, tenantId: A }, C1));
  }, 120000);
});
