/**
 * Empaqueta una funcion para Lambda.
 *
 * Uso: node infra/construir.mjs [nombre-funcion ...]   (por defecto: todas)
 *
 * El codigo propio y el cliente de Secrets Manager se bundlean con esbuild
 * en un solo index.js. La unica dependencia que queda fuera es mssql, que
 * viaja como node_modules dentro del zip: su driver (tedious) resuelve
 * modulos en tiempo de ejecucion, y bundlearlo es una forma conocida de
 * romperlo en silencio hasta la primera consulta real.
 *
 * Bundlear el SDK en vez de arrastrarlo entero baja el zip de 15.9 a 13.8 MB.
 * Lo que queda es @azure/identity, 48 MB sin comprimir que tedious arrastra
 * para una autenticacion AAD que no usamos; con el arranque frio medido en
 * 649 ms no vale la pena pelearlo todavia.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paquete = JSON.parse(readFileSync(join(raiz, "package.json"), "utf8"));

const FUNCIONES_DISPONIBLES = ["catalogo", "voluntariado", "giras"];
const pedidas = process.argv.slice(2);
const funciones = pedidas.length > 0 ? pedidas : FUNCIONES_DISPONIBLES;

for (const funcion of funciones) {
  if (!FUNCIONES_DISPONIBLES.includes(funcion)) {
    throw new Error(
      `Funcion desconocida: ${funcion}. Disponibles: ${FUNCIONES_DISPONIBLES.join(", ")}`,
    );
  }

  const destino = join(raiz, "dist", funcion);
  rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });

  await build({
    entryPoints: [join(raiz, "src", "funciones", funcion, "index.ts")],
    outfile: join(destino, "index.js"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    // Solo mssql queda fuera del bundle; el resto entra.
    external: ["mssql"],
    // Sin minificar: una traza de CloudWatch legible vale mas que los KB.
    minify: false,
    sourcemap: false,
    logLevel: "info",
  });

  writeFileSync(
    join(destino, "package.json"),
    JSON.stringify(
      {
        name: `voae-${funcion}`,
        version: paquete.version,
        private: true,
        type: "commonjs",
        main: "index.js",
        dependencies: { mssql: paquete.dependencies.mssql },
      },
      null,
      2,
    ) + "\n",
  );

  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
    cwd: destino,
    stdio: "inherit",
  });

  // package-lock del staging: ruido dentro del zip.
  rmSync(join(destino, "package-lock.json"), { force: true });

  // No hay `zip` en la maquina; python3 si, y produce el mismo formato.
  const rutaZip = join(raiz, "dist", `voae-${funcion}.zip`);
  rmSync(rutaZip, { force: true });
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import shutil,sys",
        "shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])",
      ].join("\n"),
      rutaZip.replace(/\.zip$/, ""),
      destino,
    ],
    { stdio: "inherit" },
  );

  const tamanio = readFileSync(rutaZip).byteLength;
  console.log(`  ${rutaZip}  (${(tamanio / 1024 / 1024).toFixed(1)} MB)`);
}
