/**
 * Corre el recorrido de una funcion contra la base REAL, dentro de
 * transacciones que se revierten (ver pruebas/recorrido/).
 *
 * Uso: node infra/recorrido.mjs [funcion] [--migracion archivo.sql ...]
 *      (por defecto: procad)
 *
 * --migracion aplica ese script dentro de cada ronda antes de probar, para
 * ver como se comporta la funcion con un cambio de base que aun no esta en
 * Azure. Tampoco queda aplicado: se revierte con todo lo demas.
 *
 * Necesita credenciales de AWS con permiso de leer secreto-voae. Con la base
 * pausada, la primera conexion puede tardar un minuto.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const migraciones = [];
const resto = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--migracion") migraciones.push(resolve(args[++i] ?? ""));
  else resto.push(args[i]);
}
const funcion = resto[0] ?? "procad";

const entrada = join(raiz, "pruebas", "recorrido", `${funcion}.ts`);
if (!existsSync(entrada)) {
  console.error(`No hay recorrido para ${funcion} (se esperaba ${entrada}).`);
  process.exit(1);
}
for (const m of migraciones) {
  if (!existsSync(m)) {
    console.error(`No existe la migracion ${m}.`);
    process.exit(1);
  }
}

const dobleDb = join(raiz, "pruebas", "dobles", "db-transaccion.ts");
const salida = join(raiz, "dist", "recorrido", `${funcion}.js`);

await build({
  entryPoints: [entrada],
  outfile: salida,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["mssql"],
  sourcemap: "inline",
  logLevel: "warning",
  plugins: [{
    name: "db-en-transaccion",
    setup(b) {
      b.onResolve({ filter: /compartido\/db$/ }, () => ({ path: dobleDb }));
    },
  }],
});

const { status } = spawnSync(process.execPath, ["--enable-source-maps", salida], {
  cwd: raiz,
  stdio: "inherit",
  env: {
    ...process.env,
    AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
    RECORRIDO_MIGRACIONES: migraciones.join(";"),
  },
});
process.exit(status ?? 1);
