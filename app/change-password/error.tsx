"use client";
import { Button } from "@/components/ui/button";

/** Si algo falla al renderizar o ejecutar la acción, el usuario ve un mensaje en lugar de una pantalla vacía. */
export default function ChangePasswordError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
        Ocurrió un error inesperado al cambiar la contraseña. Inténtalo de nuevo.
      </p>
      <Button onClick={reset}>Reintentar</Button>
    </main>
  );
}
