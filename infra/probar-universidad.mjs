/**
 * Prueba PROCAD completo (frontend + backend) contra el SQL Server de la
 * universidad, desde una PC que este en su red. Un solo comando:
 *
 *   node infra/probar-universidad.mjs
 *
 * 1. Pide los datos de la base (la primera vez) y los guarda en .env.local.
 * 2. Apunta el frontend al backend local con FrontEnd-Gestiones-VOAE/.env.development.local,
 *    que Vite lee por encima de .env.local: no se toca la configuracion de nadie,
 *    y borrando ese archivo el frontend vuelve a usar AWS.
 * 3. Arranca el backend: procad (con escritura) y catalogo (periodos y campus
 *    de la misma base; el de AWS lee Azure).
 * 4. Comprueba que lee de la base y de Registro, y dice que fallo si algo falla.
 * 5. Arranca el frontend (npm run dev).
 *
 * Ctrl+C detiene los dos.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUERTO = 3000;
const PUERTO_CATALOGO = 3001;
const API = `http://localhost:${PUERTO}/v1/procad`;
const API_CATALOGO = `http://localhost:${PUERTO_CATALOGO}/v1/catalogo`;
const esWindows = process.platform === "win32";

const ok = (texto) => console.log(`  ✔ ${texto}`);
const mal = (texto) => console.log(`  ✖ ${texto}`);
const paso = (texto) => console.log(`\n== ${texto}`);

/** Pregunta por consola. Con `oculto`, no muestra lo que se escribe (contrasenias). */
function preguntar(texto, { porDefecto = "", oculto = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (oculto) {
    rl._writeToOutput = (s) => rl.output.write(s.includes(texto) ? s : "");
  }
  const sufijo = porDefecto ? ` [${porDefecto}]` : "";
  return new Promise((resolver) => {
    rl.question(`  ${texto}${sufijo}: `, (respuesta) => {
      rl.close();
      if (oculto) process.stdout.write("\n");
      resolver(respuesta.trim() || porDefecto);
    });
  });
}

/* ---------------------- 1. Datos de la base (.env.local) ------------------- */

async function configurarBackend() {
  paso("1. Conexion a la base de la universidad");
  const archivo = join(raiz, ".env.local");

  const idSecreto = existsSync(archivo) && readFileSync(archivo, "utf8").match(/^ID_SECRETO_VOAE=(\S+)/m)?.[1];
  if (idSecreto) {
    ok(`Se usan las credenciales de ${idSecreto} (Secrets Manager, credenciales de AWS de esta PC)`);
    return;
  }

  if (existsSync(archivo) && /^VOAE_DB_SERVER=\S+/m.test(readFileSync(archivo, "utf8"))) {
    const servidor = readFileSync(archivo, "utf8").match(/^VOAE_DB_SERVER=(\S+)/m)[1];
    const usar = await preguntar(`Ya hay datos guardados (servidor ${servidor}). Usarlos? (s/n)`, { porDefecto: "s" });
    if (usar.toLowerCase().startsWith("s")) {
      ok("Se usan los datos de .env.local");
      return;
    }
  }

  console.log("  Pidale estos datos a quien administra la base (o mirelos en SQL Server Management Studio).");
  const servidor = await preguntar("IP o nombre del servidor (ej. 10.8.1.20)");
  const puerto = await preguntar("Puerto", { porDefecto: "1433" });
  const base = await preguntar("Base de datos", { porDefecto: "DbGestionProcesosVoae" });
  const usuario = await preguntar("Usuario de SQL");
  const clave = await preguntar("Contrasenia (no se ve al escribir)", { oculto: true });
  if (!servidor || !usuario || !clave) {
    mal("Faltan datos: servidor, usuario y contrasenia son obligatorios.");
    process.exit(1);
  }

  writeFileSync(archivo, [
    "# Lo genero infra/probar-universidad.mjs. Git lo ignora.",
    `VOAE_DB_SERVER=${servidor}`,
    `VOAE_DB_PORT=${puerto}`,
    `VOAE_DB_NAME=${base}`,
    `VOAE_DB_USER=${usuario}`,
    `VOAE_DB_PASSWORD=${clave}`,
    "VOAE_DB_TRUST_SERVER_CERTIFICATE=true",
    "VOAE_DB_REQUEST_TIMEOUT_MS=20000",
    "",
  ].join("\n"));
  ok("Guardado en .env.local");
}

/* ------------------------ 2. Frontend -> backend local --------------------- */

async function configurarFrontend() {
  paso("2. Frontend apuntando al backend de esta PC");
  let carpeta = resolve(raiz, "..", "FrontEnd-Gestiones-VOAE");
  while (!existsSync(join(carpeta, "package.json"))) {
    const respuesta = await preguntar("No encuentro FrontEnd-Gestiones-VOAE. Ruta de la carpeta del frontend");
    if (!respuesta) process.exit(1);
    carpeta = resolve(respuesta.replace(/^"|"$/g, ""));
  }

  writeFileSync(join(carpeta, ".env.development.local"), [
    "# Lo genero FuncionesLambdaGestionesVOAE/infra/probar-universidad.mjs.",
    "# Manda PROCAD al backend de esta PC (y de ahi a la base de la universidad).",
    "# Borre este archivo para volver a usar las Lambdas de AWS.",
    `VITE_API_PROCAD_URL=${API}`,
    `VITE_API_CATALOGO_URL=${API_CATALOGO}`,
    "",
  ].join("\n"));
  ok(`PROCAD usara ${API}`);
  return carpeta;
}

/* ------------------------------ 3. Backend --------------------------------- */

function instalarSiFalta(carpeta, nombre) {
  if (existsSync(join(carpeta, "node_modules"))) return;
  console.log(`  Instalando dependencias de ${nombre} (solo la primera vez)...`);
  const r = spawnSync("npm", ["install"], { cwd: carpeta, stdio: "inherit", shell: esWindows });
  if (r.status !== 0) {
    mal(`npm install fallo en ${nombre}.`);
    process.exit(1);
  }
}

function arrancarFuncion(funcion, argumentos) {
  const proceso = spawn(process.execPath, [join(raiz, "infra", "servidor-local.mjs"), funcion, ...argumentos], {
    cwd: raiz,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolver) => {
    let listo = false;
    const mostrar = (trozo) => {
      for (const linea of trozo.toString().split(/\r?\n/)) {
        if (linea.trim()) console.log(`  [${funcion}] ${linea}`);
        if (linea.includes("escuchando en") && !listo) {
          listo = true;
          resolver(proceso);
        }
      }
    };
    proceso.stdout.on("data", mostrar);
    proceso.stderr.on("data", mostrar);
    proceso.on("exit", (codigo) => {
      if (!listo) {
        mal(`${funcion} no arranco (codigo ${codigo}). Revise el mensaje de arriba.`);
        process.exit(1);
      }
    });
  });
}

/* ----------------------------- 4. Comprobacion ----------------------------- */

const PISTAS = [
  [/ETIMEOUT|ESOCKET|ECONNREFUSED|no esta disponible/i,
    "No llega al servidor: revise la IP y el puerto, y que esta PC este en la red de la universidad."],
  [/Login failed|18456/i, "Usuario o contrasenia incorrectos. Borre .env.local y vuelva a correr este comando."],
  [/certificate/i, "Problema de certificado: revise VOAE_DB_TRUST_SERVER_CERTIFICATE=true en .env.local."],
  [/Invalid column|Invalid object/i,
    "Falta algo en la base: hay que ejecutar sql/procad_sobre_v2.sql (y los scripts v2) en el servidor."],
  [/linked server|7202|7411|7399|ANONYMOUS/i,
    "La base responde, pero el linked server de Registro falla: eso lo resuelve quien administra el servidor."],
];

async function comprobar(ruta, descripcion) {
  try {
    const respuesta = await fetch(`${API}${ruta}`);
    const cuerpo = await respuesta.json().catch(() => ({}));
    if (respuesta.ok) {
      const cantidad = Array.isArray(cuerpo) ? ` (${cuerpo.length} filas)` : "";
      ok(`${descripcion}${cantidad}`);
      return true;
    }
    mal(`${descripcion}: ${respuesta.status} ${cuerpo.error ?? ""}`);
    const pista = PISTAS.find(([patron]) => patron.test(JSON.stringify(cuerpo)));
    if (pista) console.log(`    -> ${pista[1]}`);
    return false;
  } catch (error) {
    mal(`${descripcion}: ${error.message}`);
    return false;
  }
}

/* -------------------------------- Principal -------------------------------- */

await configurarBackend();
const carpetaFrontend = await configurarFrontend();
paso("3. Arrancando el backend (procad y catalogo)");
instalarSiFalta(raiz, "el backend");
const procad = await arrancarFuncion("procad", ["--escritura"]);
const catalogo = await arrancarFuncion("catalogo", ["--puerto", String(PUERTO_CATALOGO)]);
const backend = { kill: () => { procad.kill(); catalogo.kill(); } };

paso("4. Comprobando la base");
const leeBase = await comprobar("/grupos", "Lee de la base (GET /grupos)");
const leeRegistro = leeBase && await comprobar("/solicitudes", "Lee estudiantes de Registro (GET /solicitudes)");
if (!leeBase) {
  console.log("\n  El backend no pudo leer la base. Corrija lo indicado y vuelva a correr este comando.");
  backend.kill();
  process.exit(1);
}
if (!leeRegistro) {
  console.log("  Se puede seguir: lo que no dependa de Registro va a funcionar.");
}

paso("5. Arrancando el frontend");
instalarSiFalta(carpetaFrontend, "el frontend");
console.log("  Cuando diga 'Local: http://localhost:5173/', abralo en el navegador y entre a PROCAD.");
console.log("  Lo que cree ahi se guarda en la base de la universidad. Ctrl+C detiene todo.\n");
const frontend = spawn("npm", ["run", "dev"], { cwd: carpetaFrontend, stdio: "inherit", shell: esWindows });

const detener = () => {
  backend.kill();
  frontend.kill();
  process.exit(0);
};
process.on("SIGINT", detener);
frontend.on("exit", detener);
