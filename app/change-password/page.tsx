import { requireUser } from "@/lib/rbac";
import { ChangePasswordForm } from "./form";

export default async function ChangePasswordPage() {
  await requireUser();
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Cambia tu contraseña</h1>
      <ChangePasswordForm />
    </main>
  );
}
