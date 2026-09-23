/**
 * Doble de src/compartido/db para las pruebas.
 *
 * infra/probar.mjs lo pone en lugar del modulo real al bundlear, asi que el
 * codigo bajo prueba corre intacto pero sus consultas no salen a Azure: se
 * registran en `llamadas` y las responde `responder`, que cada prueba ajusta.
 */
import sql from "mssql";
import type { Parametro } from "../../src/compartido/db";

export { sql };
export type { Parametro };

export interface Llamada {
  tipo: "consulta" | "procedimiento";
  /** El SQL, o el nombre del procedimiento. */
  texto: string;
  parametros: Record<string, unknown>;
  /** Los parametros tal como llegaron (tipo mssql + valor), para compilar el SQL contra la base real. */
  crudos: Record<string, Parametro>;
}

type Responder = (llamada: Llamada) => unknown[] | Promise<unknown[]>;

export const llamadas: Llamada[] = [];
let responder: Responder = () => [];

/** Fija como se responden las siguientes consultas y limpia el registro. */
export function alConsultar(fn: Responder): void {
  responder = fn;
  llamadas.length = 0;
}

/** Los valores de los parametros, sin el tipo mssql: es lo que las pruebas comparan. */
const valores = (parametros: Record<string, Parametro>) =>
  Object.fromEntries(Object.entries(parametros).map(([nombre, [, valor]]) => [nombre, valor]));

/** Todas las llamadas de la corrida, sin limpiar entre pruebas: las usa infra/verificar-sql.mjs. */
export const historial: Llamada[] = [];

async function responderA(llamada: Llamada) {
  llamadas.push(llamada);
  historial.push(llamada);
  return responder(llamada);
}

export async function consultar<T = Record<string, unknown>>(
  consulta: string,
  parametros: Record<string, Parametro> = {},
): Promise<T[]> {
  return (await responderA({
    tipo: "consulta", texto: consulta, parametros: valores(parametros), crudos: parametros,
  })) as T[];
}

export async function consultarUna<T = Record<string, unknown>>(
  consulta: string,
  parametros: Record<string, Parametro> = {},
): Promise<T | null> {
  return (await consultar<T>(consulta, parametros))[0] ?? null;
}

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

export async function ejecutarProcedimiento<T = Record<string, unknown>>(
  nombre: string,
  parametros: Record<string, Parametro> = {},
): Promise<T[]> {
  return (await responderA({
    tipo: "procedimiento", texto: nombre, parametros: valores(parametros), crudos: parametros,
  })) as T[];
}

export async function obtenerPool(): Promise<never> {
  throw new Error("El doble de db no tiene pool: use consultar o ejecutarProcedimiento.");
}

/* ------------------------- Volcado para verificar-sql ---------------------- */

/**
 * Con VOAE_SQL_SALIDA definida, al terminar el proceso vuelca cada SQL
 * distinto que se ejecuto con la declaracion T-SQL de sus parametros.
 * infra/verificar-sql.mjs lo compila contra la base real sin ejecutarlo.
 */
const carpetaSalida = process.env["VOAE_SQL_SALIDA"];
if (carpetaSalida) {
  process.on("exit", () => {
    // Interno de mssql: es lo mismo que usa para declarar los parametros de sp_executesql.
    const { declare } = require("mssql/lib/datatypes") as {
      declare: (tipo: unknown, opciones: unknown) => string;
    };
    const declarar = (tipo: Parametro[0]) => {
      const t = (typeof tipo === "function" ? (tipo as () => sql.ISqlType)() : tipo) as { type: unknown };
      return declare(t.type, t);
    };

    const vistas = new Set<string>();
    const unicas = historial
      .map((l) => ({
        tipo: l.tipo,
        texto: l.texto,
        declaraciones: Object.fromEntries(Object.entries(l.crudos).map(([n, [tipo]]) => [n, declarar(tipo)])),
      }))
      .filter((l) => {
        const clave = `${l.tipo}|${l.texto}|${JSON.stringify(l.declaraciones)}`;
        if (vistas.has(clave)) return false;
        vistas.add(clave);
        return true;
      });

    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(carpetaSalida, { recursive: true });
    writeFileSync(`${carpetaSalida}/${process.pid}.json`, JSON.stringify(unicas, null, 2));
  });
}
