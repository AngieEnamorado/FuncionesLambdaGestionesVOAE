/**
 * Actividades de los grupos: registro, validacion por el administrador, pase
 * de lista, series recurrentes y activacion de periodo.
 *
 * Reglas que pone la base y no se repiten aqui:
 * - tgrActividadesTipoCoherente: el tipo de actividad debe estar habilitado para ESE grupo y activo.
 * - tgrActividadesValidadoraEsAdmin: valida solo un ADMINISTRADOR_PROCAD.
 * - tgrActividadesNoValidarPeriodoCerrado: no se valida en un periodo cerrado.
 * - tgrAsistenciasSoloValidadas, tgrAsistenciasMismoGrupo,
 *   tgrAsistenciasRequiereMatriculaVerificada, tgrAsistenciasExcusaValidada:
 *   lista solo sobre actividades VALIDADA, del mismo grupo y periodo, con
 *   matricula verificada, y excusas con justificacion y validador autorizado.
 * - Procad.spGenerarActividadesSerie: la recurrencia. Se llama, no se reimplementa.
 * - Procad.spActivarNuevoPeriodo: la arrastre de integrantes al periodo nuevo.
 */
import { consultar, consultarUna, ejecutarProcedimiento, enTransaccion, sql, type Parametro } from "../../compartido/db";
import { conflicto, noEncontrado, solicitudInvalida } from "../../compartido/errores";
import { CONTEXTO, Filtros, idEstado, usuarioParam } from "./entrada";

export const ESTADOS_ACTIVIDAD = ["PENDIENTE_VALIDACION", "VALIDADA", "RECHAZADA"] as const;
export const DECISIONES_ACTIVIDAD = ["VALIDADA", "RECHAZADA"] as const;

const COLUMNAS_ACTIVIDAD = `
  a.idActividad, a.idGrupo, g.nombreGrupo, tg.nombreTipoGrupo AS tipoGrupo, g.idCampus, c.nombreCampus,
  a.idPeriodo, e.codigoEstado, e.nombreEstado, a.fechaActividad,
  a.idTipoActividad, ta.nombreTipoActividad, a.idSerie, a.descripcionActividad,
  a.idPersonaValidadora, pv.nombrePersona AS nombreValidadora, pv.apellidosPersona AS apellidosValidadora,
  a.observacionValidacion, a.fechaValidacion, a.usuarioRegistro, a.fechaRegistro,
  (SELECT COUNT(*) FROM Procad.tblAsistencias x WHERE x.idActividad = a.idActividad) AS inscritos,
  (SELECT COUNT(*) FROM Procad.tblAsistencias x WHERE x.idActividad = a.idActividad AND x.asistio = 1) AS presentes`;

const DESDE_ACTIVIDAD = `
  FROM Procad.tblActividades a
 INNER JOIN Procad.tblGrupos g      ON g.idGrupo = a.idGrupo
 INNER JOIN Procad.tblTiposGrupo tg ON tg.idTipoGrupo = g.idTipoGrupo
 INNER JOIN Catalogo.tblCampus c    ON c.idCampus = g.idCampus
 INNER JOIN Catalogo.tblEstados e   ON e.idEstado = a.idEstado
  LEFT JOIN Procad.tblTiposActividades ta ON ta.idTipoActividad = a.idTipoActividad
  LEFT JOIN Catalogo.tblPersonas pv ON pv.idPersona = a.idPersonaValidadora`;

/* ------------------------------- Actividades ------------------------------ */

export interface FiltrosActividades {
  grupo: number | null;
  periodo: number | null;
  campus: number | null;
  estado: string | null;
  serie: number | null;
  desde: string | null;
  hasta: string | null;
}

export function listarActividades(f: FiltrosActividades) {
  const filtros = new Filtros()
    .si(f.grupo, "grupo", sql.Int, "a.idGrupo = @grupo")
    .si(f.periodo, "periodo", sql.Int, "a.idPeriodo = @periodo")
    .si(f.campus, "campus", sql.Int, "g.idCampus = @campus")
    .si(f.estado, "estado", sql.NVarChar(40), "e.codigoEstado = @estado")
    .si(f.serie, "serie", sql.Int, "a.idSerie = @serie")
    .si(f.desde, "desde", sql.Date, "a.fechaActividad >= @desde")
    .si(f.hasta, "hasta", sql.Date, "a.fechaActividad <= @hasta");
  return consultar(`
    SELECT ${COLUMNAS_ACTIVIDAD}
    ${DESDE_ACTIVIDAD}
    ${filtros.where}
     ORDER BY a.fechaActividad DESC, a.idActividad DESC
  `, filtros.parametros);
}

