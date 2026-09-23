/**
 * Compila contra la base real todo el SQL que ejercitan las pruebas, SIN
 * ejecutarlo.
 *
 * Uso: node infra/verificar-sql.mjs [filtro]   (filtro: el mismo de probar.mjs)
 *
 * Las pruebas corren con la base simulada, asi que un nombre de columna mal
 * escrito pasa en verde. Este script cierra ese hueco:
 *
 *   1. Corre las pruebas con VOAE_SQL_SALIDA, y el doble de db vuelca cada
 *      SQL distinto con la declaracion T-SQL de sus parametros.
 *   2. Manda cada uno a Azure envuelto en SET NOEXEC ON: SQL Server lo
 *      compila (resuelve tablas, columnas, tipos, sintaxis) y no ejecuta
 *      nada. No escribe ni una fila, asi que es seguro sobre la base compartida.
 *
 * Necesita credenciales de AWS con permiso de leer secreto-voae, igual que la
 * Lambda. Con la base pausada, la primera conexion puede tardar un minuto.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(raiz, "package.json"));
const sql = require("mssql");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const carpeta = join(raiz, "dist", "sql-verificado");
rmSync(carpeta, { recursive: true, force: true });

// 1. Pruebas, con volcado de SQL.
const pruebas = spawnSync(process.execPath, [join(raiz, "infra", "probar.mjs"), ...process.argv.slice(2)], {
  cwd: raiz,
  env: { ...process.env, VOAE_SQL_SALIDA: carpeta },
  stdio: ["ignore", "ignore", "inherit"],
});
if (pruebas.status !== 0) {
  console.error("Las pruebas fallaron: arreglelas antes de verificar el SQL (corra npm test para ver el detalle).");
  process.exit(1);
}

const vistas = new Set();
const sentencias = readdirSync(carpeta)
  .filter((archivo) => archivo.endsWith(".json"))
  .flatMap((archivo) => JSON.parse(readFileSync(join(carpeta, archivo), "utf8")))
  .filter((s) => {
    const clave = `${s.tipo}|${s.texto}|${JSON.stringify(s.declaraciones)}`;
    if (vistas.has(clave)) return false;
    vistas.add(clave);
    return true;
  });

/** El lote que se compila: parametros declarados en NULL, y el SQL detras de NOEXEC. */
function lote({ tipo, texto, declaraciones }) {
  const nombres = Object.keys(declaraciones);
  const declarar = nombres.length > 0
    ? `DECLARE ${nombres.map((n) => `@${n} ${declaraciones[n]} = NULL`).join(", ")};\n`
    : "";
  const cuerpo = tipo === "procedimiento"
    ? `EXEC ${texto} ${nombres.map((n) => `@${n} = @${n}`).join(", ")}`
    : texto;
  return `${declarar}SET NOEXEC ON;\n${cuerpo}\n;SET NOEXEC OFF;`;
}

// 2. Compilar contra Azure.
const secretos = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const { SecretString } = await secretos.send(
  new GetSecretValueCommand({ SecretId: process.env.ID_SECRETO_VOAE ?? "secreto-voae" }),
);
const s = JSON.parse(SecretString);
const pool = await new sql.ConnectionPool({
  server: s.DB_SERVER,
  database: s.DB_NAME,
  user: s.DB_USER,
  password: s.DB_PASSWORD,
  port: s.DB_PORT ? Number(s.DB_PORT) : 1433,
  options: { encrypt: true, trustServerCertificate: false },
  // La base serverless puede estar pausada: aqui si conviene esperar a que despierte.
  connectionTimeout: 90_000,
  requestTimeout: 30_000,
}).connect();

// Control: si NOEXEC dejara pasar una columna inexistente, este script no serviria de nada.
try {
  await pool.request().batch("SET NOEXEC ON;\nSELECT columnaQueNoExiste FROM Procad.tblGrupos;\n;SET NOEXEC OFF;");
  console.error("El control no fallo: SET NOEXEC no esta detectando columnas inexistentes. Verificacion no confiable.");
  process.exit(2);
} catch {
  // Esperado.
}

const fallas = [];
for (const sentencia of sentencias) {
  try {
    await pool.request().batch(lote(sentencia));
  } catch (error) {
    fallas.push({ sentencia, error });
  }
}
await pool.close();

console.log(`SQL distinto compilado contra ${s.DB_NAME}: ${sentencias.length}`);
if (fallas.length === 0) {
  console.log("Todo compila.");
} else {
  for (const { sentencia, error } of fallas) {
    console.error(`\n✖ ${error.message}\n${sentencia.texto.trim().split("\n").slice(0, 6).join("\n")}\n  ...`);
  }
  console.error(`\n${fallas.length} sentencia(s) no compilan.`);
  process.exit(1);
}
