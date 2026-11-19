import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { tenantDb } from "@/lib/db/tenant";
import { insertSessionIfCapacity } from "@/lib/playground/checkin";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

// Contra Turso remoto. Solo con RUN_REMOTE_TESTS=1 (npm run test:remote).
// Crea datos con prefijo único y los borra al terminar.
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__test_${Date.now()}`;
let t1 = "", t2 = "", planId = "";

run("Turso remoto: aislamiento multi-tenant", () => {
  beforeAll(async () => {
    planId = (await db.plan.create({ data: { name: tag, modules: ["PLAYGROUND"], maxUsers: 2 } })).id;
    t1 = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId, modules: ["WHATSAPP"] } })).id;
    t2 = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId, modules: ["WHATSAPP"] } })).id;
  }, 60000);

  afterAll(async () => {
    const ids = [t1, t2];
    for (const m of [db.daycareNotification, db.daycareLog, db.daycareIncident, db.daycareProfile, db.daycareAttendance, db.enrollment] as { deleteMany: (a: object) => Promise<unknown> }[]) await m.deleteMany({ where: { tenantId: { in: ids } } });
    await db.playgroundIncident.deleteMany({ where: { tenantId: { in: ids } } });
    await db.authorizedPickup.deleteMany({ where: { tenantId: { in: ids } } });
    await db.playgroundSession.deleteMany({ where: { tenantId: { in: ids } } });
    await db.playgroundRate.deleteMany({ where: { tenantId: { in: ids } } });
    await db.stockMovement.deleteMany({ where: { tenantId: { in: ids } } });
    await db.product.deleteMany({ where: { tenantId: { in: ids } } });
    await db.childGuardian.deleteMany({ where: { tenantId: { in: ids } } });
    await db.child.deleteMany({ where: { tenantId: { in: ids } } });
    await db.guardian.deleteMany({ where: { tenantId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    await db.user.deleteMany({ where: { tenantId: { in: ids } } });
    await db.tenant.deleteMany({ where: { id: { in: ids } } });
    await db.plan.deleteMany({ where: { id: planId } });
  }, 60000);

  it("tenantDb no devuelve ni modifica datos de otro tenant", async () => {
    const a = tenantDb(t1), b = tenantDb(t2);
    const child = await a.child.create({ data: { fullName: "solo-A" } as never });
    expect(await b.child.findMany()).toHaveLength(0);
    expect(await b.child.findFirst({ where: { id: child.id } })).toBeNull();
    expect((await b.child.updateMany({ where: { id: child.id }, data: { fullName: "hack" } })).count).toBe(0);
    expect((await b.child.deleteMany({ where: { id: child.id } })).count).toBe(0);
    expect((await a.child.findFirstOrThrow({ where: { id: child.id } })).fullName).toBe("solo-A");
  }, 60000);

  it("tenantDb fuerza el tenantId aunque se intente otro en create", async () => {
    const g = await tenantDb(t1).guardian.create({ data: { fullName: "g", tenantId: t2 } as never });
    expect(g.tenantId).toBe(t1);
  }, 60000);

  it("tenantDb rechaza operaciones por id único", async () => {
    await expect(tenantDb(t1).child.findUnique({ where: { id: "x" } })).rejects.toThrow(/no permitido/);
  });

  it("transacción de familia con FK compuesta entre tenants falla", async () => {
    const child = await tenantDb(t1).child.create({ data: { fullName: "c" } as never });
    const guardian = await tenantDb(t2).guardian.create({ data: { fullName: "g" } as never });
    await expect(
      db.childGuardian.create({ data: { tenantId: t1, childId: child.id, guardianId: guardian.id } }),
    ).rejects.toThrow();
  }, 60000);

  it("stock: transacción condicional no permite negativos", async () => {
    const tdb = tenantDb(t1);
    const p = await tdb.product.create({ data: { name: "p", stock: 3, priceCents: 500 } as never });
    const out = (q: number) => tdb.$transaction((tx) => tx.product.updateMany({ where: { id: p.id, stock: { gte: q } }, data: { stock: { increment: -q } } }));
    expect((await out(4)).count).toBe(0);
    expect((await out(3)).count).toBe(1);
    expect((await tdb.product.findFirstOrThrow({ where: { id: p.id } })).stock).toBe(0);
  }, 60000);

  it("usuario: email único global y hash verificable", async () => {
    const email = `${tag}@example.test`;
    const hash = await hashPassword("Clave-de-prueba-1");
    await db.user.create({ data: { email, name: "u", role: "OWNER", tenantId: t1, passwordHash: hash } });
    await expect(db.user.create({ data: { email, name: "u2", role: "ADMIN", tenantId: t2, passwordHash: hash } })).rejects.toThrow();
    const u = await db.user.findUniqueOrThrow({ where: { email } });
    expect(await verifyPassword("Clave-de-prueba-1", u.passwordHash)).toBe(true);
    expect(await verifyPassword("otra", u.passwordHash)).toBe(false);
  }, 60000);

  it("ludoteca: una sola sesión abierta por menor y por pulsera; cierre sin doble cobro", async () => {
    const u = await db.user.create({ data: { email: `${tag}-l@example.test`, name: "l", role: "RECEPTION", tenantId: t1, passwordHash: "x" } });
    const a = tenantDb(t1);
    const c1 = await a.child.create({ data: { fullName: "c1" } as never });
    const c2 = await a.child.create({ data: { fullName: "c2" } as never });
    const rate = await a.playgroundRate.create({ data: { name: "1h", minutes: 60, priceCents: 2000, extraMinuteCents: 50 } as never });
    const base = { tenantId: t1, rateId: rate.id, contractedMinutes: 60, basePriceCents: 2000, extraMinuteCents: 50, checkedInById: u.id };
    const s1 = await db.playgroundSession.create({ data: { ...base, childId: c1.id, braceletCode: "B1" } });
    await expect(db.playgroundSession.create({ data: { ...base, childId: c1.id, braceletCode: "B2" } })).rejects.toThrow(); // mismo menor
    await expect(db.playgroundSession.create({ data: { ...base, childId: c2.id, braceletCode: "B1" } })).rejects.toThrow(); // misma pulsera
    const close = () => db.playgroundSession.updateMany({ where: { id: s1.id, status: "OPEN" }, data: { status: "CLOSED", checkOutAt: new Date(), amountCents: 2000 } });
    expect((await close()).count).toBe(1);
    expect((await close()).count).toBe(0); // segundo cierre no cobra otra vez
    // tras cerrar, menor y pulsera quedan libres
    await expect(db.playgroundSession.create({ data: { ...base, childId: c1.id, braceletCode: "B1" } })).resolves.toBeTruthy();
  }, 90000);

  it("ludoteca: no se puede usar menor o tarifa de otro tenant", async () => {
    const u = await db.user.findFirstOrThrow({ where: { tenantId: t1, email: { endsWith: "-l@example.test" } } });
    const childB = await tenantDb(t2).child.create({ data: { fullName: "cb" } as never });
    const rateA = await tenantDb(t1).playgroundRate.findFirstOrThrow({});
    await expect(db.playgroundSession.create({ data: { tenantId: t1, childId: childB.id, rateId: rateA.id, braceletCode: "X9", contractedMinutes: 60, basePriceCents: 1, extraMinuteCents: 0, checkedInById: u.id } })).rejects.toThrow();
  }, 60000);

  it("aforo: ingresos simultáneos nunca superan la capacidad", async () => {
    await db.tenant.update({ where: { id: t2 }, data: { playgroundCapacity: 3 } });
    const u = await db.user.create({ data: { email: `${tag}-cap@example.test`, name: "c", role: "RECEPTION", tenantId: t2, passwordHash: "x" } });
    const b = tenantDb(t2);
    const rate = await b.playgroundRate.create({ data: { name: "r", minutes: 60, priceCents: 1000, extraMinuteCents: 0 } as never });
    const kids = await Promise.all(Array.from({ length: 10 }, (_, i) => b.child.create({ data: { fullName: `k${i}` } as never })));
    const results = await Promise.allSettled(
      kids.map((k, i) => insertSessionIfCapacity(db, { tenantId: t2, childId: k.id, rateId: rate.id, braceletCode: `P${i}`, userId: u.id, contractedMinutes: 60, basePriceCents: 1000, extraMinuteCents: 0 })),
    );
    const created = results.filter((r) => r.status === "fulfilled" && r.value !== null).length;
    expect(created).toBe(3);
    expect(await b.playgroundSession.count({ where: { status: "OPEN" } })).toBe(3);
    // la fecha se guarda en un formato que Prisma lee como Date válida
    const one = await b.playgroundSession.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(one.checkInAt instanceof Date && !isNaN(one.checkInAt.getTime())).toBe(true);
    expect(Math.abs(Date.now() - one.checkInAt.getTime())).toBeLessThan(120000);
  }, 120000);

  it("aforo: otro tenant no consume la capacidad", async () => {
    const u = await db.user.findFirstOrThrow({ where: { email: `${tag}-l@example.test` } });
    const a = tenantDb(t1);
    const rate = await a.playgroundRate.findFirstOrThrow({});
    const k = await a.child.create({ data: { fullName: "otro" } as never });
    const id = await insertSessionIfCapacity(db, { tenantId: t1, childId: k.id, rateId: rate.id, braceletCode: "Z1", userId: u.id, contractedMinutes: 60, basePriceCents: 1, extraMinuteCents: 0 });
    expect(id).not.toBeNull(); // t1 tiene capacidad 30 por defecto; las 3 sesiones de t2 no cuentan
  }, 60000);

  // ===== Guardería =====
  it("guardería: tenantDb aísla los 6 modelos (leer, actualizar, borrar)", async () => {
    const a = tenantDb(t1), b = tenantDb(t2);
    const child = await a.child.create({ data: { fullName: "dc" } as never });
    const en = await a.enrollment.create({ data: { childId: child.id, schoolYear: 2026, startDate: "2026-03-01", createdById: "u" } as never });
    const att = await a.daycareAttendance.create({ data: { childId: child.id, enrollmentId: en.id, date: "2026-03-02", status: "PRESENT" } as never });
    const log = await a.daycareLog.create({ data: { childId: child.id, date: "2026-03-02", kind: "MEAL", subtype: "LUNCH", level: "ALL", recordedById: "u" } as never });
    const inc = await a.daycareIncident.create({ data: { childId: child.id, date: "2026-03-02", type: "FALL", description: "x", reportedById: "u" } as never });
    const note = await a.daycareNotification.create({ data: { childId: child.id, message: "m" } as never });
    const prof = await a.daycareProfile.create({ data: { childId: child.id, updatedById: "u" } as never });
    const models: [string, { findMany: (a?: object) => Promise<unknown[]>; updateMany: (a: object) => Promise<{ count: number }>; deleteMany: (a: object) => Promise<{ count: number }> }, string][] = [
      ["enrollment", b.enrollment as never, en.id], ["attendance", b.daycareAttendance as never, att.id], ["log", b.daycareLog as never, log.id],
      ["incident", b.daycareIncident as never, inc.id], ["notification", b.daycareNotification as never, note.id], ["profile", b.daycareProfile as never, prof.id],
    ];
    for (const [name, m, id] of models) {
      expect(await m.findMany(), `${name} lectura`).toHaveLength(0);
      expect((await m.updateMany({ where: { id }, data: {} })).count, `${name} update`).toBe(0);
      expect((await m.deleteMany({ where: { id } })).count, `${name} delete`).toBe(0);
    }
    expect(await a.daycareLog.count()).toBeGreaterThan(0);
  }, 120000);

  it("guardería: las FK compuestas impiden matricular/registrar con menor o matrícula de otro tenant", async () => {
    const childB = await tenantDb(t2).child.create({ data: { fullName: "cb" } as never });
    await expect(db.enrollment.create({ data: { tenantId: t1, childId: childB.id, schoolYear: 2026, startDate: "2026-03-01", createdById: "u" } })).rejects.toThrow();
    const enA = await tenantDb(t1).enrollment.findFirstOrThrow({});
    await expect(db.daycareAttendance.create({ data: { tenantId: t2, childId: childB.id, enrollmentId: enA.id, date: "2026-03-05", status: "PRESENT" } })).rejects.toThrow();
    await expect(db.daycareLog.create({ data: { tenantId: t1, childId: childB.id, date: "2026-03-05", kind: "NOTE", recordedById: "u" } })).rejects.toThrow();
  }, 90000);

  it("guardería: una matrícula activa por menor, una asistencia por día y una siesta abierta", async () => {
    const a = tenantDb(t1);
    const child = await a.child.create({ data: { fullName: "uq" } as never });
    const mk = () => db.enrollment.create({ data: { tenantId: t1, childId: child.id, schoolYear: 2026, startDate: "2026-03-01", createdById: "u" } });
    const en = await mk();
    await expect(mk()).rejects.toThrow();
    await db.enrollment.update({ where: { id: en.id }, data: { status: "ENDED" } });
    await expect(mk()).resolves.toBeTruthy(); // tras finalizar, se puede volver a matricular
    const enr = await db.enrollment.findFirstOrThrow({ where: { tenantId: t1, childId: child.id, status: "ACTIVE" } });
    const att = () => db.daycareAttendance.create({ data: { tenantId: t1, childId: child.id, enrollmentId: enr.id, date: "2026-03-09", status: "PRESENT" } });
    await att();
    await expect(att()).rejects.toThrow();
    const nap = () => db.daycareLog.create({ data: { tenantId: t1, childId: child.id, date: "2026-03-09", kind: "NAP", recordedById: "u" } });
    const n1 = await nap();
    await expect(nap()).rejects.toThrow();
    await db.daycareLog.update({ where: { id: n1.id }, data: { endedAt: new Date() } });
    await expect(nap()).resolves.toBeTruthy();
  }, 120000);
});
