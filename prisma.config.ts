import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma CLI solo habla `file:` con SQLite. Para Turso remoto (libsql://) se genera el SQL con
// `prisma migrate diff` y se aplica con scripts/db-apply.mjs (ver docs/PROGRESO.md).
// Si TURSO_DATABASE_URL es `file:...` (desarrollo local) se usa directamente.
const url = process.env.TURSO_DATABASE_URL?.startsWith("file:")
  ? process.env.TURSO_DATABASE_URL
  : "file:./prisma/local.db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url },
});
