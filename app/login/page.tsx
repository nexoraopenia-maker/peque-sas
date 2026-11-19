import { LoginForm } from "./form";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Ingresar</h1>
      <LoginForm />
    </main>
  );
}