export async function obtenerActividad(idActividad: number) {
  const fila = await consultarUna(`
    SELECT ${COLUMNAS_ACTIVIDAD}
    ${DESDE_ACTIVIDAD}
     WHERE a.idActividad = @id
  `, { id: [sql.Int, idActividad] });
  if (!fila) throw noEncontrado(`No existe la actividad ${idActividad}.`);
  return fila;
}

export interface NuevaActividad {
  idGrupo: number;
  idPeriodo: number;
  fechaActividad: string;
  idTipoActividad: number | null;
  descripcionActividad: string | null;
}

/** Actividad puntual reportada por el encargado (RF-26). Nace PENDIENTE_VALIDACION. */
export async function crearActividad(n: NuevaActividad, usuario: string) {
  const filas = await consultar<{ id: number }>(`
    INSERT INTO Procad.tblActividades
      (idGrupo, idPeriodo, idEstado, fechaActividad, idTipoActividad, descripcionActividad, usuarioRegistro)
    VALUES (@grupo, @periodo, ${idEstado(CONTEXTO.actividad, "pendiente")}, @fecha, @tipo, @descripcion, @usuario);
    SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
  `, {
    grupo: [sql.Int, n.idGrupo],
    periodo: [sql.Int, n.idPeriodo],
    pendiente: [sql.NVarChar(40), "PENDIENTE_VALIDACION"],
    fecha: [sql.Date, n.fechaActividad],
    tipo: [sql.Int, n.idTipoActividad],
    descripcion: [sql.NVarChar(300), n.descripcionActividad],
    usuario: usuarioParam(usuario),
  });
  return obtenerActividad(filas[0]!.id);
}

export interface Validacion {
  decision: (typeof DECISIONES_ACTIVIDAD)[number];
  idPersonaValidadora: number;
  observacion: string | null;
}

/** Validar o rechazar una actividad pendiente (RF-27). */
export async function validarActividad(idActividad: number, v: Validacion) {
  if (v.decision === "RECHAZADA" && v.observacion === null) {
    // RF-27: la observacion es obligatoria al rechazar.
    throw solicitudInvalida("Para rechazar una actividad hay que indicar el motivo en observacion.");
  }

  await enTransaccion(async (ejecutar) => {
    const actual = await ejecutar<{ codigoEstado: string }>(`
      SELECT e.codigoEstado
        FROM Procad.tblActividades a WITH (UPDLOCK)
       INNER JOIN Catalogo.tblEstados e ON e.idEstado = a.idEstado
       WHERE a.idActividad = @id
    `, { id: [sql.Int, idActividad] });
    if (!actual[0]) throw noEncontrado(`No existe la actividad ${idActividad}.`);
    if (actual[0].codigoEstado !== "PENDIENTE_VALIDACION") {
      throw conflicto(
        `La actividad ${idActividad} esta en estado ${actual[0].codigoEstado}: solo se valida una actividad PENDIENTE_VALIDACION.`,
      );
    }

    await ejecutar(`
      UPDATE Procad.tblActividades
         SET idEstado = ${idEstado(CONTEXTO.actividad, "decision")},
             idPersonaValidadora = @validadora,
             observacionValidacion = @observacion,
             fechaValidacion = SYSDATETIME()
       WHERE idActividad = @id
    `, {
      id: [sql.Int, idActividad],
      decision: [sql.NVarChar(40), v.decision],
      validadora: [sql.Int, v.idPersonaValidadora],
      observacion: [sql.NVarChar(300), v.observacion],
    });
  });

  return obtenerActividad(idActividad);
}

/* -------------------------------- Asistencia ------------------------------ */

export async function listarAsistencia(idActividad: number) {
  const actividad = await obtenerActividad(idActividad);
  const asistencias = await consultar(`
    SELECT x.idAsistencia, x.idSolicitud, s.idPersona, p.nombrePersona, p.apellidosPersona, de.numeroCuenta,
           x.asistio, x.esExcusado, x.justificacionExcusa, x.idPersonaValidaExcusa, x.fechaAsistencia,
           CASE WHEN x.asistio IS NULL THEN N'INSCRITO'
                WHEN x.asistio = 1     THEN N'PRESENTE'
                WHEN x.esExcusado = 1  THEN N'EXCUSADO'
                ELSE N'AUSENTE' END AS estadoAsistencia
      FROM Procad.tblAsistencias x
     INNER JOIN Procad.tblSolicitudes s ON s.idSolicitud = x.idSolicitud
     INNER JOIN Catalogo.tblPersonas p  ON p.idPersona = s.idPersona
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = s.idPersona
     WHERE x.idActividad = @id
     ORDER BY p.apellidosPersona, p.nombrePersona
  `, { id: [sql.Int, idActividad] });
  return { actividad, asistencias };
}

