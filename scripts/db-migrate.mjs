// Aplica prisma/migrations/*/migration.sql a Turso (o a un file: local) en orden, una sola vez cada una.
// Nuevas migraciones: `npx prisma migrate diff --from-schema <anterior> --to-schema prisma/schema.prisma --script`
// guardadas como prisma/migrations/NNNN_nombre/migration.sql y revisadas antes de aplicar.
// Uso: node --env-file=.env.local scripts/db-migrate.mjs [--status]
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error("TURSO_DATABASE_URL no configurada");
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

await client.execute(
  "CREATE TABLE IF NOT EXISTS _app_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
);
const applied = new Map((await client.execute("SELECT name, checksum FROM _app_migrations")).rows.map((r) => [r.name, r.checksum]));
const dirs = readdirSync("prisma/migrations", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const statusOnly = process.argv.includes("--status");

for (const name of dirs) {
  const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  if (applied.has(name)) {
    if (applied.get(name) !== checksum) throw new Error(`La migración ${name} ya aplicada fue modificada`);
    console.log(`= ${name} (aplicada)`);
    continue;
  }
  if (statusOnly) { console.log(`· ${name} (pendiente)`); continue; }
  // Un solo lote transaccional: o se aplica completa o no se aplica.
  const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)*$/.test(s));
  await client.batch(
    [...statements.map((s) => ({ sql: s })), { sql: "INSERT INTO _app_migrations (name, checksum) VALUES (?, ?)", args: [name, checksum] }],
    "write",
  );
  console.log(`+ ${name} aplicada (${statements.length} sentencias)`);
}
