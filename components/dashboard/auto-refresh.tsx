"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Solo refresca los datos del servidor; el tiempo se calcula en servidor con timestamps persistidos.
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
