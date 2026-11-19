// Verifica las variables de entorno SIN mostrar sus valores. Uso (con Node 22.6+):
//   NODE_ENV=production node --env-file=.env.production.local scripts/env-check.ts
//   npm run env:check   (usa .env.local)
import { validateEnv } from "../lib/env.ts";

const r = validateEnv();
console.log(`Entorno: ${process.env.NODE_ENV ?? "development"}`);
for (const e of r.errors) console.log(`  ERROR  ${e}`);
for (const w of r.warnings) console.log(`  AVISO  ${w}`);
console.log(r.ok ? "OK: las variables obligatorias están completas." : `FALLÓ: ${r.errors.length} error(es).`);
process.exit(r.ok ? 0 : 1);
