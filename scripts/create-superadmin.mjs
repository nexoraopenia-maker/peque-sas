// Crea un usuario SUPERADMIN (global, sin establecimiento). Es la ÚNICA vía para crear uno: la interfaz web no puede asignar ese rol
// y la base de datos lo impide por UPDATE (trigger). La contraseña temporal se genera aquí y se imprime UNA sola vez.
// Uso: node --env-file=.env.local scripts/create-superadmin.mjs correo@empresa.com "Nombre Apellido"
import { createClient } from "@libsql/client";
import { randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const [email, name] = [process.argv[2]?.trim().toLowerCase(), process.argv[3]?.trim()];
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length < 2) {
  console.error('Uso: node --env-file=.env.local scripts/create-superadmin.mjs correo@empresa.com "Nombre Apellido"');
  process.exit(1);
}
const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error("TURSO_DATABASE_URL no configurada");
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*";
const password = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
const exists = (await client.execute({ sql: 'SELECT 1 FROM "User" WHERE "email" = ?', args: [email] })).rows.length > 0;
if (exists) { console.error("Ese correo ya está registrado."); process.exit(1); }

await client.execute({
  sql: 'INSERT INTO "User" ("id","tenantId","email","name","passwordHash","role","mustChangePassword","isActive","failedLogins","sessionVersion","createdAt","updatedAt") VALUES (?,NULL,?,?,?,\'SUPERADMIN\',1,1,0,0,?,?)',
  args: [randomUUID(), email, name, await bcrypt.hash(password, 12), new Date().toISOString(), new Date().toISOString()],
});
await client.execute({ sql: 'INSERT INTO "AuditLog" ("id","tenantId","actorId","action","entity","createdAt") VALUES (?,NULL,NULL,\'superadmin.bootstrap\',\'User\',?)', args: [randomUUID(), new Date().toISOString()] });
console.log(`SUPERADMIN creado: ${email}\nContraseña temporal (se muestra una sola vez; deberás cambiarla al ingresar): ${password}`);
