/**
 * Cache en memoria de las tablas de referencia: estados, campus, roles,
 * perfiles y programas. Son decenas de filas, casi estaticas, y casi toda
 * pantalla las pide.
 *
 * El cache vive por contenedor, no es compartido: un cambio en un catalogo
 * tarda hasta el TTL en verse y dos contenedores pueden discrepar mientras
 * tanto. Sirve para datos que cambian una vez por semestre, no para datos
 * operativos.
 */

const TTL_POR_DEFECTO_MS = 10 * 60 * 1000; // 10 minutos

interface Entrada<T> {
  valor: T;
  expiraEn: number;
}

const entradas = new Map<string, Entrada<unknown>>();
/** Cargas en vuelo, para que N invocaciones concurrentes no disparen N consultas. */
const cargasEnCurso = new Map<string, Promise<unknown>>();

/**
 * Devuelve el valor cacheado bajo `clave`, o lo carga con `cargar` y lo
 * guarda. Si la carga falla, no se cachea nada.
 */
export async function enCache<T>(
  clave: string,
  cargar: () => Promise<T>,
  ttlMs: number = TTL_POR_DEFECTO_MS,
): Promise<T> {
  const entrada = entradas.get(clave) as Entrada<T> | undefined;
  if (entrada && entrada.expiraEn > Date.now()) {
    return entrada.valor;
  }

  const enCurso = cargasEnCurso.get(clave) as Promise<T> | undefined;
  if (enCurso) return enCurso;

  const carga = cargar()
    .then((valor) => {
      entradas.set(clave, { valor, expiraEn: Date.now() + ttlMs });
      return valor;
    })
    .finally(() => {
      cargasEnCurso.delete(clave);
    });

  cargasEnCurso.set(clave, carga);
  return carga;
}

/** Invalida una clave, o todo el cache si no se pasa ninguna. */
export function invalidarCache(clave?: string): void {
  if (clave === undefined) entradas.clear();
  else entradas.delete(clave);
}
