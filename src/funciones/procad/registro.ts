/**
 * Datos de los estudiantes, leidos de Registro (DbVoae v2).
 *
 * Desde la v2 la base ya no guarda los datos personales ni academicos del
 * estudiante: Catalogo.tblPersonas los deja en NULL y tblDetallesEstudiantes
 * solo tiene numeroCuenta. Lo demas se consulta en vivo por el linked server.
 *
 * Para no unir la vista remota con tablas locales (SQL Server puede traerse
 * la tabla completa de Registro para hacer el JOIN), los listados se arman en
 * dos pasos: primero las filas locales con su numeroCuenta, despues UNA sola
 * llamada a Registro.spObtenerEstudiantes con todas las cuentas.
 */
import { ejecutarProcedimiento, sql } from "../../compartido/db";

/** Lo que devuelve Catalogo.vwEstudiantesRegistro (via Registro.spObtenerEstudiantes). */
export interface EstudianteRegistro {
  numeroCuenta: string;
  primerNombre: string | null;
  segundoNombre: string | null;
  primerApellido: string | null;
  segundoApellido: string | null;
  correoInstitucional: string | null;
  telefonoMovil: string | null;
  telefonoFijo: string | null;
  /** CHAR en Registro: llega como "1" / "2", no como numero. */
  idGenero: string | number | null;
  genero: string | null;
  idCampus: number | null;
  centro: string | null;
  carrera: string | null;
  indicePeriodo: number | null;
  indiceGlobal: number | null;
  forma003: string | null;
  matriculado: boolean;
}

const unir = (...partes: (string | null | undefined)[]) =>
  partes.filter((p) => typeof p === "string" && p.trim() !== "").join(" ") || null;

/** Las cuentas se buscan una sola vez, aunque se repitan en las filas. */
export async function estudiantesDeRegistro(cuentas: (string | null | undefined)[]) {
  const unicas = [...new Set(cuentas.filter((c): c is string => typeof c === "string" && c !== ""))];
  if (unicas.length === 0) return new Map<string, EstudianteRegistro>();

  const filas = await ejecutarProcedimiento<EstudianteRegistro>("Registro.spObtenerEstudiantes", {
    cuentas: [sql.NVarChar(sql.MAX), unicas.join(",")],
  });
  return new Map(filas.map((f) => [f.numeroCuenta, f]));
}

/** Datos academicos para la ficha y el panel de solicitudes. Conserva los nombres de columna de la v1. */
export const academicos = (r: EstudianteRegistro) => {
  const idGenero = r.idGenero === null ? null : Number(r.idGenero);
  return {
    idGenero,
    genero: r.genero,
    sexoPersona: idGenero === 1 ? "M" : idGenero === 2 ? "F" : null,
    carreraEstudiante: r.carrera,
    indicePeriodo: r.indicePeriodo,
    indiceGlobal: r.indiceGlobal,
    matriculaVerificada: r.matriculado,
    forma003: r.forma003,
  };
};

/**
 * Llena nombre, apellidos, correo y telefono de cada fila que trae
 * numeroCuenta, con los mismos nombres de columna que antes salian de
 * Catalogo.tblPersonas. Las filas sin cuenta (empleados, externos) quedan
 * como estan: sus datos siguen en la base local. `extra` agrega columnas.
 */
export async function conDatosDeRegistro<T extends Record<string, unknown>>(
  filas: T[],
  extra?: (r: EstudianteRegistro) => Record<string, unknown>,
): Promise<T[]> {
  const registro = await estudiantesDeRegistro(filas.map((f) => f["numeroCuenta"] as string | null));
  return filas.map((fila) => {
    const r = registro.get(fila["numeroCuenta"] as string);
    if (!r) return fila;
    return {
      ...fila,
      nombrePersona: unir(r.primerNombre, r.segundoNombre),
      apellidosPersona: unir(r.primerApellido, r.segundoApellido),
      correoPersona: r.correoInstitucional,
      telefonoPersona: r.telefonoMovil ?? r.telefonoFijo,
      ...extra?.(r),
    };
  });
}

/** El ORDER BY por apellidos ya no sirve en SQL (vienen NULL): se ordena despues de completar. */
export function ordenarPorNombre<T extends Record<string, unknown>>(filas: T[], antes?: (f: T) => string): T[] {
  const texto = (v: unknown) => (typeof v === "string" ? v : "");
  return [...filas].sort((a, b) =>
    (antes ? antes(a).localeCompare(antes(b), "es") : 0)
    || texto(a["apellidosPersona"]).localeCompare(texto(b["apellidosPersona"]), "es")
    || texto(a["nombrePersona"]).localeCompare(texto(b["nombrePersona"]), "es"),
  );
}

/** Busqueda sin importar mayusculas ni tildes. */
export function coincide(texto: string, ...campos: unknown[]): boolean {
  const normal = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const buscado = normal(texto);
  return normal(campos.filter((c) => typeof c === "string").join(" ")).includes(buscado);
}
