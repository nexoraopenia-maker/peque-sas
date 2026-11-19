import { describe, expect, it } from "vitest";
import { isAuthorizedCron } from "@/lib/security/cron";

const S = "0123456789abcdef0123";
const req = (auth?: string) => new Request("http://x", { headers: auth ? { authorization: auth } : {} });

describe("isAuthorizedCron", () => {
  it("acepta el secreto correcto", () => expect(isAuthorizedCron(req(`Bearer ${S}`), S)).toBe(true));
  it("rechaza ausente, incorrecto o secreto no configurado/débil", () => {
    expect(isAuthorizedCron(req(), S)).toBe(false);
    expect(isAuthorizedCron(req("Bearer nope"), S)).toBe(false);
    expect(isAuthorizedCron(req("Bearer "), "")).toBe(false);
    expect(isAuthorizedCron(req("Bearer abc"), "abc")).toBe(false);
  });
});
