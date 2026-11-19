import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { UNSCOPED_MODELS } from "@/lib/db/tenant";

// Regresión: tenantDb filtra por defecto todos los modelos salvo los globales. Esta prueba garantiza que
// (a) todo modelo fuera de la lista global tiene tenantId (AuditLog lo admite nulo) y (b) ningún modelo con tenantId obligatorio queda sin filtrar (User lo tiene opcional: SUPERADMIN).
const schema = readFileSync("prisma/schema.prisma", "utf8");
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1]!, hasTenantId: /^\s+tenantId\s+String/m.test(m[2]!), requiredTenantId: /^\s+tenantId\s+String(?!\?)/m.test(m[2]!) }));

describe("tenantDb: cobertura de modelos", () => {
  it("hay modelos en el esquema", () => expect(models.length).toBeGreaterThan(20));
  it("todo modelo con tenantId obligatorio está filtrado (no figura como global)", () => {
    const leaked = models.filter((m) => m.requiredTenantId && UNSCOPED_MODELS.includes(m.name)).map((m) => m.name);
    expect(leaked).toEqual([]);
  });
  it("todo modelo filtrado tiene tenantId", () => {
    const missing = models.filter((m) => !UNSCOPED_MODELS.includes(m.name) && !m.hasTenantId).map((m) => m.name);
    expect(missing).toEqual([]);
  });
  it("los modelos globales existen", () => {
    for (const n of UNSCOPED_MODELS) expect(models.map((m) => m.name)).toContain(n);
  });
});
