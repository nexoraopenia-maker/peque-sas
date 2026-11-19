import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@/lib/generated/prisma/client";

// Integración real contra un SQLite local (mismo motor/adaptador que Turso).
const dir = path.resolve(".test-tmp");
const file = path.join(dir, "test.db");
const url = `file:${file}`;
let db: PrismaClient;
let t1: string, t2: string;

beforeAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const sql = execSync("npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script", { encoding: "utf8" });
  await createClient({ url }).executeMultiple(sql);
  db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  const plan = await db.plan.create({ data: { name: "p", modules: ["PLAYGROUND"] } });
  t1 = (await db.tenant.create({ data: { name: "A", businessType: "x", planId: plan.id } })).id;
  t2 = (await db.tenant.create({ data: { name: "B", businessType: "x", planId: plan.id } })).id;
}, 60000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("integridad multi-tenant (SQLite/libSQL)", () => {
  it("la FK compuesta impide vincular menor y apoderado de tenants distintos", async () => {
    const child = await db.child.create({ data: { tenantId: t1, fullName: "n" } });
    const guardian = await db.guardian.create({ data: { tenantId: t2, fullName: "g" } });
    await expect(
      db.childGuardian.create({ data: { tenantId: t1, childId: child.id, guardianId: guardian.id } }),
    ).rejects.toThrow();
  });

  it("un vínculo del mismo tenant sí se permite", async () => {
    const child = await db.child.create({ data: { tenantId: t1, fullName: "n2" } });
    const guardian = await db.guardian.create({ data: { tenantId: t1, fullName: "g2" } });
    await expect(
      db.childGuardian.create({ data: { tenantId: t1, childId: child.id, guardianId: guardian.id } }),
    ).resolves.toBeTruthy();
  });

  it("la salida condicional no deja stock negativo", async () => {
    const p = await db.product.create({ data: { tenantId: t1, name: "p", priceCents: 1050, stock: 5 } });
    const out = (q: number) =>
      db.product.updateMany({ where: { id: p.id, stock: { gte: q } }, data: { stock: { increment: -q } } });
    expect((await out(9)).count).toBe(0);
    expect((await out(5)).count).toBe(1);
    expect((await out(1)).count).toBe(0);
    expect((await db.product.findFirstOrThrow({ where: { id: p.id } })).stock).toBe(0);
  });

  it("guarda importes en céntimos y modules como JSON", async () => {
    const p = await db.product.create({ data: { tenantId: t2, name: "q", priceCents: 1999 } });
    expect(p.priceCents).toBe(1999);
    const plan = await db.plan.findFirstOrThrow({ where: { name: "p" } });
    expect(plan.modules).toEqual(["PLAYGROUND"]);
  });
});
