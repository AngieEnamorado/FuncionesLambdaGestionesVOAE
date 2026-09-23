/**
 * Corre las pruebas con node:test.
 *
 * Uso: node infra/probar.mjs [filtro]   (filtro: parte del nombre del archivo)
 *
 * Los .test.ts de pruebas/ se bundlean con esbuild, igual que las funciones,
 * y en el bundle src/compartido/db se sustituye por pruebas/dobles/db.ts: el
 * codigo bajo prueba es el mismo que se despliega, pero sus consultas no
 * salen a Azure. Sin dependencias nuevas: esbuild ya estaba y node:test viene
 * con Node.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const carpetaPruebas = join(raiz, "pruebas");
const destino = join(raiz, "dist", "pruebas");
const dobleDb = join(carpetaPruebas, "dobles", "db.ts");
const filtro = process.argv[2] ?? "";

const pruebas = readdirSync(carpetaPruebas, { recursive: true })
  .map(String)
  .filter((archivo) => archivo.endsWith(".test.ts") && archivo.includes(filtro))
  .map((archivo) => join(carpetaPruebas, archivo));

if (pruebas.length === 0) {
  console.error(`No hay pruebas${filtro ? ` que coincidan con "${filtro}"` : ""}.`);
  process.exit(1);
}

const sustituirDb = {
  name: "sustituir-db",
  setup(constructor) {
    constructor.onResolve({ filter: /compartido\/db$/ }, () => ({ path: dobleDb }));
  },
};

rmSync(destino, { recursive: true, force: true });

await build({
  entryPoints: pruebas,
  outdir: destino,
  outbase: carpetaPruebas,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["mssql"],
  plugins: [sustituirDb],
  sourcemap: "inline",
  logLevel: "warning",
});

const compiladas = pruebas.map((archivo) =>
  join(destino, relative(carpetaPruebas, archivo)).replace(/\.ts$/, ".js"),
);

const { status } = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", ...compiladas],
  { stdio: "inherit", cwd: raiz },
);
process.exit(status ?? 1);