export interface MarcaAsistencia {
  idSolicitud: number;
  /** null = inscrito sin pasar lista; true = presente; false = ausente. */
  asistio: boolean | null;
  esExcusado: boolean;
  justificacionExcusa: string | null;
  idPersonaValidaExcusa: number | null;
}

/**
 * Pase de lista: crea o actualiza una fila por estudiante. En las actividades
 * de una serie nadie se inscribe y el director pasa lista directo contra el
 * grupo, asi que la fila puede no existir todavia. Si una sola marca viola un
 * trigger se revierte todo el pase, para no dejar la lista a medias.
 */
export async function registrarAsistencia(idActividad: number, marcas: MarcaAsistencia[], usuario: string) {
  await enTransaccion(async (ejecutar) => {
    const existe = await ejecutar(
      "SELECT idActividad FROM Procad.tblActividades WHERE idActividad = @id",
      { id: [sql.Int, idActividad] },
    );
    if (!existe[0]) throw noEncontrado(`No existe la actividad ${idActividad}.`);

    for (const m of marcas) {
      const parametros: Record<string, Parametro> = {
        actividad: [sql.Int, idActividad],
        solicitud: [sql.Int, m.idSolicitud],
        asistio: [sql.Bit, m.asistio],
        excusado: [sql.Bit, m.esExcusado],
        justificacion: [sql.NVarChar(300), m.justificacionExcusa],
        valida: [sql.Int, m.idPersonaValidaExcusa],
        usuario: usuarioParam(usuario),
      };
      await ejecutar(`
        IF EXISTS (SELECT 1 FROM Procad.tblAsistencias WITH (UPDLOCK, HOLDLOCK)
                    WHERE idActividad = @actividad AND idSolicitud = @solicitud)
          UPDATE Procad.tblAsistencias
             SET asistio = @asistio, esExcusado = @excusado, justificacionExcusa = @justificacion,
                 idPersonaValidaExcusa = @valida,
                 fechaAsistencia = CASE WHEN @asistio IS NULL THEN NULL ELSE SYSDATETIME() END
           WHERE idActividad = @actividad AND idSolicitud = @solicitud;
        ELSE
          INSERT INTO Procad.tblAsistencias
            (idActividad, idSolicitud, asistio, esExcusado, justificacionExcusa, idPersonaValidaExcusa,
             fechaAsistencia, usuarioRegistro)
          VALUES (@actividad, @solicitud, @asistio, @excusado, @justificacion, @valida,
                  CASE WHEN @asistio IS NULL THEN NULL ELSE SYSDATETIME() END, @usuario);
      `, parametros);
    }
  });

  return listarAsistencia(idActividad);
}

/* ---------------------------------- Series -------------------------------- */

export interface NuevaSerie {
  idGrupo: number;
  idPeriodo: number;
  idTipoActividad: number | null;
  fechaInicioSerie: string;
  fechaFinSerie: string;
  horaSerie: string | null;
  descripcionSerie: string | null;
  /** 1 = lunes ... 7 = domingo (ISO 8601), como lo espera tblSeriesActividadesDias. */
  diasSemana: number[];
}

/**
 * Crea la serie con sus dias y la expande en actividades con
 * Procad.spGenerarActividadesSerie, todo en una transaccion: si el SP falla,
 * no queda una serie sin actividades.
 */
export async function crearSerie(n: NuevaSerie, usuario: string) {
  const idSerie = await enTransaccion(async (ejecutar) => {
    const filas = await ejecutar<{ id: number }>(`
      INSERT INTO Procad.tblSeriesActividades
        (idGrupo, idPeriodo, idTipoActividad, fechaInicioSerie, fechaFinSerie, horaSerie,
         descripcionSerie, usuarioRegistro)
      VALUES (@grupo, @periodo, @tipo, @inicio, @fin, @hora, @descripcion, @usuario);
      SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
    `, {
      grupo: [sql.Int, n.idGrupo],
      periodo: [sql.Int, n.idPeriodo],
      tipo: [sql.Int, n.idTipoActividad],
      inicio: [sql.Date, n.fechaInicioSerie],
      fin: [sql.Date, n.fechaFinSerie],
      hora: [sql.VarChar(8), n.horaSerie],
      descripcion: [sql.NVarChar(300), n.descripcionSerie],
      usuario: usuarioParam(usuario),
    });
    const id = filas[0]!.id;

    for (const dia of n.diasSemana) {
      await ejecutar(
        "INSERT INTO Procad.tblSeriesActividadesDias (idSerie, diaSemana) VALUES (@serie, @dia)",
        { serie: [sql.Int, id], dia: [sql.TinyInt, dia] },
      );
    }

    await ejecutar(
      "EXEC Procad.spGenerarActividadesSerie @idSerie = @serie, @usuarioRegistro = @usuario",
      { serie: [sql.Int, id], usuario: usuarioParam(usuario) },
    );
    return id;
  });

  return obtenerSerie(idSerie);
}

