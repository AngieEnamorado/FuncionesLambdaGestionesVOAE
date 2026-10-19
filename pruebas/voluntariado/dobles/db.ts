/**
 * Base de datos simulada para las pruebas de voae-voluntariado.
 *
 * pruebas/voluntariado/correr.mjs la pone en lugar de src/compartido/db al
 * empaquetar: el handler corre igual que en Lambda, pero ninguna consulta sale
 * a Azure. Cada consulta queda en `registro` y la contesta `contestar`, que
 * cada prueba fija con `responder`.
 */
import sql from "mssql";
import type { Parametro } from "../../../src/compartido/db";

export { sql };
export type { Parametro };

export interface Consulta {
  /** El SQL, o el nombre del procedimiento. */
  texto: string;
  /** Solo los valores, sin el tipo mssql: es lo que comparan las pruebas. */
  valores: Record<string, unknown>;
}

type Contestar = (consulta: Consulta) => unknown[];

export const registro: Consulta[] = [];
let contestar: Contestar = () => [];

/** Fija como se contestan las consultas siguientes y vacia el registro. */
export function responder(fn: Contestar): void {
  contestar = fn;
  registro.length = 0;
}

async function atender(texto: string, parametros: Record<string, Parametro>): Promise<unknown[]> {
  const consulta: Consulta = {
    texto,
    valores: Object.fromEntries(Object.entries(parametros).map(([nombre, [, valor]]) => [nombre, valor])),
  };
  registro.push(consulta);
  return contestar(consulta);
}

export async function consultar<T = Record<string, unknown>>(
  consulta: string,
  parametros: Record<string, Parametro> = {},
): Promise<T[]> {
  return (await atender(consulta, parametros)) as T[];
}

export async function consultarUna<T = Record<string, unknown>>(
  consulta: string,
  parametros: Record<string, Parametro> = {},
): Promise<T | null> {
  return (await consultar<T>(consulta, parametros))[0] ?? null;
}

/** Sin transaccion real: el trabajo usa el mismo `consultar` simulado. */
export async function enTransaccion<T>(
  trabajo: (
    ejecutar: <F = Record<string, unknown>>(consulta: string, parametros?: Record<string, Parametro>) => Promise<F[]>,
  ) => Promise<T>,
): Promise<T> {
  return trabajo(consultar);
}

export async function ejecutarProcedimiento<T = Record<string, unknown>>(
  nombre: string,
  parametros: Record<string, Parametro> = {},
): Promise<T[]> {
  return (await atender(nombre, parametros)) as T[];
}

export async function obtenerPool(): Promise<never> {
  throw new Error("La base simulada no tiene pool; use consultar.");
}
