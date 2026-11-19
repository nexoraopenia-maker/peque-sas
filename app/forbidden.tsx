import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-bold">Acceso denegado</h1>
      <p className="text-muted-foreground">No tienes permiso para ver esta sección.</p>
      <Link href="/dashboard" className="underline">Volver al inicio</Link>
    </main>
  );
}
