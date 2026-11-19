import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-bold">PequesSaaS</h1>
      <p className="text-zinc-400">Administra, automatiza y controla tu centro infantil desde un solo lugar.</p>
      <Link href="/login" className="rounded-md bg-indigo-500 px-4 py-2 font-medium hover:bg-indigo-400">Ingresar</Link>
    </main>
  );
}
