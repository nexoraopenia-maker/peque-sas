import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { signToken } from "@/lib/auth/token";
import { proxy } from "@/proxy";
import { DEMO_EMPLOYEES, DEMO_FAMILIES, DEMO_PRODUCTS, checkExpiry, demoDni, demoPhone, demoSchema, endOfLimaDay, planSchema } from "@/lib/superadmin/pure";
import { workerSchema } from "@/lib/validation/schemas";

const SECRET = "x".repeat(40);
beforeAll(() => { process.env.AUTH_SECRET = SECRET; });
const req = (path: string, token?: string) => new NextRequest(`http://localhost${path}`, { headers: token ? { cookie: `pq_session=${token}` } : {} });
const loc = (r: Response) => r.headers.get("location") ?? "";

describe("proxy: /superadmin/* exige un token firmado con la marca de SuperAdmin", () => {
  it("sin cookie o con basura -> a /login", async () => {
    for (const p of ["/superadmin", "/superadmin/dashboard", "/superadmin/tenants/abc", "/superadmin/demos/new"]) {
      expect(loc(await proxy(req(p)))).toContain("/login");
      expect(loc(await proxy(req(p, "no-es-un-jwt")))).toContain("/login");
    }
  });
  it("un usuario de establecimiento (OWNER incluido) recibe 404, nunca la página", async () => {
    const owner = await signToken({ uid: "u1", sv: 0 }, 3600);
    const ownerForged = await signToken({ uid: "u1", sv: 0, sa: false }, 3600);
    for (const p of ["/superadmin", "/superadmin/dashboard", "/superadmin/tenants/abc", "/superadmin/demos/new"]) {
      for (const t of [owner, ownerForged]) { const r = await proxy(req(p, t)); expect(r.status).toBe(404); expect(r.headers.get("x-middleware-next")).toBeNull(); }
    }
  });
  it("un SuperAdmin con token válido pasa", async () => {
    const sa = await signToken({ uid: "s1", sv: 0, sa: true }, 3600);
    const r = await proxy(req("/superadmin/dashboard", sa));
    expect(r.status).toBe(200); expect(r.headers.get("x-middleware-next")).toBe("1");
  });
  it("tokens falsificados, caducados o con la marca mal formada no pasan", async () => {
    const other = await new SignJWT({ uid: "s1", sv: 0, sa: true }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode("y".repeat(40)));
    expect(loc(await proxy(req("/superadmin/dashboard", other)))).toContain("/login");           // firmado con otro secreto
    const expired = await new SignJWT({ uid: "s1", sv: 0, sa: true }).setProtectedHeader({ alg: "HS256" }).setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(new TextEncoder().encode(SECRET));
    expect(loc(await proxy(req("/superadmin/dashboard", expired)))).toContain("/login");
    const asString = await new SignJWT({ uid: "s1", sv: 0, sa: "true" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
    expect((await proxy(req("/superadmin/dashboard", asString))).status).toBe(404);              // "true" (texto) no es true
    const none = [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from('{"uid":"s1","sv":0,"sa":true}').toString("base64url"), ""].join(".");
    expect(loc(await proxy(req("/superadmin/dashboard", none)))).toContain("/login");           // alg=none
  });
  it("las rutas de establecimientos siguen funcionando con cookie y se protegen sin ella", async () => {
    const t = await signToken({ uid: "u1", sv: 0 }, 3600);
    expect((await proxy(req("/dashboard", t))).status).toBe(200);
    expect(loc(await proxy(req("/dashboard")))).toContain("/login");
    expect(loc(await proxy(req("/expenses")))).toContain("/login");
    expect((await proxy(req("/login"))).status).toBe(200);
  });
});

describe("regresión estática de la superficie SuperAdmin", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const exportsOf = (src: string) => [...src.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]!);
  const body = (src: string, name: string) => { const i = src.indexOf(`export async function ${name}(`); const rest = src.slice(i + 10); const j = rest.search(/\nexport (async )?(function|const)/); return j < 0 ? rest : rest.slice(0, j); };

  it("toda Server Action de SuperAdmin empieza verificando requireSuperAdmin()", () => {
    const src = read("actions/superadmin.ts");
    const names = exportsOf(src);
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const n of names) expect(body(src, n), n).toMatch(/await requireSuperAdmin\(\)/);
  });
  it("toda función exportada del servicio y de las demos verifica de nuevo al actor en la base de datos", () => {
    for (const f of ["lib/superadmin/service.ts", "lib/superadmin/demo.ts"]) {
      const src = read(f);
      for (const n of exportsOf(src).filter((x) => x !== "assertSuperAdmin")) expect(body(src, n), `${f}:${n}`).toMatch(/assertSuperAdmin\(/);
    }
    const svc = read("lib/superadmin/service.ts");
    for (const m of svc.matchAll(/export const (listPlans) = async \(actorId[^)]*\) => \{ await assertSuperAdmin/g)) expect(m[1]).toBe("listPlans");
  });
  it("el layout y las páginas de /superadmin se protegen con requireSuperAdmin()", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const files = walk("app/superadmin").filter((f) => /(page|layout|route)\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) expect(read(f), f).toMatch(/requireSuperAdmin\(\)/);
  });
  it("nada fuera de /superadmin y de sus acciones importa el servicio SuperAdmin", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { if (["node_modules", ".next", "generated"].includes(n)) return []; const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const offenders = ["app", "actions", "components", "lib"].flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith("app/superadmin") && !f.startsWith("lib/superadmin") && f !== "actions/superadmin.ts")
      .filter((f) => /@\/lib\/superadmin|@\/actions\/superadmin/.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it("el alta de trabajadores de un establecimiento no puede crear SUPERADMIN ni OWNER", () => {
    for (const role of ["SUPERADMIN", "OWNER"]) expect(workerSchema.safeParse({ name: "X Y", email: "a@b.pe", role }).success).toBe(false);
    expect(workerSchema.safeParse({ name: "X Y", email: "a@b.pe", role: "ADMIN" }).success).toBe(true);
  });
  it("el servicio y la sesión no exponen datos de menores en el panel (solo conteos)", () => {
    const pages = ["app/superadmin/dashboard/page.tsx", "app/superadmin/tenants/[id]/page.tsx", "lib/superadmin/service.ts"].map(read).join("\n");
    expect(pages).not.toMatch(/fullName|birthDate|allergies|medicalAlerts|\.child\.findMany|\.guardian\.findMany/);
  });
});

describe("formularios y datos demo", () => {
  const ok = { name: "Demo Peques", businessType: "ludoteca", adminEmail: "ADMIN@Demo.pe", adminName: "Ana", modules: ["PLAYGROUND"], expiresAt: "2026-12-01" };
  it("valida y normaliza", () => {
    const r = demoSchema.parse(ok);
    expect(r).toMatchObject({ adminEmail: "admin@demo.pe", maxUsers: 5, storageMb: 200, botMonthlyReplies: 300, whatsappEnabled: false });
    expect(r.password).toBeUndefined();
    expect(demoSchema.parse({ ...ok, password: "" }).password).toBeUndefined();
    expect(demoSchema.safeParse({ ...ok, password: "corta" }).success).toBe(false);
    expect(demoSchema.safeParse({ ...ok, password: "una-clave-larga-123" }).success).toBe(true);
    expect(demoSchema.safeParse({ ...ok, modules: [] }).success).toBe(false);
    expect(demoSchema.safeParse({ ...ok, modules: ["HACK"] }).success).toBe(false);
    expect(demoSchema.safeParse({ ...ok, businessType: "banco" }).success).toBe(false);
    expect(demoSchema.safeParse({ ...ok, adminEmail: "no-correo" }).success).toBe(false);
    expect(demoSchema.safeParse({ ...ok, maxUsers: 2 }).success).toBe(false);
    expect(demoSchema.safeParse({ ...ok, maxUsers: 21 }).success).toBe(false);
    expect(demoSchema.safeParse({ ...ok, name: "ab" }).success).toBe(false);
  });
  it("el vencimiento es futuro y de máximo 90 días (hora de Lima)", () => {
    const now = new Date("2026-11-18T15:00:00Z"); // 10:00 en Lima
    expect(checkExpiry("2026-11-17", now)).toMatch(/futura/);
    expect(checkExpiry("2026-11-18", now)).toBeNull();            // vence al terminar hoy
    expect(checkExpiry("2026-12-01", now)).toBeNull();
    expect(checkExpiry("2027-03-01", now)).toMatch(/90/);
    expect(checkExpiry("2026-02-31", now)).toMatch(/inválida/);
    expect(checkExpiry("basura", now)).toMatch(/inválida/);
    expect(endOfLimaDay("2026-12-01").toISOString()).toBe("2026-12-02T04:59:59.999Z");
  });
  it("todos los datos demo son claramente ficticios", () => {
    for (const f of DEMO_FAMILIES) { expect(f.guardian).toContain("(demo)"); expect(f.child).toContain("(demo)"); }
    DEMO_FAMILIES.forEach((_, i) => { expect(demoPhone(i)).toMatch(/^9000000\d\d$/); expect(demoDni(i)).toMatch(/^0000\d{4}$/); });
    expect(new Set(DEMO_FAMILIES.map((f) => f.guardian)).size).toBe(DEMO_FAMILIES.length);
    expect(new Set(DEMO_PRODUCTS.map((p) => p.sku)).size).toBe(DEMO_PRODUCTS.length);
    expect(DEMO_EMPLOYEES.map((e) => e.role)).toEqual(["RECEPTION", "TEACHER", "ADMIN"]);
  });
  it("valida el plan", () => {
    expect(planSchema.safeParse({ name: "Pro", modules: ["PLAYGROUND"], maxUsers: 5, storageMb: 500, botMonthlyReplies: 100 }).success).toBe(true);
    expect(planSchema.safeParse({ name: "P", modules: [], maxUsers: 5, storageMb: 500, botMonthlyReplies: 100 }).success).toBe(false);
    expect(planSchema.safeParse({ name: "Pro", modules: ["X"], maxUsers: 5, storageMb: 500, botMonthlyReplies: 100 }).success).toBe(false);
    expect(planSchema.safeParse({ name: "Pro", modules: [], maxUsers: 0, storageMb: 500, botMonthlyReplies: 100 }).success).toBe(false);
  });
});
