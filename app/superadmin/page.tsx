import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/rbac";

export default async function SuperAdminHome() {
  await requireSuperAdmin();
  redirect("/superadmin/dashboard");
}
