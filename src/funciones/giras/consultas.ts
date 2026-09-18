/**
 * Consultas compartidas de voae-giras: estados, usuarios-unidad y giras.
 *
 * Todo el SQL de la funcion vive en este archivo y en solicitudes.ts /
 * inscripciones.ts / catalogos.ts, separado de las rutas, para poder leerlo
 * contra bd_voae_script/DbVoae_final.sql sin ruido de HTTP en medio. Los
 * nombres de columna salen tal como estan en la base.
 *
 * Dos cosas de la base que condicionan todo el SQL de esta funcion:
 *
 *  - Quien actua en Giras (jefe de mision, jefe de aprobacion, viajero,
 *    acompanante) NO es una persona sino una fila de Giras.tblUsuarioUnidad:
 *    la persona en un rol dentro de una unidad. Todos los idJefeMision,
 *    idJefeAprobacion, idViajero... apuntan ahi, no a Catalogo.tblPersonas.
 *  - Nada de OUTPUT en los INSERT/UPDATE: SQL Server lo rechaza (error 334)
 *    sobre tablas con triggers, y tblSolicitudes, tblGiras y tblInscripciones
 *    los tienen. Los ids nuevos se leen con SCOPE_IDENTITY().
 */
import { consultar, consultarUna, sql, type Parametro } from "../../compartido/db";
import { enCache } from "../../compartido/catalogos";
import { noEncontrado } from "../../compartido/errores";

export const CONTEXTO = {
  solicitud: "GIRA_SOLICITUD",
  gira: "GIRA_GIRA",
  inscripcion: "GIRA_INSCRIPCION",
  dictamen: "GIRA_DICTAMEN",
} as const;

/* ------------------------------- Estados --------------------------------
   Catalogo.tblEstados, separado por contextoEstado. Los codigos de Giras se
   escriben tal cual estan sembrados ("Pendiente", "Correccion", "Cancelada
   por gira"): a diferencia de Voluntariado NO estan en mayusculas.        */

export async function idEstado(contexto: string, codigo: string): Promise<number> {
  const mapa = await enCache(`estados:${contexto}`, async () => {
    const filas = await consultar<{ idEstado: number; codigoEstado: string }>(`
      SELECT idEstado, codigoEstado FROM Catalogo.tblEstados
       WHERE contextoEstado = @contexto
    `, { contexto: [sql.NVarChar(40), contexto] });
    return new Map(filas.map((f) => [f.codigoEstado, f.idEstado]));
  });

  const id = mapa.get(codigo);
  if (id === undefined) {
    throw noEncontrado(`No existe el estado ${codigo} en el contexto ${contexto}.`);
  }
  return id;
}

/** Estados de un contexto, para los selectores y badges del frontend. */
export const listarEstados = (contexto: string) =>
  enCache(`giras:estados:${contexto}`, () =>
    consultar(`
      SELECT idEstado, codigoEstado, nombreEstado FROM Catalogo.tblEstados
       WHERE contextoEstado = @contexto ORDER BY idEstado
    `, { contexto: [sql.NVarChar(40), contexto] }),
  );

/* ---------------------- Fragmentos de SQL reutilizados ------------------- */

/** Nombre completo de un usuario-unidad, dada la columna que guarda su id. */
export const nombreDeUsuario = (columnaId: string) => `(
  SELECT p.nombrePersona + N' ' + p.apellidosPersona
    FROM Giras.tblUsuarioUnidad uu
   INNER JOIN Catalogo.tblPersonaPerfilRol ppr ON ppr.idPersonaPerfilRol = uu.idPersonaPerfilRol
   INNER JOIN Catalogo.tblPersonas p ON p.idPersona = ppr.idPersona
   WHERE uu.idUsuarioUnidad = ${columnaId})`;

/** DATE como "2026-08-12": es lo que el frontend espera, sin el desfase de huso de un Date. */
export const fechaIso = (columna: string) => `CONVERT(CHAR(10), ${columna}, 23)`;

/** TIME como "08:30". */
export const horaCorta = (columna: string) => `LEFT(CONVERT(VARCHAR(8), ${columna}, 108), 5)`;

/**
 * Las solicitudes no guardan periodo: se deduce por la fecha de salida contra
 * el rango de cada Catalogo.tblPeriodos. Sin periodo que la contenga, queda NULL.
 */
export const periodoDe = (columnaFecha: string, alias: string) => `
  OUTER APPLY (
    SELECT TOP 1 pe.idPeriodo, pe.anioPeriodo, pe.numeroPac
      FROM Catalogo.tblPeriodos pe
     WHERE ${columnaFecha} BETWEEN pe.fechaInicioPeriodo AND pe.fechaFinPeriodo
     ORDER BY pe.fechaInicioPeriodo DESC
  ) ${alias}`;

/** Fecha (o NULL) → parametro sql.Date. mssql las lee como UTC (useUTC), asi no se corre un dia. */
export const paramFecha = (valor: string | null): Parametro => [sql.Date, valor];

