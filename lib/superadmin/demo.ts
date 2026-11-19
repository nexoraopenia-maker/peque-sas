import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { BillingError, retryBusy, type Tx } from "@/lib/billing/service";
import { generateTempPassword, hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { limaDate } from "@/lib/utils/date";
import { assertSuperAdmin } from "./service";
import {
  DEMO_EMPLOYEES, DEMO_FAMILIES, DEMO_FEE_CENTS, DEMO_PACKAGES, DEMO_PRODUCTS, DEMO_RATES, DEMO_SPACES, checkExpiry, demoDni, demoPhone, demoSchema, endOfLimaDay,
} from "./pure";

const TX = { maxWait: 10_000, timeout: 90_000 } as const;
export type DemoCredential = { role: string; name: string; email: string; password: string };
export type DemoResult = { tenantId: string; planName: string; expiresAt: string; credentials: DemoCredential[]; counts: Record<string, number> };

/**
 * Aprovisiona un establecimiento DEMO completo con datos FICTICIOS (familias, productos de POS, tarifas de ludoteca, cuponeras,
 * espacios y empleados). Todo en UNA transacción: o queda completo o no queda nada. Las contraseñas se guardan con hash y se devuelven
 * UNA sola vez; todos los usuarios deben cambiarla en su primer ingreso.
 */
export async function createDemoTenant(actorId: string, raw: unknown, now = new Date()): Promise<DemoResult> {
  await assertSuperAdmin(actorId);
  const p = demoSchema.safeParse(raw);
  if (!p.success) throw new BillingError(p.error.issues[0]?.message ?? "Revisa los datos del formulario");
  const d = p.data;
  const bad = checkExpiry(d.expiresAt, now); if (bad) throw new BillingError(bad);
  if (await db.user.findFirst({ where: { email: d.adminEmail }, select: { id: true } })) throw new BillingError("Ese correo ya está registrado");

  const tenantId = randomUUID(), short = tenantId.slice(0, 8);
  const has = (m: string) => (d.modules as string[]).includes(m);
  // Usuarios: administrador (OWNER) + empleados hasta el límite de usuarios del plan demo
  const staff = [{ role: "OWNER" as const, name: d.adminName, email: d.adminEmail, password: d.password ?? generateTempPassword() },
    ...DEMO_EMPLOYEES.slice(0, d.maxUsers - 1).map((e) => ({ role: e.role, name: e.name, email: `${e.role.toLowerCase()}.${short}@demo.example.test`, password: generateTempPassword() }))];
  const hashes = await Promise.all(staff.map((s) => hashPassword(s.password)));
  const planName = `Demo – ${d.name.slice(0, 40)} – ${short}`;
  const modules = d.modules;
  const year = Number(limaDate(now).slice(0, 4));
  const counts: Record<string, number> = {};

  try {
    await retryBusy(() => db.$transaction(async (tx: Tx) => {
      const plan = await tx.plan.create({ data: { name: planName, modules, isDemo: true, maxUsers: d.maxUsers, storageMb: d.storageMb, botMonthlyReplies: d.botMonthlyReplies, whatsappEnabled: modules.includes("WHATSAPP"), automationsEnabled: d.automationsEnabled, reportsEnabled: true }, select: { id: true } });
      await tx.tenant.create({ data: { id: tenantId, name: d.name, businessType: d.businessType, status: "DEMO", planId: plan.id, modules, demoExpiresAt: endOfLimaDay(d.expiresAt), provisionedById: actorId } });
      await tx.user.createMany({ data: staff.map((s, i) => ({ tenantId, email: s.email, name: s.name, role: s.role, passwordHash: hashes[i]!, mustChangePassword: true })) });
      const creator = (await tx.user.findFirstOrThrow({ where: { tenantId, role: "OWNER" }, select: { id: true } })).id;

      const gIds = DEMO_FAMILIES.map(() => randomUUID()), cIds = DEMO_FAMILIES.map(() => randomUUID());
      await tx.guardian.createMany({ data: DEMO_FAMILIES.map((f, i) => ({ id: gIds[i]!, tenantId, fullName: f.guardian, dni: demoDni(i), phone: `+51${demoPhone(i)}`, phoneDigits: `51${demoPhone(i)}`, email: `familia${i + 1}.${short}@demo.example.test` })) });
      await tx.child.createMany({ data: DEMO_FAMILIES.map((f, i) => ({ id: cIds[i]!, tenantId, fullName: f.child, birthDate: new Date(`${f.birth}T12:00:00-05:00`), allergies: f.allergy })) });
      await tx.childGuardian.createMany({ data: DEMO_FAMILIES.map((_, i) => ({ tenantId, childId: cIds[i]!, guardianId: gIds[i]!, relationship: "Apoderado", canPickup: true, isEmergencyContact: true })) });
      counts.families = DEMO_FAMILIES.length;
      await tx.product.createMany({ data: DEMO_PRODUCTS.map((x) => ({ tenantId, ...x })) });
      counts.products = DEMO_PRODUCTS.length;
      if (has("PLAYGROUND")) {
        await tx.playgroundRate.createMany({ data: DEMO_RATES.map((r) => ({ tenantId, ...r })) });
        await tx.prepaidPackage.createMany({ data: DEMO_PACKAGES.map((x) => ({ tenantId, ...x })) });
        await tx.reservationSpace.createMany({ data: DEMO_SPACES.map((s) => ({ tenantId, ...s })) });
        counts.rates = DEMO_RATES.length; counts.packages = DEMO_PACKAGES.length; counts.spaces = DEMO_SPACES.length;
      }
      if (has("DAYCARE")) {
        await tx.enrollment.createMany({ data: [0, 1, 2].map((i) => ({ tenantId, childId: cIds[i]!, schoolYear: year, startDate: `${year}-01-01`, monthlyFeeCents: DEMO_FEE_CENTS, createdById: creator })) });
        counts.enrollments = 3;
      }
      counts.users = staff.length;
    }, TX));
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e instanceof Error ? e.message : "")) throw new BillingError("Ese correo ya está registrado");
    throw e;
  }
  await audit({ tenantId, actorId, action: "superadmin.demo.create", entity: "Tenant", entityId: tenantId, metadata: { expiresAt: d.expiresAt, modules: modules.join(","), users: staff.length } });
  return { tenantId, planName, expiresAt: d.expiresAt, credentials: staff.map((s) => ({ role: s.role, name: s.name, email: s.email, password: s.password })), counts };
}
