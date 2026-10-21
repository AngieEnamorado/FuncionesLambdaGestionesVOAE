/**
 * Datos de estudiantes que viven en Registro (v2 de la base).
 *
 * Desde la v2 nombre, apellidos, correo, genero, campus y carrera de un
 * estudiante NO se guardan en tblPersonas: se leen en vivo de
 * Catalogo.vwEstudiantesRegistro, que consulta Registro por linked server.
 * Regla del equipo: si Registro tiene el dato, gana Registro; si no (empleado,
 * externo o una cuenta que Registro no conoce), se usa el de nuestra base.
 *
 * Cada busqueda por el linked server cuesta ~100 ms por cuenta, asi que las
 * consultas devuelven numeroCuenta y aqui se completa todo de una sola vez
 * por peticion, nunca fila por fila dentro del SQL. Tampoco se lee Registro
 * dentro de una transaccion: la volveria distribuida (MSDTC).
 */
import { consultar, sql, type Parametro } from "./db";

export interface DatosRegistro {
  numeroCuenta: string;
  nombreCompleto: string | null;
  nombres: string | null;
  apellidos: string | null;
  correo: string | null;
  sexo: "M" | "F" | null;
  idGenero: number | null;
  idCampus: number | null;
  carrera: string | null;
  matriculado: boolean;
}

/** Cuentas por consulta: cada una es un parametro y el IN se vuelve lento. */
const CUENTAS_POR_CONSULTA = 50;

const unir = (...partes: (string | null | undefined)[]) =>
  partes.map((parte) => parte?.trim()).filter(Boolean).join(" ") || null;

/** Registro y tblGeneros comparten codigos: 1 MASCULINO, 2 FEMENINO. */
export function sexoDeGenero(idGenero: unknown, genero?: unknown): "M" | "F" | null {
  const codigo = String(idGenero ?? "").trim().toUpperCase();
  if (codigo === "1" || codigo === "M") return "M";
  if (codigo === "2" || codigo === "F") return "F";
  const texto = String(genero ?? "").trim().toUpperCase();
  if (texto.startsWith("M")) return "M";
  if (texto.startsWith("F")) return "F";
  return null;
}

/** SQL que traduce tblPersonas.idGenero (personas locales) al M/F de siempre. */
export const SEXO_LOCAL = (alias: string) =>
  `CASE ${alias}.idGenero WHEN 1 THEN N'M' WHEN 2 THEN N'F' END`;

/**
 * Busca varias cuentas en Registro. Las que Registro no conoce no vienen en el
 * mapa. Si Registro no responde: con `estricto` el error sube (p. ej. validar
 * una cuenta nueva); sin el, se avisa en CloudWatch y se devuelve lo que haya,
 * para que un listado cargue con los datos locales en vez de caerse.
 */
export async function leerRegistro(
  cuentas: Iterable<string | null | undefined>,
  opciones: { estricto?: boolean } = {},
): Promise<Map<string, DatosRegistro>> {
  const unicas = [...new Set([...cuentas].map((c) => c?.trim()).filter((c): c is string => !!c))];
  const resultado = new Map<string, DatosRegistro>();

  for (let inicio = 0; inicio < unicas.length; inicio += CUENTAS_POR_CONSULTA) {
    const lote = unicas.slice(inicio, inicio + CUENTAS_POR_CONSULTA);
    const parametros: Record<string, Parametro> = {};
    lote.forEach((cuenta, i) => { parametros[`c${i}`] = [sql.NVarChar(15), cuenta]; });

    let filas: Record<string, unknown>[];
    try {
      filas = await consultar(`
        SELECT numeroCuenta, nombreCompleto, primerNombre, segundoNombre, primerApellido,
               segundoApellido, correoInstitucional, idGenero, genero, idCampus, carrera, matriculado
          FROM Catalogo.vwEstudiantesRegistro
         WHERE numeroCuenta IN (${lote.map((_, i) => `@c${i}`).join(", ")})
      `, parametros);
    } catch (error) {
      if (opciones.estricto) throw error;
      console.warn(JSON.stringify({ nivel: "aviso", origen: "registro", cuentas: lote.length, mensaje: (error as Error).message }));
      continue;
    }

    for (const fila of filas) {
      const cuenta = String(fila["numeroCuenta"] ?? "").trim();
      if (!cuenta) continue;
      const idGenero = Number(fila["idGenero"]);
      resultado.set(cuenta, {
        numeroCuenta: cuenta,
        nombreCompleto: (fila["nombreCompleto"] as string | null) ?? null,
        nombres: unir(fila["primerNombre"] as string, fila["segundoNombre"] as string),
        apellidos: unir(fila["primerApellido"] as string, fila["segundoApellido"] as string),
        correo: (fila["correoInstitucional"] as string | null) ?? null,
        sexo: sexoDeGenero(fila["idGenero"], fila["genero"]),
        idGenero: Number.isInteger(idGenero) ? idGenero : null,
        idCampus: (fila["idCampus"] as number | null) ?? null,
        carrera: (fila["carrera"] as string | null) ?? null,
        matriculado: fila["matriculado"] === true || fila["matriculado"] === 1,
      });
    }
  }
  return resultado;
}

/** Que dato de Registro va en cada campo de la fila. */
export type DatoRegistro = "nombres" | "apellidos" | "completo" | "correo" | "sexo" | "idGenero" | "carrera" | "idCampus";

function valor(datos: DatosRegistro, dato: DatoRegistro): unknown {
  switch (dato) {
    case "completo": return datos.nombreCompleto ?? unir(datos.nombres, datos.apellidos);
    case "carrera": return datos.carrera;
    default: return datos[dato];
  }
}

/**
 * Completa en sitio las filas de una consulta con los datos de Registro de su
 * cuenta. `campos` dice que columna de la fila recibe que dato; si Registro no
 * lo tiene, la fila conserva lo que traia de nuestra base. Devuelve las mismas
 * filas para poder encadenarla.
 */
export async function completarConRegistro<T extends Record<string, unknown>>(
  filas: T[],
  campos: Record<string, DatoRegistro>,
  columnaCuenta = "numeroCuenta",
): Promise<T[]> {
  const datos = await leerRegistro(filas.map((fila) => fila[columnaCuenta] as string | null));
  if (datos.size === 0) return filas;
  for (const fila of filas) {
    const deRegistro = datos.get(String(fila[columnaCuenta] ?? "").trim());
    if (!deRegistro) continue;
    for (const [columna, dato] of Object.entries(campos)) {
      const nuevo = valor(deRegistro, dato);
      if (nuevo !== null && nuevo !== undefined) (fila as Record<string, unknown>)[columna] = nuevo;
    }
  }
  return filas;
}

/** Campos de persona que la mayoria de consultas devuelve con sus nombres de siempre. */
export const CAMPOS_PERSONA: Record<string, DatoRegistro> = {
  nombrePersona: "nombres",
  apellidosPersona: "apellidos",
  correoPersona: "correo",
  sexoPersona: "sexo",
  carreraEstudiante: "carrera",
};

/** Una sola fila (o null): misma regla que completarConRegistro. */
export async function completarUnaConRegistro<T extends Record<string, unknown>>(
  fila: T | null,
  campos: Record<string, DatoRegistro> = CAMPOS_PERSONA,
  columnaCuenta = "numeroCuenta",
): Promise<T | null> {
  if (!fila) return null;
  await completarConRegistro([fila], campos, columnaCuenta);
  return fila;
}
