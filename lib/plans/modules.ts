export type ModuleKey = "PLAYGROUND" | "DAYCARE" | "WHATSAPP" | "SUNAT";
const VALID: ModuleKey[] = ["PLAYGROUND", "DAYCARE", "WHATSAPP", "SUNAT"];

/** `modules` se guarda como Json en SQLite; se valida en cada lectura. */
export function tenantHasModule(modules: unknown, key: ModuleKey): boolean {
  return Array.isArray(modules) && modules.some((m) => typeof m === "string" && VALID.includes(m as ModuleKey) && m === key);
}
