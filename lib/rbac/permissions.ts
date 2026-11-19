// Lógica pura (sin acceso a BD) para poder probarla.
export type Role = "SUPERADMIN" | "OWNER" | "ADMIN" | "RECEPTION" | "TEACHER";

export type Permission =
  | "dashboard:view"
  | "families:read" | "families:write"
  | "cash:use"
  | "reservations:read" | "reservations:write"
  | "playground:use"
  | "teacherboard:use"
  | "whatsapp:use" | "whatsapp:configure"
  | "settings:manage" | "settings:limited"
  | "users:manage"
  | "inventory:manage"
  | "daycare:manage"
  | "daycare:attendance"
  | "coupons:view"
  | "coupons:manage"
  | "marketing:manage"
  | "loyalty:configure"
  | "expenses:record"
  | "expenses:manage"
  | "reports:view"
  | "sunat:issue" | "sunat:manage";

const R = (...p: Permission[]) => new Set<Permission>(p);

// SUPERADMIN opera en un contexto separado: no hereda permisos de tenant.
export const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  SUPERADMIN: R(),
  OWNER: R("dashboard:view", "families:read", "families:write", "cash:use", "reservations:read", "reservations:write",
    "playground:use", "teacherboard:use", "whatsapp:use", "whatsapp:configure", "settings:manage", "settings:limited", "users:manage", "inventory:manage", "daycare:manage", "daycare:attendance", "coupons:view", "coupons:manage", "marketing:manage", "loyalty:configure", "expenses:record", "expenses:manage", "reports:view", "sunat:issue", "sunat:manage"),
  ADMIN: R("dashboard:view", "families:read", "families:write", "cash:use", "reservations:read", "reservations:write",
    "playground:use", "teacherboard:use", "whatsapp:use", "settings:limited", "inventory:manage", "daycare:manage", "daycare:attendance", "coupons:view", "coupons:manage", "marketing:manage", "loyalty:configure", "expenses:record", "expenses:manage", "reports:view", "sunat:issue", "sunat:manage"),
  RECEPTION: R("dashboard:view", "families:read", "families:write", "cash:use", "reservations:read", "reservations:write",
    "playground:use", "whatsapp:use", "daycare:manage", "daycare:attendance", "coupons:view", "expenses:record", "sunat:issue"),
  TEACHER: R("dashboard:view", "families:read", "reservations:read", "teacherboard:use", "playground:use", "daycare:attendance"),
};

export const hasPermission = (role: Role, perm: Permission) => ROLE_PERMISSIONS[role].has(perm);
