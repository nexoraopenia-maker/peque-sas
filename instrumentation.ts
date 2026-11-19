// Se ejecuta una vez al arrancar el servidor: avisa en los logs si la configuración de producción está incompleta (nunca imprime valores).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { validateEnv } = await import("./lib/env");
  const r = validateEnv();
  if (!r.ok) console.error(`[env] configuración inválida: ${r.errors.join(" | ")}`);
  else if (process.env.NODE_ENV === "production" && r.warnings.length) console.warn(`[env] avisos: ${r.warnings.join(" | ")}`);
}
