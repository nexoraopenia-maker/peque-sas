import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { ForbiddenError } from "@/lib/rbac";
import { changeTenantPlan, createPlan, getMetrics, getTenantDetail, listPlans, listTenants, reactivateTenant, resetOwnerPassword, setDemoExpiry, suspendTenant } from "@/lib/superadmin/service";
import { createDemoTenant } from "@/lib/superadmin/demo";
import { DEMO_FAMILIES, DEMO_PRODUCTS } from "@/lib/superadmin/pure";
import { limaDate } from "@/lib/utils/date";

// Contra Turso remoto (RUN_REMOTE_TESTS=1).
const run = process.env.RUN_REMOTE_TESTS === "1" ? describe : describe.skip;
const tag = `__sa_${Date.now()}`;
let planA = "", planBig = "", A = "", B = "", SA = "", SAoff = "", ownA = "", ownB = "", seq = 0;
const created: string[] = [];           // tenants demo creados por las pruebas
const demoIn = (over: Record<string, unknown> = {}) => ({ name: `${tag} Demo ${++seq}`, businessType: "ludoteca_guarderia", adminEmail: `${tag}-adm${seq}@example.test`, adminName: "Admin Demo", modules: ["PLAYGROUND", "DAYCARE"], expiresAt: limaDate(new Date(Date.now() + 10 * 86_400_000)), ...over });
const mkUser = (email: string, role: "OWNER" | "ADMIN" | "SUPERADMIN" | "RECEPTION", tenantId: string | null, extra: Record<string, unknown> = {}) =>
  db.user.create({ data: { email: `${tag}-${email}@example.test`, name: email, role, tenantId, passwordHash: "x", mustChangePassword: false, ...extra } });

