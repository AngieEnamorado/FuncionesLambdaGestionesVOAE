/**
 * El estudiante visto desde su propio panel: sus datos de Registro y sus
 * solicitudes a grupos de PROCAD.
 *
 * La v2 no guarda los datos del estudiante (vienen en vivo de Registro) ni el
 * indice minimo exigido: lo decide la aplicacion. Se decide aqui, una sola
 * vez, para que el panel y la creacion de la solicitud no puedan discrepar.
 */
import { consultar, consultarUna, sql } from "../../compartido/db";
import { noEncontrado } from "../../compartido/errores";
import { estudiantesDeRegistro, type EstudianteRegistro } from "./registro";

/** Indice del periodo que pide PROCAD para entrar sin ser condicionado (decision del 27-10-2026). */
export const INDICE_MINIMO_PERIODO = 70;

/** Sin indice del periodo (primer ingreso, por ejemplo) no se puede decir que lo cumple. */
export const cumpleIndiceMinimo = (r: EstudianteRegistro): boolean =>
  r.indicePeriodo !== null && Number(r.indicePeriodo) >= INDICE_MINIMO_PERIODO;

/** El estudiante en Registro, o 404 si la cuenta no existe alli. */
export async function registroDe(numeroCuenta: string): Promise<EstudianteRegistro> {
  const registro = (await estudiantesDeRegistro([numeroCuenta])).get(numeroCuenta);
  if (!registro) throw noEncontrado(`El numero de cuenta ${numeroCuenta} no existe en Registro.`);
  return registro;
}

const unir = (...partes: (string | null)[]) => partes.filter((p) => p && p.trim() !== "").join(" ") || null;

/**
 * Datos de Registro, si cumple el indice, y todas sus solicitudes (de todos
 * los periodos), con la ultima observacion de cada una: es lo que el
 * estudiante tiene que leer cuando se la devuelven para corregir.
 */
export async function obtenerEstudiante(numeroCuenta: string) {
  const r = await registroDe(numeroCuenta);

  const local = await consultarUna<{ idPersona: number }>(
    "SELECT idPersona FROM Catalogo.tblDetallesEstudiantes WHERE numeroCuenta = @cuenta",
    { cuenta: [sql.NVarChar(15), numeroCuenta] },
  );

  const solicitudes = local
    ? await consultar(`
        SELECT s.idSolicitud, s.idGrupo, g.nombreGrupo, tg.nombreTipoGrupo AS tipoGrupo, c.nombreCampus,
               s.idPeriodo, pe.anioPeriodo, pe.numeroPac,
               e.codigoEstado, e.nombreEstado,
               s.cumpleIndiceMinimo, s.esEquipo, s.esCondicionado,
               CAST(CASE WHEN s.idPersonaProponeCondicionado IS NULL THEN 0 ELSE 1 END AS BIT) AS condicionadoPropuesto,
               s.fechaInscripcion, s.fechaActualizacion,
               d.contactoEmergenciaNombre, d.contactoEmergenciaTelefono, d.idPosicion, d.idInstrumento,
               d.nivelExperiencia, d.alergia,
               (SELECT TOP 1 a.contenidoTexto FROM Procad.tblAdjuntosSolicitudes a
                 WHERE a.idSolicitud = s.idSolicitud AND a.tipoAdjunto = N'texto'
                 ORDER BY a.idAdjunto DESC) AS experiencia,
               (SELECT TOP 1 l.observacionCambio FROM Procad.tblLogsEstadosSolicitudes l
                 WHERE l.idSolicitud = s.idSolicitud
                 ORDER BY l.fechaCambio DESC, l.idLogEstadoSolicitud DESC) AS ultimaObservacion
          FROM Procad.tblSolicitudes s
         INNER JOIN Procad.tblGrupos g      ON g.idGrupo = s.idGrupo
         INNER JOIN Procad.tblTiposGrupo tg ON tg.idTipoGrupo = g.idTipoGrupo
         INNER JOIN Catalogo.tblCampus c    ON c.idCampus = g.idCampus
         INNER JOIN Catalogo.tblPeriodos pe ON pe.idPeriodo = s.idPeriodo
         INNER JOIN Catalogo.tblEstados e   ON e.idEstado = s.idEstado
          LEFT JOIN Procad.tblDetallesSolicitudes d ON d.idSolicitud = s.idSolicitud
         WHERE s.idPersona = @persona
         ORDER BY s.fechaRegistro DESC
      `, { persona: [sql.Int, local.idPersona] })
    : [];

  return {
    numeroCuenta,
    idPersona: local?.idPersona ?? null,
    nombrePersona: unir(r.primerNombre, r.segundoNombre),
    apellidosPersona: unir(r.primerApellido, r.segundoApellido),
    correoInstitucional: r.correoInstitucional,
    telefono: r.telefonoMovil ?? r.telefonoFijo,
    genero: r.genero,
    idCampus: r.idCampus,
    nombreCampus: r.centro,
    carrera: r.carrera,
    indicePeriodo: r.indicePeriodo,
    indiceGlobal: r.indiceGlobal,
    matriculado: r.matriculado,
    indiceMinimo: INDICE_MINIMO_PERIODO,
    cumpleIndiceMinimo: cumpleIndiceMinimo(r),
    solicitudes,
  };
}