export async function obtenerSerie(idSerie: number) {
  const serie = await consultarUna(`
    SELECT sa.idSerie, sa.idGrupo, g.nombreGrupo, sa.idPeriodo, sa.idTipoActividad, ta.nombreTipoActividad,
           sa.fechaInicioSerie, sa.fechaFinSerie, CONVERT(VARCHAR(5), sa.horaSerie, 108) AS horaSerie,
           sa.descripcionSerie, sa.estadoSerie AS activa, sa.fechaRegistro,
           (SELECT d.diaSemana FROM Procad.tblSeriesActividadesDias d
             WHERE d.idSerie = sa.idSerie ORDER BY d.diaSemana FOR JSON PATH) AS dias,
           (SELECT COUNT(*) FROM Procad.tblActividades a WHERE a.idSerie = sa.idSerie) AS actividadesGeneradas
      FROM Procad.tblSeriesActividades sa
     INNER JOIN Procad.tblGrupos g ON g.idGrupo = sa.idGrupo
      LEFT JOIN Procad.tblTiposActividades ta ON ta.idTipoActividad = sa.idTipoActividad
     WHERE sa.idSerie = @id
  `, { id: [sql.Int, idSerie] });
  if (!serie) throw noEncontrado(`No existe la serie ${idSerie}.`);

  const dias = typeof serie["dias"] === "string"
    ? (JSON.parse(serie["dias"]) as { diaSemana: number }[]).map((d) => d.diaSemana)
    : [];
  return { ...serie, dias };
}

/* --------------------------------- Periodos ------------------------------- */

interface ResumenActivacion {
  integrantesCopiados: number;
  condicionadosPorReconfirmar: number;
  rolesIntegranteRetirados: number;
  /** FOR JSON: idSolicitud, idPersona, nombrePersona, apellidosPersona, idGrupo, nombreGrupo, motivo. */
  omitidos: string | null;
}

/**
 * Activa el periodo nuevo con Procad.spActivarNuevoPeriodo. El SP arrastra a
 * los integrantes APROBADO, deja PENDIENTE a los condicionados para que sus
 * firmantes reconfirmen (GET /condicionados?estado=POR_RECONFIRMAR), omite y
 * reporta a quien no puede pasar, y retira el rol INTEGRANTE a quien no
 * califico. No cambia cual es el periodo activo: eso es de Catalogo. Aqui
 * solo se devuelve su resumen.
 *
 * La version anterior del SP (migracion 2026-09-23 sin aplicar) no devuelve
 * resumen; en ese caso se cuenta a mano cuantos integrantes quedaron.
 */
export async function activarPeriodo(idPeriodoAnterior: number, idPeriodoNuevo: number, usuario: string) {
  const [resumen] = await ejecutarProcedimiento<ResumenActivacion>("Procad.spActivarNuevoPeriodo", {
    idPeriodoAnterior: [sql.Int, idPeriodoAnterior],
    idPeriodoNuevo: [sql.Int, idPeriodoNuevo],
    usuarioRegistro: usuarioParam(usuario),
  });

  if (resumen) {
    return {
      idPeriodoAnterior,
      idPeriodoNuevo,
      integrantesCopiados: resumen.integrantesCopiados,
      condicionadosPorReconfirmar: resumen.condicionadosPorReconfirmar,
      rolesIntegranteRetirados: resumen.rolesIntegranteRetirados,
      omitidos: resumen.omitidos ? JSON.parse(resumen.omitidos) : [],
    };
  }

  const conteo = await consultarUna<{ integrantes: number }>(`
    SELECT COUNT(*) AS integrantes
      FROM Procad.tblSolicitudes s
     INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
     WHERE s.idPeriodo = @nuevo
       AND e.contextoEstado = N'PROCAD_SOLICITUD' AND e.codigoEstado = N'APROBADO'
  `, { nuevo: [sql.Int, idPeriodoNuevo] });

  return { idPeriodoAnterior, idPeriodoNuevo, integrantesEnPeriodoNuevo: conteo?.integrantes ?? 0 };
}
