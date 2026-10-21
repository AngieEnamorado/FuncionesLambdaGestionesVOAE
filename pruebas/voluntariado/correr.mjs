/**
 * Corre las pruebas de voae-voluntariado con node:test.
 *
 * Uso: node pruebas/voluntariado/correr.mjs [filtro]   (filtro: parte del nombre del archivo)
 *
 * Cada *.test.ts se empaqueta con esbuild igual que la funcion, pero
 * src/compartido/db y src/compartido/archivos se cambian por los dobles de
 * pruebas/voluntariado/dobles/: el codigo bajo prueba es el que se despliega y
 * no sale ninguna consulta a Azure ni a S3.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const carpeta = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(carpeta, "..", "..");
const dobles = join(carpeta, "dobles");
const destino = join(raiz, "dist", "pruebas-voluntariado");
const filtro = process.argv[2] ?? "";

const pruebas = readdirSync(carpeta)
  .filter((archivo) => archivo.endsWith(".test.ts") && archivo.includes(filtro))
  .map((archivo) => join(carpeta, archivo));
if (pruebas.length === 0) {
  console.error(`No hay pruebas${filtro ? ` que coincidan con "${filtro}"` : ""}.`);
  process.exit(1);
}

rmSync(destino, { recursive: true, force: true });
await build({
  entryPoints: pruebas,
  outdir: destino,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["mssql"],
  logLevel: "warning",
  plugins: [{
    name: "dobles-voluntariado",
    setup(b) {
      // Los dobles importan los modulos reales; esos imports no se cambian.
      // Tambien "./db" importado desde src/compartido (p. ej. registro.ts).
      b.onResolve({ filter: /(compartido\/|^\.\/)(db|archivos)$/ }, (args) => {
        if (args.importer.startsWith(dobles)) return undefined;
        if (args.path.startsWith("./") && !/[\\/]src[\\/]compartido[\\/]/.test(args.importer)) return undefined;
        return { path: join(dobles, `${args.path.endsWith("db") ? "db" : "archivos"}.ts`) };
      });
    },
  }],
});

const compiladas = readdirSync(destino).filter((a) => a.endsWith(".test.js")).map((a) => join(destino, a));
const { status } = spawnSync(process.execPath, ["--test", "--enable-source-maps", ...compiladas], {
  cwd: raiz,
  stdio: "inherit",
});
process.exit(status ?? 1);
