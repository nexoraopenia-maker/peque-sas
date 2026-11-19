"use client";
import { useActionState } from "react";
import { loginAction } from "@/actions/auth";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  const input = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2";
  return (
    <form action={action} className="flex flex-col gap-3">
      <input name="email" type="email" placeholder="Correo" autoComplete="email" required className={input} />
      <input name="password" type="password" placeholder="Contraseña" autoComplete="current-password" required className={input} />
      {state?.error && <p role="alert" className="text-sm text-red-400">{state.error}</p>}
      <button disabled={pending} className="rounded-md bg-indigo-500 px-4 py-2 font-medium disabled:opacity-50">
        {pending ? "Ingresando…" : "Ingresar"}
      </button>
    </form>
  );
}
