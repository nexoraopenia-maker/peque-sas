export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{message.slice(0, 200)}</p>;
}

export function OkBanner({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="status" className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm text-green-300">{message.slice(0, 200)}</p>;
}
