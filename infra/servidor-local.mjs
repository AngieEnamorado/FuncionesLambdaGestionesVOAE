/**
 * Corre las cuatro funciones en esta computadora, como si fueran API Gateway.
 *
 * Uso (desde la raiz del repo):
 *   npm run local
 *
 * Sirve http://localhost:3001/v1/{catalogo|voluntariado|giras|reporteria}/...
 * con el mismo handler que corre en Lambda, empaquetado igual que en
 * construir.mjs. Para lo que AWS no alcanza todavia: el SQL Server 10.8 de la
 * UNAH es una IP privada, asi que hoy solo se puede probar desde la red de la
 * universidad (p. ej. la computadora de la VOAE).
 *
 * Variables (todas con valor por defecto):
 *   ID_SECRETO_VOAE  secreto de Secrets Manager con la base   (secreto-voae-local)
 *   AWS_PROFILE      perfil para leer el secreto y firmar S3  (daniel)
 *   AWS_REGION                                                (us-east-1)
 *   BUCKET_ARCHIVOS  bucket de archivos                       (voae-archivos-643537035326)
 *   PUERTO                                                    (3001)
 *
 * La contrasena no vive aqui ni en el repo: se lee del secreto, igual que en Lambda.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FUNCIONES = ["catalogo", "voluntariado", "giras", "reporteria"];

// Antes de cargar los bundles: secretos.ts lee ID_SECRETO_VOAE al importarse.
// VOAE_ENTORNO=local es lo unico que deja a db.ts honrar DB_CONFIAR_CERTIFICADO.
process.env.VOAE_ENTORNO = "local";
process.env.ID_SECRETO_VOAE ??= "secreto-voae-local";
process.env.AWS_PROFILE ??= "daniel";
process.env.AWS_REGION ??= "us-east-1";
process.env.BUCKET_ARCHIVOS ??= "voae-archivos-643537035326";
const PUERTO = Number(process.env.PUERTO ?? 3001);

const destino = join(raiz, "dist", "local");
mkdirSync(destino, { recursive: true });
const requerir = createRequire(join(raiz, "package.json"));

const handlers = {};
for (const funcion of FUNCIONES) {
  const salida = join(destino, `${funcion}.cjs`);
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
  handlers[funcion] = requerir(salida).handler;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Voae-Usuario",
};

function leerCuerpo(peticion) {
  return new Promise((resolver, rechazar) => {
    const partes = [];
    peticion.on("data", (parte) => partes.push(parte));
    peticion.on("end", () => resolver(Buffer.concat(partes)));
    peticion.on("error", rechazar);
  });
}

createServer(async (peticion, respuesta) => {
  const inicio = Date.now();
  const url = new URL(peticion.url ?? "/", `http://localhost:${PUERTO}`);
  const [, version, dominio] = url.pathname.split("/");
  const handler = version === "v1" ? handlers[dominio] : undefined;

  try {
    if (peticion.method === "OPTIONS") {
      respuesta.writeHead(204, CORS).end();
      return;
    }
    if (!handler) {
      respuesta
        .writeHead(404, { ...CORS, "Content-Type": "application/json" })
        .end(JSON.stringify({ error: `Use /v1/{${FUNCIONES.join("|")}}/...` }));
      return;
    }

    const cuerpo = await leerCuerpo(peticion);
    const consulta = Object.fromEntries(url.searchParams);
    // Evento HTTP API (payload 2.0), lo mismo que manda API Gateway.
    const resultado = await handler({
      version: "2.0",
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: Object.fromEntries(
        Object.entries(peticion.headers).map(([clave, valor]) => [clave, Array.isArray(valor) ? valor.join(",") : valor]),
      ),
      queryStringParameters: Object.keys(consulta).length > 0 ? consulta : undefined,
      requestContext: { http: { method: peticion.method, path: url.pathname }, stage: "$default" },
      body: cuerpo.length > 0 ? cuerpo.toString("utf8") : undefined,
      isBase64Encoded: false,
    });

    respuesta.writeHead(resultado.statusCode, { ...CORS, ...resultado.headers });
    respuesta.end(resultado.isBase64Encoded ? Buffer.from(resultado.body ?? "", "base64") : resultado.body ?? "");
    console.log(`${peticion.method} ${url.pathname} -> ${resultado.statusCode} (${Date.now() - inicio} ms)`);
  } catch (error) {
    console.error(`${peticion.method} ${url.pathname} -> 500`, error);
    respuesta
      .writeHead(500, { ...CORS, "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Error del servidor local; ver la consola." }));
  }
}).listen(PUERTO, () => {
  console.log(`Servidor local en http://localhost:${PUERTO}  (secreto: ${process.env.ID_SECRETO_VOAE})`);
  for (const funcion of FUNCIONES) console.log(`  http://localhost:${PUERTO}/v1/${funcion}`);
});
