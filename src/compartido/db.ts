/**
 * Pool de conexiones a Azure SQL.
 *
 * La base esta en Azure y el computo en AWS, asi que cada contenedor frio
 * abre una conexion TDS por internet publico. El pool se sostiene fuera del
 * handler para pagar ese costo una vez por contenedor y no una vez por
 * request.
 *
 * El techo del sistema es la base, de 1 vCore, no esta capa: el pool es
 * pequenio a proposito y la contencion se hace con concurrencia reservada por
 * funcion, no abriendo mas conexiones.
 */
import sql from "mssql";
import { obtenerSecreto } from "./secretos";

export { sql };

const MAX_CONEXIONES_POR_CONTENEDOR = 5;

let pool: sql.ConnectionPool | null = null;
let conexionEnCurso: Promise<sql.ConnectionPool> | null = null;

async function conectar(): Promise<sql.ConnectionPool> {
  const secreto = await obtenerSecreto();

  const nuevoPool = new sql.ConnectionPool({
    server: secreto.DB_SERVER,
    database: secreto.DB_NAME,
    user: secreto.DB_USER,
    password: secreto.DB_PASSWORD,
    port: secreto.DB_PORT ? Number(secreto.DB_PORT) : 1433,
    options: {
      encrypt: true, // obligatorio en Azure SQL
      trustServerCertificate: false,
      // Las fechas viajan como texto ISO en JSON; leerlas en UTC evita que el
      // huso de la Lambda (UTC) y el de Honduras (UTC-6) se contradigan.
      useUTC: true,
    },
    pool: {
      max: MAX_CONEXIONES_POR_CONTENEDOR,
      min: 0,
      idleTimeoutMillis: 30_000,
    },
    // Si la base serverless esta pausada, reanudar tarda; que el intento
    // falle antes del timeout de la Lambda para poder responder 503.
    connectionTimeout: 8_000,
    requestTimeout: 8_000,
  });

  // Un pool que se cae no debe quedar cacheado: la proxima invocacion tiene
  // que poder reconectar en vez de reusar un objeto muerto.
  nuevoPool.on("error", () => {
    pool = null;
  });

  return nuevoPool.connect();
}

export async function obtenerPool(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool;

  if (!conexionEnCurso) {
    conexionEnCurso = conectar()
      .then((nuevoPool) => {
        pool = nuevoPool;
        return nuevoPool;
      })
      .catch((error) => {
        pool = null;
        throw error;
      })
      .finally(() => {
        conexionEnCurso = null;
      });
  }

  return conexionEnCurso;
}

/** Parametro de una consulta: tipo mssql + valor. */
export type Parametro = [tipo: sql.ISqlType | (() => sql.ISqlType), valor: unknown];

/**
 * Ejecuta una consulta parametrizada. Nunca se interpola texto en el SQL:
 * todo valor de entrada entra como parametro tipado.
 */
export async function consultar<T = Record<string, unknown>>(
  consulta: string,
  parametros: Record<string, Parametro> = {},
): Promise<T[]> {
  const pool = await obtenerPool();
  const peticion = pool.request();

  for (const [nombre, [tipo, valor]] of Object.entries(parametros)) {
    peticion.input(nombre, tipo, valor);
  }

  const resultado = await peticion.query<T>(consulta);
  return resultado.recordset ?? [];
}

/** Igual que `consultar`, pero devuelve la primera fila o null. */
export async function consultarUna<T = Record<string, unknown>>(
  consulta: string,
  parametros: Record<string, Parametro> = {},
): Promise<T | null> {
  const filas = await consultar<T>(consulta, parametros);
  return filas[0] ?? null;
}

/**
 * Corre varias escrituras como una sola unidad. El callback recibe un
 * ejecutor con la misma forma que `consultar`, pero atado a la transaccion.
 * Si lanza, se revierte todo.
 */
export async function enTransaccion<T>(
  trabajo: (
    ejecutar: <F = Record<string, unknown>>(
      consulta: string,
      parametros?: Record<string, Parametro>,
    ) => Promise<F[]>,
  ) => Promise<T>,
): Promise<T> {
  const pool = await obtenerPool();
  const transaccion = new sql.Transaction(pool);
  await transaccion.begin();

  let confirmada = false;
  try {
    const ejecutar = async <F = Record<string, unknown>>(
      consulta: string,
      parametros: Record<string, Parametro> = {},
    ): Promise<F[]> => {
      const peticion = new sql.Request(transaccion);
      for (const [nombre, [tipo, valor]] of Object.entries(parametros)) {
        peticion.input(nombre, tipo, valor);
      }
      const resultado = await peticion.query<F>(consulta);
      return resultado.recordset ?? [];
    };

    const valor = await trabajo(ejecutar);
    await transaccion.commit();
    confirmada = true;
    return valor;
  } finally {
    if (!confirmada) {
      // El rollback puede fallar si la transaccion ya murio (un trigger que
      // hace ROLLBACK la aborta por su cuenta). El error que importa es el
      // original, asi que este se traga.
      await transaccion.rollback().catch(() => {});
    }
  }
}

/**
 * Llama a un procedimiento almacenado. La generacion de actividades en serie
 * y la activacion de periodo ya viven en procedimientos de Procad: se llaman,
 * no se reimplementan.
 */
export async function ejecutarProcedimiento<T = Record<string, unknown>>(
  nombre: string,
  parametros: Record<string, Parametro> = {},
): Promise<T[]> {
  const pool = await obtenerPool();
  const peticion = pool.request();

  for (const [nombreParametro, [tipo, valor]] of Object.entries(parametros)) {
    peticion.input(nombreParametro, tipo, valor);
  }

  const resultado = await peticion.execute<T>(nombre);
  return resultado.recordset ?? [];
}