run("Fase 16: SuperAdmin y gestión de establecimientos (Turso remoto)", () => {
  beforeAll(async () => {
    planA = (await db.plan.create({ data: { name: `${tag}-A`, modules: ["PLAYGROUND"], maxUsers: 2 } })).id;
    planBig = (await db.plan.create({ data: { name: `${tag}-big`, modules: ["PLAYGROUND", "DAYCARE"], maxUsers: 50 } })).id;
    A = (await db.tenant.create({ data: { name: `${tag}-A`, businessType: "t", planId: planA, modules: ["PLAYGROUND"] } })).id;
    B = (await db.tenant.create({ data: { name: `${tag}-B`, businessType: "t", planId: planA, modules: ["PLAYGROUND"] } })).id;
    SA = (await mkUser("sa", "SUPERADMIN", null)).id;
    SAoff = (await mkUser("saoff", "SUPERADMIN", null, { isActive: false })).id;
    ownA = (await mkUser("ownA", "OWNER", A)).id; ownB = (await mkUser("ownB", "OWNER", B)).id;
    await mkUser("recA", "RECEPTION", A); await mkUser("recA2", "RECEPTION", A);
  }, 120000);
  afterAll(async () => {
    const ids = [A, B, ...created];
    const w = { where: { tenantId: { in: ids } } };
    await db.auditLog.deleteMany({ where: { OR: [{ tenantId: { in: ids } }, { actorId: { in: [SA, SAoff] } }, { action: { startsWith: "superadmin." }, entityId: { startsWith: tag } }] } });
    for (const m of ["enrollment", "childGuardian", "child", "guardian", "product", "playgroundRate", "prepaidPackage", "reservationSpace", "botUsage", "user"] as const) await (db[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany(w);
    await db.user.deleteMany({ where: { id: { in: [SA, SAoff] } } });
    await db.tenant.deleteMany({ where: { id: { in: ids } } });
    await db.plan.deleteMany({ where: { OR: [{ name: { startsWith: tag } }, { name: { contains: tag } }, { id: { in: [planA, planBig] } }] } });
  }, 180000);

  it("la base de datos impide asignar/quitar SUPERADMIN y mezclarlo con establecimientos", async () => {
    await expect(mkUser("bad1", "SUPERADMIN", A)).rejects.toThrow();                                    // SUPERADMIN con establecimiento
    await expect(mkUser("bad2", "OWNER", null)).rejects.toThrow();                                      // OWNER sin establecimiento
    await expect(db.user.update({ where: { id: ownA }, data: { role: "SUPERADMIN" } })).rejects.toThrow(); // escalada por UPDATE
    await expect(db.user.update({ where: { id: ownA }, data: { role: "SUPERADMIN", tenantId: null } })).rejects.toThrow();
    await expect(db.user.update({ where: { id: SA }, data: { role: "OWNER", tenantId: A } })).rejects.toThrow(); // degradar
    await expect(db.user.update({ where: { id: SA }, data: { tenantId: A } })).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "User" SET "role" = 'SUPERADMIN' WHERE "id" = ${ownB}`).rejects.toThrow(/SUPERADMIN/);
    expect((await db.user.findFirstOrThrow({ where: { id: ownA } })).role).toBe("OWNER");
    expect((await db.user.findFirstOrThrow({ where: { id: SA } }))).toMatchObject({ role: "SUPERADMIN", tenantId: null });
    await db.user.update({ where: { id: ownA }, data: { name: "renombrado" } });                          // los cambios normales siguen permitidos
    await expect(db.tenant.update({ where: { id: A }, data: { status: "SUSPENDED" } })).rejects.toThrow(/Suspension/);
    await expect(db.tenant.update({ where: { id: A }, data: { suspendedAt: new Date() } })).rejects.toThrow(/Suspension/);
    expect((await db.tenant.findFirstOrThrow({ where: { id: A } })).status).toBe("ACTIVE");
  }, 120000);

  it("ningún usuario de establecimiento (ni el OWNER) ni un SuperAdmin inactivo puede ejecutar operaciones globales", async () => {
    const calls: [string, (id: string) => Promise<unknown>][] = [
      ["listTenants", (id) => listTenants(id)], ["getMetrics", (id) => getMetrics(id)], ["listPlans", (id) => listPlans(id)], ["getTenantDetail", (id) => getTenantDetail(id, A)],
      ["suspend", (id) => suspendTenant({ actorId: id, tenantId: B, reason: "intento no autorizado" })], ["reactivate", (id) => reactivateTenant({ actorId: id, tenantId: B })],
      ["plan", (id) => changeTenantPlan({ actorId: id, tenantId: B, planId: planBig })], ["expiry", (id) => setDemoExpiry({ actorId: id, tenantId: B, day: limaDate(new Date(Date.now() + 5 * 86_400_000)) })],
      ["reset", (id) => resetOwnerPassword({ actorId: id, tenantId: B })], ["createPlan", (id) => createPlan({ actorId: id, raw: { name: `${tag}-hack`, modules: [], maxUsers: 1, storageMb: 10, botMonthlyReplies: 0 } })],
      ["createDemo", (id) => createDemoTenant(id, demoIn())],
    ];
    for (const actor of [ownA, ownB, SAoff, "no-existe"]) for (const [n, f] of calls) await expect(f(actor), `${n} como ${actor}`).rejects.toBeInstanceOf(ForbiddenError);
    // nada cambió
    expect(await db.tenant.findMany({ where: { id: { in: [A, B] } }, select: { status: true, planId: true } })).toEqual([{ status: "ACTIVE", planId: planA }, { status: "ACTIVE", planId: planA }]);
    expect(await db.plan.count({ where: { name: `${tag}-hack` } })).toBe(0);
    expect(await db.tenant.count({ where: { name: { startsWith: `${tag} Demo` } } })).toBe(0);
    expect(await db.user.count({ where: { email: { contains: `${tag}-adm` } } })).toBe(0);
  }, 180000);

  it("suspender: exige motivo, cierra sesiones solo de ese establecimiento, audita y se puede reactivar", async () => {
    await expect(suspendTenant({ actorId: SA, tenantId: A, reason: "no" })).rejects.toThrow(/motivo/);
    await expect(suspendTenant({ actorId: SA, tenantId: "no-existe", reason: "motivo válido" })).rejects.toThrow(/no encontrado/);
    const svA = (await db.user.findFirstOrThrow({ where: { id: ownA } })).sessionVersion, svB = (await db.user.findFirstOrThrow({ where: { id: ownB } })).sessionVersion;
    await suspendTenant({ actorId: SA, tenantId: A, reason: "Falta de pago de la suscripción" });
    const t = await db.tenant.findFirstOrThrow({ where: { id: A } });
    expect([t.status, t.suspendedReason]).toEqual(["SUSPENDED", "Falta de pago de la suscripción"]); expect(t.suspendedAt).not.toBeNull();
    expect((await db.user.findFirstOrThrow({ where: { id: ownA } })).sessionVersion).toBe(svA + 1);
    expect((await db.user.findFirstOrThrow({ where: { id: ownB } })).sessionVersion).toBe(svB);       // B intacto
    expect((await db.tenant.findFirstOrThrow({ where: { id: B } })).status).toBe("ACTIVE");
    await expect(suspendTenant({ actorId: SA, tenantId: A, reason: "otra vez suspendido" })).rejects.toThrow(/ya está suspendido/);
    await reactivateTenant({ actorId: SA, tenantId: A });
    expect(await db.tenant.findFirstOrThrow({ where: { id: A } })).toMatchObject({ status: "ACTIVE", suspendedAt: null, suspendedReason: null });
    await expect(reactivateTenant({ actorId: SA, tenantId: A })).rejects.toThrow(/no está suspendido/);
    const log = await db.auditLog.findMany({ where: { tenantId: A, action: { startsWith: "superadmin." } }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => l.action)).toEqual(["superadmin.tenant.suspend", "superadmin.tenant.reactivate"]);
    expect(log.every((l) => l.actorId === SA)).toBe(true);
  }, 180000);

  it("cambiar de plan: respeta el límite de usuarios, aplica módulos y conserva los datos", async () => {
    await db.product.create({ data: { tenantId: A, name: "Producto histórico", stock: 5, priceCents: 100 } });
    await mkUser("recA3", "RECEPTION", A);                                                              // A ya tiene 4 usuarios activos > plan de 2
    await expect(changeTenantPlan({ actorId: SA, tenantId: A, planId: planA })).rejects.toThrow(/ya tiene ese plan/);
    const small = await createPlan({ actorId: SA, raw: { name: `${tag}-chico`, modules: ["WHATSAPP"], maxUsers: 3, storageMb: 100, botMonthlyReplies: 0 } });
    await expect(changeTenantPlan({ actorId: SA, tenantId: A, planId: small })).rejects.toThrow(/desactiva usuarios/);
    await changeTenantPlan({ actorId: SA, tenantId: A, planId: planBig });
    expect(await db.tenant.findFirstOrThrow({ where: { id: A } })).toMatchObject({ planId: planBig, status: "ACTIVE", modules: ["PLAYGROUND", "DAYCARE"] });
    expect(await db.product.count({ where: { tenantId: A, name: "Producto histórico" } })).toBe(1);        // datos históricos intactos
    await expect(changeTenantPlan({ actorId: SA, tenantId: A, planId: "no-existe" })).rejects.toThrow(/Plan no encontrado/);
    await expect(createPlan({ actorId: SA, raw: { name: `${tag}-chico`, modules: [], maxUsers: 3, storageMb: 100, botMonthlyReplies: 0 } })).rejects.toThrow(/Ya existe/);
    await expect(createPlan({ actorId: SA, raw: { name: "x", modules: ["HACK"], maxUsers: 3, storageMb: 100, botMonthlyReplies: 0 } })).rejects.toThrow();
    expect((await db.auditLog.count({ where: { tenantId: A, action: "superadmin.tenant.plan" } }))).toBe(1);
  }, 180000);

  it("restablecer la contraseña del propietario: temporal, de un solo uso, cierra sesiones y no toca a otros", async () => {
    const before = await db.user.findFirstOrThrow({ where: { id: ownB } });
    const r = await resetOwnerPassword({ actorId: SA, tenantId: A });
    const after = await db.user.findFirstOrThrow({ where: { id: ownA } });
    expect(r.email).toBe(after.email);
    expect(await verifyPassword(r.tempPassword, after.passwordHash)).toBe(true);
    expect(after.passwordHash).not.toContain(r.tempPassword);                                          // solo hash
    expect([after.mustChangePassword, after.failedLogins]).toEqual([true, 0]);
    expect(r.tempPassword.length).toBeGreaterThanOrEqual(16);
    expect(await db.user.findFirstOrThrow({ where: { id: ownB } })).toMatchObject({ passwordHash: before.passwordHash, sessionVersion: before.sessionVersion });
    await expect(resetOwnerPassword({ actorId: SA, tenantId: "no-existe" })).rejects.toThrow(/propietario/);
    const log = await db.auditLog.findFirstOrThrow({ where: { tenantId: A, action: "superadmin.owner.password_reset" } });
    expect(JSON.stringify(log)).not.toContain(r.tempPassword);                                          // la auditoría no guarda la clave
  }, 120000);

  it("demo: crea establecimiento completo con datos ficticios, usuarios limitados por plan y contraseñas con hash", async () => {
    const input = demoIn({ maxUsers: 4, password: "clave-definida-12345", whatsappEnabled: true });
    const r = await createDemoTenant(SA, input);
    created.push(r.tenantId);
    const t = await db.tenant.findFirstOrThrow({ where: { id: r.tenantId }, include: { plan: true } });
    expect(t).toMatchObject({ status: "DEMO", provisionedById: SA, modules: ["PLAYGROUND", "DAYCARE"] });
    expect(t.plan).toMatchObject({ isDemo: true, maxUsers: 4, storageMb: 200, botMonthlyReplies: 300, whatsappEnabled: false });   // se deriva del módulo WHATSAPP
    expect(t.demoExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const users = await db.user.findMany({ where: { tenantId: r.tenantId }, orderBy: { role: "asc" } });
    expect(users.map((u) => u.role).sort()).toEqual(["ADMIN", "OWNER", "RECEPTION", "TEACHER"]);          // límite de 4 usuarios
    expect(users.every((u) => u.mustChangePassword && u.isActive)).toBe(true);
    expect(r.credentials).toHaveLength(4);
    for (const c of r.credentials) { const u = users.find((x) => x.email === c.email)!; expect(await verifyPassword(c.password, u.passwordHash)).toBe(true); expect(u.passwordHash).not.toContain(c.password); }
    expect(r.credentials.find((c) => c.role === "OWNER")).toMatchObject({ email: input.adminEmail, password: "clave-definida-12345" });
    expect(new Set(r.credentials.map((c) => c.password)).size).toBe(4);
    expect(r.credentials.filter((c) => c.role !== "OWNER").every((c) => c.email.endsWith("@demo.example.test") && c.password.length >= 16)).toBe(true);
    const g = await db.guardian.findMany({ where: { tenantId: r.tenantId } }), c = await db.child.findMany({ where: { tenantId: r.tenantId } });
    expect([g.length, c.length]).toEqual([DEMO_FAMILIES.length, DEMO_FAMILIES.length]);
    expect(g.every((x) => x.fullName.includes("(demo)") && /^0000\d{4}$/.test(x.dni!) && /^519000000\d\d$/.test(x.phoneDigits!))).toBe(true);
    expect(await db.childGuardian.count({ where: { tenantId: r.tenantId } })).toBe(DEMO_FAMILIES.length);
    expect(await db.product.count({ where: { tenantId: r.tenantId } })).toBe(DEMO_PRODUCTS.length);
    expect([await db.playgroundRate.count({ where: { tenantId: r.tenantId } }), await db.prepaidPackage.count({ where: { tenantId: r.tenantId } }), await db.reservationSpace.count({ where: { tenantId: r.tenantId } }), await db.enrollment.count({ where: { tenantId: r.tenantId } })]).toEqual([3, 3, 2, 3]);
    expect((await db.prepaidPackage.findMany({ where: { tenantId: r.tenantId }, orderBy: { minutes: "asc" } })).map((p) => p.minutes)).toEqual([300, 600, 1200]);
    // aislamiento: nada de lo creado pertenece a otro establecimiento
    expect(await db.child.count({ where: { tenantId: { in: [A, B] }, fullName: { contains: "(demo)" } } })).toBe(0);
    expect((await db.auditLog.findFirstOrThrow({ where: { tenantId: r.tenantId, action: "superadmin.demo.create" } })).actorId).toBe(SA);
  }, 240000);

  it("demo: solo crea lo de los módulos elegidos, genera contraseña si no se da y valida la entrada sin dejar residuos", async () => {
    const r = await createDemoTenant(SA, demoIn({ modules: ["WHATSAPP"], maxUsers: 3 }));
    created.push(r.tenantId);
    expect([await db.enrollment.count({ where: { tenantId: r.tenantId } }), await db.playgroundRate.count({ where: { tenantId: r.tenantId } }), await db.product.count({ where: { tenantId: r.tenantId } })]).toEqual([0, 0, DEMO_PRODUCTS.length]);
    expect(r.credentials).toHaveLength(3); expect(r.credentials[0]!.password.length).toBeGreaterThanOrEqual(16);
    const plansBefore = await db.plan.count({ where: { name: { contains: tag } } }), tenantsBefore = await db.tenant.count({ where: { name: { startsWith: `${tag} Demo` } } });
    const dup = demoIn({ adminEmail: r.credentials[0]!.email });
    await expect(createDemoTenant(SA, dup)).rejects.toThrow(/ya está registrado/);                       // correo repetido
    await expect(createDemoTenant(SA, demoIn({ expiresAt: limaDate(new Date(Date.now() - 2 * 86_400_000)) }))).rejects.toThrow(/futura/);
    await expect(createDemoTenant(SA, demoIn({ expiresAt: limaDate(new Date(Date.now() + 120 * 86_400_000)) }))).rejects.toThrow(/90/);
    await expect(createDemoTenant(SA, demoIn({ password: "corta" }))).rejects.toThrow(/12 caracteres/);
    await expect(createDemoTenant(SA, demoIn({ modules: [] }))).rejects.toThrow(/módulo/);
    await expect(createDemoTenant(SA, demoIn({ modules: ["HACK"] }))).rejects.toThrow();
    expect([await db.plan.count({ where: { name: { contains: tag } } }), await db.tenant.count({ where: { name: { startsWith: `${tag} Demo` } } })]).toEqual([plansBefore, tenantsBefore]);
    // dos envíos simultáneos con el mismo correo: solo uno se crea y el otro no deja residuos
    const same = `${tag}-race@example.test`;
    const res = await Promise.allSettled([createDemoTenant(SA, demoIn({ adminEmail: same })), createDemoTenant(SA, demoIn({ adminEmail: same }))]);
    expect(res.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    for (const x of res) if (x.status === "fulfilled") created.push(x.value.tenantId);
    expect(await db.user.count({ where: { email: same } })).toBe(1);
  }, 360000);

  it("demo: vencimiento editable solo en demos y 'reactivar' vuelve a demo", async () => {
    const d = created[0]!;
    const day = limaDate(new Date(Date.now() + 30 * 86_400_000));
    await setDemoExpiry({ actorId: SA, tenantId: d, day });
    expect(limaDate((await db.tenant.findFirstOrThrow({ where: { id: d } })).demoExpiresAt!)).toBe(day);
    await expect(setDemoExpiry({ actorId: SA, tenantId: d, day: limaDate(new Date(Date.now() - 86_400_000)) })).rejects.toThrow(/futura/);
    await expect(setDemoExpiry({ actorId: SA, tenantId: B, day })).rejects.toThrow(/Solo los establecimientos demo/);
    await suspendTenant({ actorId: SA, tenantId: d, reason: "Prueba de suspensión de demo" });
    await reactivateTenant({ actorId: SA, tenantId: d });
    expect((await db.tenant.findFirstOrThrow({ where: { id: d } })).status).toBe("DEMO");
    // demo -> plan normal la convierte en ACTIVE sin vencimiento; plan normal -> demo le pone vencimiento
    await changeTenantPlan({ actorId: SA, tenantId: d, planId: planBig });
    expect(await db.tenant.findFirstOrThrow({ where: { id: d } })).toMatchObject({ status: "ACTIVE", demoExpiresAt: null });
    expect(await db.child.count({ where: { tenantId: d } })).toBe(DEMO_FAMILIES.length);                 // los datos siguen
  }, 240000);

  it("métricas globales y por establecimiento (tokens, transacciones, almacenamiento, estados)", async () => {
    const before = await getMetrics(SA);
    const month = limaDate().slice(0, 7);
    await db.botUsage.createMany({ data: [
      { tenantId: A, month, model: "m", inputTokens: 1000, outputTokens: 500, outcome: "REPLIED" }, { tenantId: A, month, model: "m", inputTokens: 200, outputTokens: 100, outcome: "REPLIED" },
      { tenantId: B, month, model: "m", inputTokens: 40, outputTokens: 10, outcome: "REPLIED" }, { tenantId: B, month: "2020-01", model: "m", inputTokens: 7, outputTokens: 3, outcome: "REPLIED" },
    ] });
    const after = await getMetrics(SA);
    expect(after.tokens.inputMonth - before.tokens.inputMonth).toBe(1240);
    expect(after.tokens.outputMonth - before.tokens.outputMonth).toBe(610);
    expect(after.tokens.inputTotal - before.tokens.inputTotal).toBe(1247);
    expect(after.tokens.repliesMonth - before.tokens.repliesMonth).toBe(3);
    const rows = await listTenants(SA);
    expect(rows.find((x) => x.id === A)).toMatchObject({ tokensMonth: 1800, planName: `${tag}-big`, status: "ACTIVE" });
    expect(rows.find((x) => x.id === B)).toMatchObject({ tokensMonth: 50 });                             // el mes viejo no cuenta
    expect(rows.find((x) => x.id === created[0])).toMatchObject({ status: "ACTIVE" });
    const demo = rows.find((x) => x.id === created[1])!;
    expect(demo).toMatchObject({ status: "DEMO", demoExpired: false, users: 3, maxUsers: 3 });
    // demo vencida
    await db.tenant.update({ where: { id: created[1]! }, data: { demoExpiresAt: new Date(Date.now() - 3600_000) } });
    expect((await listTenants(SA)).find((x) => x.id === created[1])!.demoExpired).toBe(true);
    const m2 = await getMetrics(SA);
    expect(m2.tenants.demoExpired).toBeGreaterThanOrEqual(1);
    expect(m2.tenants.total).toBe(m2.tenants.active + m2.tenants.demo + m2.tenants.demoExpired + m2.tenants.suspended);
    // almacenamiento: PDF/XML guardados
    const sale = await db.cashRegisterSession.create({ data: { tenantId: B, openedById: ownB, openingBalanceCents: 0 } });
    expect(sale.id).toBeTruthy();
    await db.sunatDocument.create({ data: { tenantId: B, kind: "BOLETA", provider: "MOCK", serie: "B001", number: 1, issueDate: "2026-11-18", saleId: `${tag}-s`, customerDocType: "NONE", customerName: "X", igvBp: 1800, taxableCents: 100, igvCents: 18, totalCents: 118, items: [], createdById: ownB, xml: "x".repeat(1000), pdf: Buffer.alloc(2000) } });
    expect((await listTenants(SA)).find((x) => x.id === B)).toMatchObject({ storageBytes: 3000, documentsMonth: 1 });
    expect((await getMetrics(SA)).storage.totalBytes - after.storage.totalBytes).toBe(3000);
    await db.sunatDocument.deleteMany({ where: { tenantId: B } }); await db.cashRegisterSession.deleteMany({ where: { tenantId: B } });
  }, 240000);

  it("el detalle solo expone conteos y metadatos de cuenta, nunca nombres de menores o apoderados", async () => {
    const d = await getTenantDetail(SA, created[0]!);
    const dump = JSON.stringify(d);
    for (const f of DEMO_FAMILIES) { expect(dump).not.toContain(f.child); expect(dump).not.toContain(f.guardian); }
    expect(d!.counts).toMatchObject({ children: DEMO_FAMILIES.length, guardians: DEMO_FAMILIES.length });
    expect(d!.users.every((u) => !("passwordHash" in u))).toBe(true);
    expect(await getTenantDetail(SA, "no-existe")).toBeNull();
  }, 120000);
});
