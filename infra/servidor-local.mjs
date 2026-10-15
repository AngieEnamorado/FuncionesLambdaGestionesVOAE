/**
 * Levanta una funcion en http://localhost para probarla sin desplegar.
 *
 * Uso: node infra/servidor-local.mjs [funcion] [--puerto 3000] [--escritura]
 *      (por defecto: procad, puerto 3000, solo lectura)
 *
 * Empaqueta la funcion con esbuild igual que construir.mjs y le pasa cada
 * peticion HTTP como el evento que mandaria API Gateway (HTTP API, payload
 * 2.0). El handler es el mismo que se despliega: mismo router, mismas
 * validaciones, misma base de datos.
 *
 * OJO: se conecta a la base REAL de Azure, que es compartida por todo el
 * equipo, con las credenciales de AWS de esta maquina (lee secreto-voae).
 * Por eso arranca en solo lectura: GET pasa, y POST/PUT/DELETE responden 403
 * sin llegar a la funcion. --escritura las habilita, y lo que se escriba
 * queda en la base.
 *
 * Los cambios en el codigo no se recargan solos: detenga (Ctrl+C) y vuelva a
 * arrancar.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FUNCIONES = ["catalogo", "voluntariado", "giras", "procad"];

const args = process.argv.slice(2);
const opcion = (nombre) => {
  const i = args.indexOf(nombre);
  return i === -1 ? undefined : args[i + 1];
};
const funcion = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--puerto") ?? "procad";
const puerto = Number(opcion("--puerto") ?? 3000);
const escritura = args.includes("--escritura");

if (!FUNCIONES.includes(funcion)) {
  console.error(`Funcion desconocida: ${funcion}. Disponibles: ${FUNCIONES.join(", ")}`);
  process.exit(1);
}

// La Lambda corre en us-east-1 y lee el secreto de ahi.
process.env.AWS_REGION ??= "us-east-1";
if (process.env.PERFIL_AWS) process.env.AWS_PROFILE ??= process.env.PERFIL_AWS;

const salida = join(raiz, "dist", "local", `${funcion}.js`);
await build({
  entryPoints: [join(raiz, "src", "funciones", funcion, "index.ts")],
  outfile: salida,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["mssql"],
  sourcemap: "inline",
  logLevel: "warning",
});
const { handler } = createRequire(import.meta.url)(salida);

const METODOS_DE_LECTURA = new Set(["GET", "HEAD", "OPTIONS"]);

function leerCuerpo(peticion) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    peticion.on("data", (t) => trozos.push(t));
    peticion.on("end", () => resolver(Buffer.concat(trozos).toString("utf8")));
    peticion.on("error", rechazar);
  });
}

/** Lo que API Gateway (HTTP API, payload 2.0) le entrega a la Lambda. */
function evento(peticion, cuerpo) {
  const url = new URL(peticion.url, `http://localhost:${puerto}`);
  const consulta = Object.fromEntries(url.searchParams);
  const cabeceras = Object.fromEntries(
    Object.entries(peticion.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
  );
  return {
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: cabeceras,
    queryStringParameters: Object.keys(consulta).length > 0 ? consulta : undefined,
    body: cuerpo === "" ? undefined : cuerpo,
    isBase64Encoded: false,
    requestContext: { http: { method: peticion.method, path: url.pathname }, stage: "$default" },
  };
}

const servidor = createServer(async (peticion, respuesta) => {
  const inicio = Date.now();
  let codigo = 500;
  try {
    if (!escritura && !METODOS_DE_LECTURA.has(peticion.method)) {
      codigo = 403;
      respuesta.writeHead(codigo, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      respuesta.end(JSON.stringify({
        error: "El servidor local esta en solo lectura porque la base de Azure es compartida. " +
          "Arranquelo con --escritura para permitir POST/PUT/DELETE (lo que se escriba queda en la base).",
      }));
      return;
    }

    const resultado = await handler(evento(peticion, await leerCuerpo(peticion)));
    codigo = resultado.statusCode;
    respuesta.writeHead(codigo, resultado.headers);
    respuesta.end(resultado.body);
  } catch (error) {
    // El router ya convierte todo en respuesta; llegar aqui es un fallo del servidor local.
    console.error(error);
    respuesta.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    respuesta.end(JSON.stringify({ error: "Fallo del servidor local.", detalle: String(error) }));
  } finally {
    console.log(`${peticion.method.padEnd(6)} ${String(codigo).padEnd(4)} ${peticion.url}  (${Date.now() - inicio} ms)`);
  }
});

// Solo esta maquina: nadie en la red puede usarlo para llegar a la base.
servidor.listen(puerto, "127.0.0.1", () => {
  console.log(`\nvoae-${funcion} escuchando en http://localhost:${puerto}/v1/${funcion}`);
  console.log(`  Prueba:  http://localhost:${puerto}/v1/${funcion}/salud`);
  console.log(`  Base:    Azure (compartida). Modo: ${escritura ? "LECTURA Y ESCRITURA" : "solo lectura (use --escritura para POST/PUT)"}`);
  console.log("  La primera peticion tarda mas: conecta con Azure y, si la base estaba pausada, la despierta.");
  console.log("  Ctrl+C para detener.\n");
});
