/**
 * Errores HTTP y traduccion de errores de SQL Server.
 *
 * Las reglas de negocio viven en los triggers. Cuando uno rechaza una
 * operacion su mensaje es el mensaje para el usuario, asi que sale como 4xx
 * legible y no enterrado en un 500 generico.
 */

/** Error con codigo HTTP explicito. Lo que no sea esto se trata como 500. */
export class ErrorHttp extends Error {
  readonly codigo: number;
  readonly detalles?: unknown;

  constructor(codigo: number, mensaje: string, detalles?: unknown) {
    super(mensaje);
    this.name = "ErrorHttp";
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

export const noEncontrado = (mensaje: string) => new ErrorHttp(404, mensaje);
export const solicitudInvalida = (mensaje: string, detalles?: unknown) =>
  new ErrorHttp(400, mensaje, detalles);
export const conflicto = (mensaje: string) => new ErrorHttp(409, mensaje);

/** Forma de un error de la libreria mssql/tedious. */
interface ErrorSql {
  number?: number;
  code?: string;
  message?: string;
  precedingErrors?: ErrorSql[];
}

/**
 * RAISERROR/THROW de un trigger o procedimiento llega siempre con numero
 * 50000 (o >= 50000 si el mensaje es de sys.messages). Ese texto lo escribio
 * quien modelo la regla de negocio, en espaniol y pensado para mostrarse.
 */
const esErrorDeReglaDeNegocio = (numero: number | undefined): boolean =>
  numero !== undefined && numero >= 50000;

/**
 * Un THROW dentro de un trigger puede llegar en `precedingErrors` en vez de
 * en el error de arriba, segun como aborte el lote. Se busca en ambos.
 */
function mensajeDeReglaDeNegocio(error: ErrorSql): string | null {
  if (esErrorDeReglaDeNegocio(error.number) && error.message) return error.message;
  for (const previo of error.precedingErrors ?? []) {
    if (esErrorDeReglaDeNegocio(previo.number) && previo.message) return previo.message;
  }
  return null;
}

/**
 * Traduce un error de SQL Server a un ErrorHttp. Lo que no reconoce lo deja
 * pasar como 500 para no inventar semantica: un error desconocido de la base
 * es un fallo del servidor hasta que se demuestre lo contrario.
 */
export function traducirErrorSql(error: unknown): ErrorHttp | null {
  if (error instanceof ErrorHttp) return error;
  if (typeof error !== "object" || error === null) return null;

  const sqlError = error as ErrorSql;

  const mensajeNegocio = mensajeDeReglaDeNegocio(sqlError);
  if (mensajeNegocio) {
    // 409: la peticion estaba bien formada pero choca con el estado actual
    // del dominio (transicion de estado invalida, cancelacion incoherente,
    // matricula excepcional sin motivo...).
    return new ErrorHttp(409, mensajeNegocio);
  }

  switch (sqlError.number) {
    case 2627: // violacion de PRIMARY KEY o UNIQUE
    case 2601: // violacion de indice unico
      return new ErrorHttp(409, "Ya existe un registro con esos datos.");
    case 547: // violacion de FOREIGN KEY o CHECK
      return new ErrorHttp(
        409,
        "La operacion no cumple una restriccion de la base de datos (referencia inexistente o valor no permitido).",
      );
    case 515: // insercion de NULL en columna NOT NULL
      return new ErrorHttp(400, "Falta un campo obligatorio.");
    case 245: // conversion fallida
    case 8114:
      return new ErrorHttp(400, "Un valor enviado no tiene el tipo esperado.");
    case 8152: // dato mas largo que la columna
    case 2628:
      return new ErrorHttp(400, "Un valor enviado excede el largo permitido.");
    default:
      break;
  }

  // La base serverless puede estar pausada o saturada: el primer intento
  // tras la inactividad falla mientras reanuda.
  if (
    sqlError.code === "ETIMEOUT" ||
    sqlError.code === "ESOCKET" ||
    sqlError.code === "ECONNCLOSED" ||
    sqlError.number === 40613 || // "Database is not currently available"
    sqlError.number === 49918 ||
    sqlError.number === 49919 ||
    sqlError.number === 49920
  ) {
    return new ErrorHttp(
      503,
      "La base de datos no esta disponible en este momento. Reintente en unos segundos.",
    );
  }

  return null;
}
