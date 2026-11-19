import { tenantHasModule } from "./modules";

// Lógica pura de límites y funciones por plan (sin BD) para poder probarla.
export type Feature = "WHATSAPP" | "SUNAT" | "REPORTS" | "AUTOMATIONS";
export const FEATURE_LABEL: Record<Feature, string> = { WHATSAPP: "WhatsApp", SUNAT: "Facturación electrónica SUNAT", REPORTS: "Reportes financieros", AUTOMATIONS: "Automatizaciones (chatbot)" };

export type PlanView = { reportsEnabled: boolean; automationsEnabled: boolean };
/** Acceso a una función: los módulos contratados viven en `tenant.modules`; reportes y automatizaciones son banderas del plan. */
export function featureEnabled(tenant: { modules: unknown; plan: PlanView }, f: Feature): boolean {
  switch (f) {
    case "WHATSAPP": return tenantHasModule(tenant.modules, "WHATSAPP");
    case "SUNAT": return tenantHasModule(tenant.modules, "SUNAT");
    case "REPORTS": return tenant.plan.reportsEnabled;
    case "AUTOMATIONS": return tenant.plan.automationsEnabled && tenantHasModule(tenant.modules, "WHATSAPP");
  }
}
export const featureMessage = (f: Feature) => `${FEATURE_LABEL[f]} no está incluido en tu plan actual. Cambia de plan para usarlo.`;
export const userLimitMessage = (max: number) => `Alcanzaste el límite de ${max} usuarios activos de tu plan. Desactiva a alguien o cambia de plan.`;
export const pctUsed = (used: number, limit: number) => (limit <= 0 ? (used > 0 ? 100 : 0) : Math.min(100, Math.round((used / limit) * 100)));
