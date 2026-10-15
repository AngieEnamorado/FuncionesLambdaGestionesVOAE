/**
 * Doble de src/compartido/db para el recorrido contra la base REAL.
 *
 * Misma interfaz que el modulo real, pero toda consulta va a una unica
 * transaccion abierta con iniciarRonda(), y terminarRonda() siempre la
 * revierte: el recorrido ejercita el handler completo contra Azure (triggers,
 * SPs, vistas) sin dejar ni una fila escrita.
 *
 * Dos consecuencias a tener en cuenta al escribir un recorrido:
 * - En una transaccion no puede haber dos consultas a la vez, asi que se
 *   encolan (el codigo usa Promise.all en varias lecturas).
 * - Cuando un trigger hace ROLLBACK revierte TODA la transaccion, no solo su
 *   fila: despues de un rechazo de trigger la ronda ya no sirve. Por eso cada
 *   rechazo esperado va en una ronda propia.
 */
import sql from "mssql";
import type { Parametro } from "../../src/compartido/db";
import { obtenerSecreto } from "../../src/compartido/secretos";

export { sql };
export type { Parametro };

let pool: sql.ConnectionPool | null = null;
let transaccion: sql.Transaction | null = null;
let cola: Promise<unknown> = Promise.resolve();

export async function conectar(): Promise<void> {
  if (pool) return;
  const s = await obtenerSecreto();
  pool = await new sql.ConnectionPool({
    server: s.DB_SERVER,
    database: s.DB_NAME,
    user: s.DB_USER,
    password: s.DB_PASSWORD,
    port: s.DB_PORT ? Number(s.DB_PORT) : 1433,
    options: { encrypt: true, trustServerCertificate: false, useUTC: true },
    // La base serverless puede estar pausada: aqui si conviene esperar a que despierte.
    connectionTimeout: 90_000,
    requestTimeout: 60_000,
  }).connect();
}

export async function desconectar(): Promise<void> {
  await pool?.close();
  pool = null;
}

export async function iniciarRonda(): Promise<void> {
  if (!pool) throw new Error("Llame a conectar() antes de iniciar una ronda.");
  transaccion = new sql.Transaction(pool);
  await transaccion.begin();
}

/** Revierte todo lo de la ronda. Si un trigger ya la aborto, no hay nada que revertir. */
export async function terminarRonda(): Promise<void> {
  const t = transaccion;
  transaccion = null;
  await cola.catch(() => {});
  await t?.rollback().catch(() => {});
}

function enCola<T>(trabajo: () => Promise<T>): Promise<T> {
  const siguiente = cola.then(trabajo, trabajo);
  cola = siguiente.catch(() => {});
  return siguiente;
}

function peticion(parametros: Record<string, Parametro>): sql.Request {
  if (!transaccion) throw new Error("No hay ronda abierta: toda consulta del recorrido va dentro de una.");
  const p = new sql.Request(transaccion);
  for (const [nombre, [tipo, valor]] of Object.entries(parametros)) p.input(nombre, tipo, valor);
  return p;
}

export function consultar<T = Record<string, unknown>>(
  consulta: string,
  parametros: Record<string, Parametro> = {},
): Promise<T[]> {
  return enCola(async () => (await peticion(parametros).query<T>(consulta)).recordset ?? []);
}

export async function consultarUna<T = Record<string, unknown>>(
  consulta: string,
  parametros: Record<string, Parametro> = {},
): Promise<T | null> {
  return (await consultar<T>(consulta, parametros))[0] ?? null;
}

/** Ya se esta dentro de la transaccion de la ronda: el trabajo corre en ella. */
export async function enTransaccion<T>(
  trabajo: (
    ejecutar: <F = Record<string, unknown>>(
      consulta: string,
      parametros?: Record<string, Parametro>,
    ) => Promise<F[]>,
  ) => Promise<T>,
): Promise<T> {
  return trabajo(consultar);
}

export function ejecutarProcedimiento<T = Record<string, unknown>>(
  nombre: string,
  parametros: Record<string, Parametro> = {},
): Promise<T[]> {
  return enCola(async () => (await peticion(parametros).execute<T>(nombre)).recordset ?? []);
}

/** Corre un script con varios lotes separados por GO (una migracion) dentro de la ronda. */
export async function ejecutarScript(texto: string): Promise<void> {
  for (const lote of texto.split(/^\s*GO\s*$/im).map((l) => l.trim()).filter(Boolean)) {
    await enCola(() => peticion({}).batch(lote));
  }
}

export async function obtenerPool(): Promise<never> {
  throw new Error("El recorrido no expone el pool: use consultar.");
}
