import "server-only";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@/lib/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function get(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL no configurada");
  // authToken es obligatorio con libsql:// (Turso); no se usa con file: local.
  const client = new PrismaClient({
    adapter: new PrismaLibSql({ url, authToken: process.env.TURSO_AUTH_TOKEN }),
  });
  globalForPrisma.prisma = client;
  return client;
}

// Proxy perezoso: la conexión se crea en el primer uso, no al importar (build de Next).
export const db = new Proxy({} as PrismaClient, {
  get: (_t, prop) => Reflect.get(get(), prop),
});
