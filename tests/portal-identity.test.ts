import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { formatAccessCode, generateAccessCode, generatePortalCode, guardianIdentity, hashAccessCode, normalizeCode, normalizeIdentifier, normalizePortalCode, rateKeys, safeEqualHex } from "@/lib/portal/identity";
import { signGuardianToken, verifyGuardianToken } from "@/lib/portal/session";

const SECRET = "x".repeat(40);
beforeAll(() => { process.env.AUTH_SECRET = SECRET; });

describe("identificadores", () => {
  it("DNI de 8 dígitos y teléfono de 9 (con o sin prefijo 51)", () => {
    expect(normalizeIdentifier("12 345 678")).toEqual({ kind: "dni", value: "12345678" });
    expect(normalizeIdentifier("987-654-321")).toEqual({ kind: "phone", value: "987654321" });
    expect(normalizeIdentifier("+51 987 654 321")).toEqual({ kind: "phone", value: "987654321" });
  });
  it("rechaza longitudes inválidas y texto", () => {
    for (const bad of ["", "1234567", "1234567890", "abc", "5198765432", "12345678901234"]) expect(normalizeIdentifier(bad), bad).toBeNull();
  });
  it("identidad que se guarda del apoderado", () => {
    expect(guardianIdentity({ dni: "12.345.678", phone: "+51 987 654 321" })).toEqual({ dni: "12345678", phoneDigits: "987654321" });
    expect(guardianIdentity({ dni: null, phone: "123" })).toEqual({ dni: null, phoneDigits: null });
  });
});

describe("códigos de acceso", () => {
  it("8 dígitos, formateables y normalizables", () => {
    for (let i = 0; i < 200; i++) expect(generateAccessCode()).toMatch(/^\d{8}$/);
    expect(formatAccessCode("12345678")).toBe("1234 5678");
    expect(normalizeCode("1234 5678")).toBe("12345678");
  });
  it("son aleatorios (sin repetición en una muestra)", () => {
    expect(new Set(Array.from({ length: 300 }, generateAccessCode)).size).toBeGreaterThan(295);
  });
  it("el hash depende del id y del código, y se compara en tiempo constante", () => {
    const h = hashAccessCode("id1", "12345678");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("12345678");
    expect(safeEqualHex(h, hashAccessCode("id1", "12345678"))).toBe(true);
    expect(safeEqualHex(h, hashAccessCode("id2", "12345678"))).toBe(false);
    expect(safeEqualHex(h, hashAccessCode("id1", "12345679"))).toBe(false);
    expect(safeEqualHex(h, "zz")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
  });
  it("claves de limitación no contienen el DNI ni el código del portal en claro", () => {
    const k = rateKeys("ABCD2345", "12345678");
    expect(k.perIdentifier).not.toContain("12345678");
    expect(k.perPortal).not.toContain("ABCD2345");
    expect(rateKeys("abcd2345", "12345678")).toEqual(k); // el portal no distingue mayúsculas
  });
  it("código de portal: alfabeto sin ambiguos y normalización", () => {
    for (let i = 0; i < 100; i++) expect(generatePortalCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(normalizePortalCode(" ab-cd 2345 ")).toBe("ABCD2345");
  });
});

describe("sesión del apoderado", () => {
  const key = new TextEncoder().encode(SECRET);
  it("token válido se verifica", async () => {
    expect(await verifyGuardianToken(await signGuardianToken({ gid: "g", tid: "t", sv: 2 }))).toEqual({ gid: "g", tid: "t", sv: 2 });
  });
  it("un token de PERSONAL (uid, sin typ=parent) NO sirve como apoderado", async () => {
    const staff = await new SignJWT({ uid: "u1", sv: 0 }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(key);
    expect(await verifyGuardianToken(staff)).toBeNull();
  });
  it("tokens manipulados, de otra clave o vencidos se rechazan", async () => {
    const t = await signGuardianToken({ gid: "g", tid: "t", sv: 0 });
    expect(await verifyGuardianToken(t.slice(0, -3) + "AAA")).toBeNull();
    const other = await new SignJWT({ gid: "g", tid: "t", sv: 0, typ: "parent" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode("y".repeat(40)));
    expect(await verifyGuardianToken(other)).toBeNull();
    const expired = await new SignJWT({ gid: "g", tid: "t", sv: 0, typ: "parent" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("-10s").sign(key);
    expect(await verifyGuardianToken(expired)).toBeNull();
    expect(await verifyGuardianToken("no-es-un-jwt")).toBeNull();
  });
  it("alg none no es aceptado", async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ gid: "g", tid: "t", sv: 0, typ: "parent" })).toString("base64url")}.`;
    expect(await verifyGuardianToken(none)).toBeNull();
  });
});
