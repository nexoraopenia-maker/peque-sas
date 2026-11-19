import { redirect } from "next/navigation";

/** Termina una Server Action de formulario: vuelve a la página, con mensaje de error en ?e= si lo hay. */
export function done(path: string, error?: string): never {
  redirect(error ? `${path}?e=${encodeURIComponent(error)}` : path);
}

/** Como `done`, pero con un mensaje de éxito en ?ok=. */
export function doneOk(path: string, message: string): never {
  redirect(`${path}?ok=${encodeURIComponent(message)}`);
}