/** "HH:MM" o "HH:MM:SS" → Date en 1970-01-01 UTC, que es como mssql serializa un TIME. */
export function paramHora(valor: string | null): Parametro {
  if (valor === null) return [sql.Time(0), null];
  const [h, m, s] = valor.split(":").map(Number);
  return [sql.Time(0), new Date(Date.UTC(1970, 0, 1, h ?? 0, m ?? 0, s ?? 0))];
}

/* --------------------------- Usuarios-unidad ---------------------------- */

const ROL_POR_SLUG: Record<string, string> = {
  "jefe-mision": "Jefe de mision",
  "jefe-aprobacion": "Jefe de aprobacion",
  viajero: "Viajero",
  administrador: "Administrador",
  estadistico: "Usuario estadistico",
};

export const ROLES_DISPONIBLES = Object.keys(ROL_POR_SLUG);

/** Base comun: un usuario-unidad con su persona, rol, perfil y unidad. Solo roles del sistema GIRAS. */
const USUARIOS_UNIDAD_FROM = `
  FROM Giras.tblUsuarioUnidad uu
 INNER JOIN Catalogo.tblPersonaPerfilRol ppr ON ppr.idPersonaPerfilRol = uu.idPersonaPerfilRol
 INNER JOIN Catalogo.tblPersonas p ON p.idPersona = ppr.idPersona
 INNER JOIN Catalogo.tblRoles r ON r.idRol = ppr.idRol AND r.sistemaRol = N'GIRAS'
 INNER JOIN Catalogo.tblPerfiles pf ON pf.idPerfil = ppr.idPerfil
  LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = p.idPersona
  LEFT JOIN Giras.tblUnidadFacultadCentro ufc ON ufc.idUnidadFacultadCentro = uu.idUnidadFacultadCentro
  LEFT JOIN Catalogo.tblCampus c ON c.idCampus = ufc.idCampus`;

/**
 * Quienes pueden ocupar un rol en el formulario (p. ej. los jefes de
 * aprobacion que ofrece Nueva solicitud). Solo activos.
 */
export function listarUsuariosUnidad(filtros: {
  rol: string | null;
  docentes: boolean;
  idCampus: number | null;
  busqueda: string | null;
}) {
  const parametros: Record<string, Parametro> = {};
  let donde = "WHERE uu.estadoUsuarioUnidad = 1 AND ppr.estadoPersonaPerfilRol = 1";

  if (filtros.rol) {
    donde += " AND r.nombreRol = @rol";
    parametros["rol"] = [sql.NVarChar(50), ROL_POR_SLUG[filtros.rol]];
  }
  if (filtros.docentes) donde += " AND pf.nombre = N'Docente'";
  if (filtros.idCampus !== null) {
    donde += " AND ufc.idCampus = @campus";
    parametros["campus"] = [sql.Int, filtros.idCampus];
  }
  if (filtros.busqueda) {
    donde += " AND (p.nombrePersona + N' ' + p.apellidosPersona LIKE @busqueda OR de.numeroCuenta LIKE @busqueda)";
    parametros["busqueda"] = [sql.NVarChar(120), `%${filtros.busqueda}%`];
  }

  return consultar(`
    SELECT uu.idUsuarioUnidad, uu.idTipoUnidad, uu.idUnidadFacultadCentro,
           p.idPersona, p.nombrePersona + N' ' + p.apellidosPersona AS nombreCompleto,
           p.correoPersona, p.telefonoPersona,
           r.nombreRol, pf.nombre AS nombrePerfil, de.numeroCuenta,
           ufc.idCampus, c.nombreCampus
    ${USUARIOS_UNIDAD_FROM}
    ${donde}
    ORDER BY p.nombrePersona, p.apellidosPersona
  `, parametros);
}

/**
 * El frontend identifica al estudiante por numeroCuenta; la base, por
 * idUsuarioUnidad con rol Viajero. Devuelve null si no hay ninguno activo.
 */
export async function idViajeroPorCuenta(numeroCuenta: string): Promise<number | null> {
  const fila = await consultarUna<{ idUsuarioUnidad: number }>(`
    SELECT TOP 1 uu.idUsuarioUnidad
    ${USUARIOS_UNIDAD_FROM}
    WHERE de.numeroCuenta = @cuenta AND r.nombreRol = N'Viajero'
      AND uu.estadoUsuarioUnidad = 1 AND ppr.estadoPersonaPerfilRol = 1
  `, { cuenta: [sql.NVarChar(15), numeroCuenta] });
  return fila?.idUsuarioUnidad ?? null;
}

/* -------------------------------- Giras --------------------------------- */

