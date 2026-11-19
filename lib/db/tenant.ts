import "server-only";
import { db } from "./index";

/**
 * Cliente con aislamiento por tenant: inyecta tenantId en lecturas y
 * escrituras masivas de los modelos operativos. Usar siempre este cliente
 * (con el tenantId de la sesión) en lugar de `db` para datos del establecimiento.
 * Nota: findUnique no admite filtros extra; usar findFirst.
 */
/** Modelos sin tenantId (globales). Cualquier otro modelo DEBE tener tenantId (lo verifica tests/tenant-scope.test.ts). */
export const UNSCOPED_MODELS = ["Plan", "Tenant", "User", "ParentAuthEvent", "PaymentEvent"];

export function tenantDb(tenantId: string) {
  if (!tenantId) throw new Error("tenantId requerido");
  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Seguro por defecto: TODO modelo se filtra por tenant salvo los globales. Un modelo nuevo queda aislado sin tocar este archivo.
          if (UNSCOPED_MODELS.includes(model)) return query(args);
          const a = args as Record<string, any>;
          switch (operation) {
            case "findMany":
            case "findFirst":
            case "findFirstOrThrow":
            case "count":
            case "aggregate":
            case "updateMany":
            case "deleteMany":
              a.where = { ...(a.where ?? {}), tenantId };
              break;
            case "create":
              a.data = { ...a.data, tenantId };
              break;
            case "createMany":
              a.data = (Array.isArray(a.data) ? a.data : [a.data]).map((d: object) => ({ ...d, tenantId }));
              break;
            case "findUnique":
            case "findUniqueOrThrow":
            case "update":
            case "delete":
            case "upsert":
              throw new Error(`${model}.${operation} no permitido en tenantDb: use findFirst/updateMany/deleteMany`);
          }
          return query(a);
        },
      },
    },
  });
}
