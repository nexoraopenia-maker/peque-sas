import { describe, expect, it } from "vitest";
import { hasPermission } from "@/lib/rbac/permissions";
import { generateTempPassword, hashPassword, verifyPassword } from "@/lib/auth/password";

describe("RBAC", () => {
  it("TEACHER no accede a caja ni WhatsApp", () => {
    expect(hasPermission("TEACHER", "cash:use")).toBe(false);
    expect(hasPermission("TEACHER", "whatsapp:use")).toBe(false);
  });
  it("RECEPTION usa caja pero no configura", () => {
    expect(hasPermission("RECEPTION", "cash:use")).toBe(true);
    expect(hasPermission("RECEPTION", "settings:limited")).toBe(false);
  });
  it("ADMIN no gestiona usuarios; OWNER sí", () => {
    expect(hasPermission("ADMIN", "users:manage")).toBe(false);
    expect(hasPermission("OWNER", "users:manage")).toBe(true);
  });
  it("SUPERADMIN no hereda permisos de tenant", () => {
    expect(hasPermission("SUPERADMIN", "families:read")).toBe(false);
  });
});

describe("passwords", () => {
  it("genera contraseñas temporales distintas y verificables por hash", async () => {
    const a = generateTempPassword();
    expect(a).toHaveLength(16);
    expect(a).not.toBe(generateTempPassword());
    expect(await verifyPassword(a, await hashPassword(a))).toBe(true);
  });
});

describe("permisos SUNAT (Fase 15)", () => {
  it("emitir: OWNER/ADMIN/RECEPTION; gestionar panel y notas de crédito: OWNER/ADMIN; TEACHER ninguno", () => {
    for (const r of ["OWNER", "ADMIN", "RECEPTION"] as const) expect(hasPermission(r, "sunat:issue")).toBe(true);
    for (const r of ["OWNER", "ADMIN"] as const) expect(hasPermission(r, "sunat:manage")).toBe(true);
    expect(hasPermission("RECEPTION", "sunat:manage")).toBe(false);
    for (const p of ["sunat:issue", "sunat:manage"] as const) { expect(hasPermission("TEACHER", p)).toBe(false); expect(hasPermission("SUPERADMIN", p)).toBe(false); }
  });
  it("la configuración del PSE (token) es solo del propietario", () => {
    expect(hasPermission("OWNER", "settings:manage")).toBe(true);
    expect(hasPermission("ADMIN", "settings:manage")).toBe(false);
  });
});