const GIRAS_SELECT = `
  SELECT g.idGira, g.idSolicitud, g.idEstado, e.codigoEstado, e.nombreEstado,
         g.idJefeAprobacion, ${nombreDeUsuario("g.idJefeAprobacion")} AS nombreJefeAprobacion,
         s.idJefeMision, ${nombreDeUsuario("s.idJefeMision")} AS nombreJefeMision,
         s.destinoGira, s.objetivoAcademico, s.alojamientoGira,
         s.idCampus, c.nombreCampus, s.idTipoAlcance, ta.nombre AS nombreAlcance,
         ${fechaIso("g.fechaSalidaConfirmada")} AS fechaSalidaConfirmada,
         ${fechaIso("g.fechaRetornoConfirmada")} AS fechaRetornoConfirmada,
         ${horaCorta("s.horaSalidaPropuesta")} AS horaSalidaPropuesta,
         ${horaCorta("s.horaRetornoPropuesta")} AS horaRetornoPropuesta,
         ${fechaIso("s.fechaInicioInscripcion")} AS fechaInicioInscripcion,
         ${fechaIso("s.fechaFinInscripcion")} AS fechaFinInscripcion,
         s.totalAproximadoEstudiantes, s.totalAproximadoDocentes, s.costos,
         per.idPeriodo, per.anioPeriodo, per.numeroPac,
         g.fechaAprobacion, g.idTipoCancelacion, g.idUsuarioCancela,
         g.fechaCancelacion, g.motivoCancelacion,
         (SELECT COUNT(*) FROM Giras.tblInscripciones i WHERE i.idGira = g.idGira) AS totalInscripciones,
         (SELECT COUNT(*) FROM Giras.tblInscripciones i
           INNER JOIN Catalogo.tblEstados ei ON ei.idEstado = i.idEstado
           WHERE i.idGira = g.idGira AND ei.codigoEstado = N'Inscrito') AS totalInscritos
    FROM Giras.tblGiras g
   INNER JOIN Giras.tblSolicitudes s ON s.idSolicitud = g.idSolicitud
   INNER JOIN Catalogo.tblEstados e ON e.idEstado = g.idEstado
   INNER JOIN Catalogo.tblCampus c ON c.idCampus = s.idCampus
    LEFT JOIN Giras.tblTiposAlcance ta ON ta.idTipoAlcance = s.idTipoAlcance
   ${periodoDe("g.fechaSalidaConfirmada", "per")}`;

/**
 * Giras filtradas. `usuario` es "Mis giras" de quien organiza (jefe de mision
 * o docente acompanante de la solicitud); `numeroCuenta` es "Mis giras" del
 * estudiante: aquellas donde tiene una inscripcion, en cualquier estado.
 */
export function listarGiras(filtros: {
  codigoEstado: string | null;
  idCampus: number | null;
  idUsuario: number | null;
  numeroCuenta: string | null;
}) {
  const parametros: Record<string, Parametro> = {};
  let donde = "WHERE 1 = 1";

  if (filtros.codigoEstado) {
    donde += " AND e.codigoEstado = @estado";
    parametros["estado"] = [sql.NVarChar(40), filtros.codigoEstado];
  }
  if (filtros.idCampus !== null) {
    donde += " AND s.idCampus = @campus";
    parametros["campus"] = [sql.Int, filtros.idCampus];
  }
  if (filtros.idUsuario !== null) {
    donde += ` AND (s.idJefeMision = @usuario OR EXISTS (
      SELECT 1 FROM Giras.tblDocentesAcompanantes da
       WHERE da.idSolicitud = s.idSolicitud AND da.idUsuarioAcompanante = @usuario))`;
    parametros["usuario"] = [sql.Int, filtros.idUsuario];
  }
  if (filtros.numeroCuenta) {
    donde += ` AND EXISTS (
      SELECT 1 FROM Giras.tblInscripciones i
       INNER JOIN Giras.tblUsuarioUnidad uu ON uu.idUsuarioUnidad = i.idViajero
       INNER JOIN Catalogo.tblPersonaPerfilRol ppr ON ppr.idPersonaPerfilRol = uu.idPersonaPerfilRol
       INNER JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = ppr.idPersona
       WHERE i.idGira = g.idGira AND de.numeroCuenta = @cuenta)`;
    parametros["cuenta"] = [sql.NVarChar(15), filtros.numeroCuenta];
  }

  return consultar(`${GIRAS_SELECT} ${donde} ORDER BY g.fechaSalidaConfirmada DESC, g.idGira DESC`, parametros);
}

export const obtenerGira = (idGira: number) =>
  consultarUna(`${GIRAS_SELECT} WHERE g.idGira = @id`, { id: [sql.Int, idGira] });

export const existeGira = async (idGira: number): Promise<boolean> =>
  (await consultarUna(`SELECT 1 AS existe FROM Giras.tblGiras WHERE idGira = @id`, {
    id: [sql.Int, idGira],
  })) !== null;

/* ------------------------------ Diagnostico ----------------------------- */

export async function medirBaseDeDatos() {
  const inicio = Date.now();
  const fila = await consultarUna<{ ahora: Date }>(`SELECT SYSDATETIME() AS ahora`);
  return { ok: fila !== null, msConsulta: Date.now() - inicio, ahoraEnBase: fila?.ahora ?? null };
}
