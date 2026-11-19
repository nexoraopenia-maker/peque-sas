import { beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { decryptSecret, encryptSecret, generateVerifyToken, hashVerifyToken } from "@/lib/whatsapp/crypto";
import { inServiceWindow, toWaId } from "@/lib/whatsapp/phone";
import { escapeUnicode, signBody, verifySignature } from "@/lib/whatsapp/signature";
import { GraphError, downloadMedia, graph, resolveBase, resolveVersion } from "@/lib/whatsapp/graph";

beforeAll(() => { process.env.AUTH_SECRET = "s".repeat(48); });

describe("cifrado de credenciales (AES-256-GCM)", () => {
  it("ida y vuelta; cada cifrado es distinto; el texto cifrado no contiene el secreto", () => {
    const a = encryptSecret("EAABsbCS1iHgBO-token-largo", "t1", "accessToken");
    const b = encryptSecret("EAABsbCS1iHgBO-token-largo", "t1", "accessToken");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toContain("EAAB");
    expect(decryptSecret(a, "t1", "accessToken")).toBe("EAABsbCS1iHgBO-token-largo");
  });
  it("no descifra con OTRO tenant ni con OTRO campo (datos autenticados)", () => {
    const a = encryptSecret("secreto", "t1", "accessToken");
    expect(() => decryptSecret(a, "t2", "accessToken")).toThrow();
    expect(() => decryptSecret(a, "t1", "appSecret")).toThrow();
  });
  it("detecta manipulación y formatos inválidos", () => {
    const a = encryptSecret("secreto", "t1", "x");
    const parts = a.split(".");
    expect(() => decryptSecret([parts[0], parts[1], parts[2], Buffer.from("otro-texto").toString("base64url")].join("."), "t1", "x")).toThrow();
    expect(() => decryptSecret([parts[0], parts[1], Buffer.alloc(16).toString("base64url"), parts[3]].join("."), "t1", "x")).toThrow();
    for (const bad of ["", "v2.a.b.c", "v1.a.b", "basura"]) expect(() => decryptSecret(bad, "t1", "x"), bad).toThrow();
  });
  it("otra AUTH_SECRET no descifra", () => {
    const a = encryptSecret("secreto", "t1", "x");
    const old = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "z".repeat(48);
    expect(() => decryptSecret(a, "t1", "x")).toThrow();
    process.env.AUTH_SECRET = old;
    expect(decryptSecret(a, "t1", "x")).toBe("secreto");
  });
  it("exige AUTH_SECRET de al menos 32 caracteres", () => {
    const old = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "corto";
    expect(() => encryptSecret("x", "t", "f")).toThrow(/AUTH_SECRET/);
    process.env.AUTH_SECRET = old;
  });
  it("verify token: huella estable y distinta del token", () => {
    const t = generateVerifyToken();
    expect(t.length).toBeGreaterThanOrEqual(30);
    expect(hashVerifyToken(t)).toBe(hashVerifyToken(t));
    expect(hashVerifyToken(t)).not.toContain(t);
    expect(hashVerifyToken(t)).not.toBe(hashVerifyToken(t + "x"));
  });
});

describe("teléfonos y ventana de 24 h", () => {
  it("normaliza a wa_id", () => {
    expect(toWaId("987 654 321")).toBe("51987654321");
    expect(toWaId("+51 987-654-321")).toBe("51987654321");
    expect(toWaId("987654321", "57")).toBe("57987654321");
    expect(toWaId("14155550123")).toBe("14155550123");
  });
  it("rechaza inválidos", () => { for (const b of ["", null, undefined, "123", "0987654321", "abc", "1".repeat(16)]) expect(toWaId(b as string), String(b)).toBeNull(); });
  it("ventana de servicio", () => {
    const now = new Date("2026-01-02T12:00:00Z");
    expect(inServiceWindow(new Date("2026-01-01T12:00:01Z"), now)).toBe(true);
    expect(inServiceWindow(new Date("2026-01-01T12:00:00Z"), now)).toBe(false);
    expect(inServiceWindow(null, now)).toBe(false);
  });
});

describe("firma X-Hub-Signature-256", () => {
  const S = "a".repeat(32);
  const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
  it("acepta el HMAC-SHA256 del cuerpo crudo", () => {
    const h = `sha256=${createHmac("sha256", S).update(body).digest("hex")}`;
    expect(verifySignature(body, h, [S])).toEqual({ ok: true, secret: S });
    expect(signBody(S, body)).toBe(h);
  });
  it("rechaza secreto equivocado, cuerpo alterado, sin cabecera y formatos inválidos", () => {
    const h = signBody(S, body);
    expect(verifySignature(body, h, ["b".repeat(32)]).ok).toBe(false);
    expect(verifySignature(Buffer.from(body.toString() + " "), h, [S]).ok).toBe(false);
    for (const bad of [null, "", "sha256=", "sha1=" + "a".repeat(40), "sha256=" + "z".repeat(64), "sha256=" + "a".repeat(63), h.replace("sha256=", "")]) expect(verifySignature(body, bad, [S]).ok, String(bad)).toBe(false);
    expect(verifySignature(body, h, []).ok).toBe(false);
  });
  it("elige el secreto correcto entre varios", () => {
    const secrets = ["c".repeat(32), S, "d".repeat(32)];
    expect(verifySignature(body, signBody(S, body), secrets)).toEqual({ ok: true, secret: S });
  });
  it("acepta también la variante con Unicode escapado (documentada por Meta) y solo si el HMAC coincide", () => {
    const raw = Buffer.from('{"t":"¡Hola! ñ 😀"}');
    const escaped = escapeUnicode(raw.toString("utf8"));
    expect(escaped).toBe('{"t":"\\u00a1Hola! \\u00f1 \\ud83d\\ude00"}');
    expect(verifySignature(raw, signBody(S, raw), [S]).ok).toBe(true);
    expect(verifySignature(raw, signBody(S, escaped), [S]).ok).toBe(true);
    expect(verifySignature(raw, signBody("e".repeat(32), escaped), [S]).ok).toBe(false);
  });
  it("mayúsculas en el hex de la cabecera son válidas", () => {
    expect(verifySignature(body, signBody(S, body).toUpperCase().replace("SHA256=", "sha256="), [S]).ok).toBe(true);
  });
});

// ---------- Cliente de Graph API con servidor simulado inyectado (doble de pruebas, no código de producción) ----------
type Call = { url: URL; method: string; headers: Record<string, string>; body: any };
function mockFetch(handler: (c: Call) => { status?: number; json?: unknown; bytes?: Buffer }) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const c: Call = { url: new URL(String(input)), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c);
    const status = r.status ?? 200;
    return new Response(r.bytes ? new Uint8Array(r.bytes) : JSON.stringify(r.json ?? {}), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const G = (f: typeof fetch) => ({ token: "TOKEN-SECRETO-123", version: "v27.0", baseUrl: "https://graph.example.test", fetchImpl: f });

describe("cliente Graph API", () => {
  it("envía texto con la forma documentada y el token en la cabecera", async () => {
    const m = mockFetch(() => ({ json: { messages: [{ id: "wamid.1" }] } }));
    const r = await graph.sendText(G(m.impl), "123456789012345", "51987654321", "Hola");
    expect(r.messages[0]!.id).toBe("wamid.1");
    const c = m.calls[0]!;
    expect(c.url.href).toBe("https://graph.example.test/v27.0/123456789012345/messages");
    expect(c.method).toBe("POST");
    expect(c.headers.Authorization).toBe("Bearer TOKEN-SECRETO-123");
    expect(c.body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "51987654321", type: "text", text: { preview_url: false, body: "Hola" } });
  });
  it("envía plantillas con idioma y componentes (incluido el botón de autenticación)", async () => {
    const m = mockFetch(() => ({ json: { messages: [{ id: "wamid.2" }] } }));
    await graph.sendTemplate(G(m.impl), "123456789012345", "51987654321", "codigo_portal", "es", [
      { type: "body", parameters: [{ type: "text", text: "12345678" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "12345678" }] },
    ]);
    expect(m.calls[0]!.body.template).toEqual({ name: "codigo_portal", language: { code: "es" }, components: [
      { type: "body", parameters: [{ type: "text", text: "12345678" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "12345678" }] },
    ] });
    expect(m.calls[0]!.body.type).toBe("template");
  });
  it("suscripción: sin cuerpo, o con override de URL y verify token por WABA", async () => {
    const m = mockFetch(() => ({ json: { success: true } }));
    await graph.subscribeApp(G(m.impl), "111111111111");
    await graph.subscribeApp(G(m.impl), "111111111111", { callbackUrl: "https://app.test/api/webhooks/whatsapp", verifyToken: "vt" });
    expect(m.calls[0]!.body).toBeUndefined();
    expect(m.calls[0]!.url.pathname).toBe("/v27.0/111111111111/subscribed_apps");
    expect(m.calls[1]!.body).toEqual({ override_callback_uri: "https://app.test/api/webhooks/whatsapp", verify_token: "vt" });
  });
  it("mapea errores de Meta con código, detalle y si conviene reintentar; el token nunca aparece", async () => {
    const mk = (status: number, code: number, details?: string) => mockFetch(() => ({ status, json: { error: { message: `(#${code}) falla`, code, type: "OAuthException", error_data: { details }, fbtrace_id: "x" } } }));
    for (const [status, code, retry] of [[400, 131047, false], [400, 132001, false], [401, 190, false], [429, 130429, true], [400, 80007, true], [500, 2, true]] as const) {
      const m = mk(status, code, "detalle");
      const e = (await graph.sendText(G(m.impl), "123456789012345", "51987654321", "x").catch((x) => x)) as GraphError;
      expect(e).toBeInstanceOf(GraphError);
      expect([e.code, e.retryable, e.details]).toEqual([code, retry, "detalle"]);
      expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain("TOKEN-SECRETO");
    }
  });
  it("red caída y tiempo de espera agotado son reintentables y sin datos sensibles", async () => {
    const boom = (async () => { throw new Error("ECONNRESET TOKEN-SECRETO-123"); }) as unknown as typeof fetch;
    const e = (await graph.sendText({ ...G(boom) }, "123456789012345", "51987654321", "x").catch((x) => x)) as GraphError;
    expect(e).toBeInstanceOf(GraphError);
    expect(e.retryable).toBe(true);
    expect(e.message).not.toContain("TOKEN");
    const hang = ((_u: unknown, init?: RequestInit) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("abort"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const t = (await graph.sendText({ ...G(hang), timeoutMs: 30 }, "123456789012345", "51987654321", "x").catch((x) => x)) as GraphError;
    expect(t.message).toMatch(/Tiempo de espera/);
  });
  it("valida los ids de la ruta (sin inyección en la URL)", async () => {
    const m = mockFetch(() => ({ json: {} }));
    for (const bad of ["123/../me", "12", "abc12345", "123456?x=1", "1234567 89", ""]) {
      await expect(graph.getPhoneNumber(G(m.impl), bad), bad).rejects.toThrow(/no válido/);
      await expect(graph.getMediaInfo(G(m.impl), bad), bad).rejects.toThrow(/no válido/);
    }
    expect(m.calls).toHaveLength(0);
  });
  it("versión y URL base: validadas; producción exige https", () => {
    expect(resolveVersion("v27.0")).toBe("v27.0");
    expect(() => resolveVersion("27")).toThrow();
    expect(() => resolveVersion("v27.0/../x")).toThrow();
    expect(resolveBase("https://graph.facebook.com/")).toBe("https://graph.facebook.com");
    expect(() => resolveBase("http://graph.facebook.com")).toThrow(/https/);
    const env = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(() => resolveBase("http://localhost:9999")).toThrow(/https/);
    (process.env as Record<string, string>).NODE_ENV = env!;
    expect(resolveBase("http://localhost:9999")).toBe("http://localhost:9999");
  });
});

describe("descarga de archivos", () => {
  const bytes = Buffer.from("contenido-del-archivo");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const flow = (over: { sha?: string; size?: number; status?: number; bytes?: Buffer } = {}) => mockFetch((c) =>
    c.url.pathname.endsWith("/55555")
      ? { json: { id: "55555", url: "https://media.example.test/f/1", mime_type: "image/jpeg", sha256: over.sha ?? sha, file_size: over.size ?? bytes.length } }
      : { status: over.status ?? 200, bytes: over.bytes ?? bytes });
  it("2 pasos con el mismo token, verifica sha256", async () => {
    const m = flow();
    const r = await downloadMedia(G(m.impl), "55555");
    expect(r.bytes.equals(bytes)).toBe(true);
    expect(r.mime).toBe("image/jpeg");
    expect(m.calls[0]!.url.pathname).toBe("/v27.0/55555");
    expect(m.calls[1]!.url.href).toBe("https://media.example.test/f/1");
    expect(m.calls[1]!.headers.Authorization).toBe("Bearer TOKEN-SECRETO-123");
  });
  it("rechaza huella distinta, tamaño excesivo y descarga fallida", async () => {
    await expect(downloadMedia(G(flow({ sha: "0".repeat(64) }).impl), "55555")).rejects.toThrow(/sha256/);
    await expect(downloadMedia(G(flow({ size: 999_999_999 }).impl), "55555", 1000)).rejects.toThrow(/tamaño/);
    await expect(downloadMedia(G(flow({ status: 404 }).impl), "55555")).rejects.toMatchObject({ retryable: true });
  });
  it("con la URL base de Meta por defecto, solo hosts de Meta (anti-SSRF)", async () => {
    const m = mockFetch(() => ({ json: { id: "55555", url: "https://evil.example.com/steal", mime_type: "image/jpeg" } }));
    await expect(downloadMedia({ token: "t", fetchImpl: m.impl }, "55555")).rejects.toThrow(/no permitida/);
    const http = mockFetch(() => ({ json: { id: "55555", url: "http://lookaside.fbsbx.com/x", mime_type: "image/jpeg" } }));
    await expect(downloadMedia({ token: "t", fetchImpl: http.impl }, "55555")).rejects.toThrow(/no permitida/);
  });
});
