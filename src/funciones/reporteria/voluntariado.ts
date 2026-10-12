/**
 * Reporteria de Voluntariado: tablero nacional y estadisticas.
 *
 * Solo lectura. Se movio tal cual desde voae-voluntariado, que lo servia de
 * forma provisional; las rutas viejas de alla importan de aqui hasta que el
 * frontend deje de usarlas, asi que no hay dos copias del SQL.
 */
import { consultar, consultarUna } from "../../compartido/db";

/* Horas y asistencias se cuentan solo sobre participaciones ASISTIO. */
const ID_ESTADO_ASISTIO = `(SELECT idEstado FROM Catalogo.tblEstados
                             WHERE contextoEstado = N'VOL_PARTICIPACION' AND codigoEstado = N'ASISTIO')`;

/** Trimestre vigente: el que contiene la fecha de hoy, o el ultimo que ya empezo. */
const TRIMESTRE_VIGENTE = `
    SELECT TOP 1 idTrimestre, anioTrimestre, numeroTrimestre, fechaLimiteInforme
      FROM Voluntariado.tblTrimestres
     WHERE estadoTrimestre = 1
       AND (fechaInicioTrimestre IS NULL OR fechaInicioTrimestre <= CAST(SYSDATETIME() AS DATE))
     ORDER BY anioTrimestre DESC, numeroTrimestre DESC`;

export async function obtenerTablero() {
  const [totales, porCampus, porRed, trimestre] = await Promise.all([
    consultarUna(`
      SELECT (SELECT COUNT(*) FROM Voluntariado.tblGrupos WHERE estadoGrupo = 1) AS grupos,
             (SELECT COUNT(*) FROM Voluntariado.tblActividades) AS actividades,
             (SELECT COUNT(DISTINCT idPersona) FROM Voluntariado.tblParticipaciones
               WHERE idEstado = ${ID_ESTADO_ASISTIO}) AS participantes,
             (SELECT COALESCE(SUM(horasParticipacion), 0) FROM Voluntariado.tblParticipaciones
               WHERE idEstado = ${ID_ESTADO_ASISTIO}) AS horas
    `),
    // El semaforo se evalua sobre el trimestre vigente: entregado si todos
    // los grupos del campus enviaron, atrasado si ya paso la fecha limite.
    consultar(`
      WITH vigente AS (${TRIMESTRE_VIGENTE}),
      porCampus AS (
          SELECT c.idCampus, c.nombreCampus,
                 COUNT(DISTINCT gc.idGrupo) AS grupos,
                 (SELECT COUNT(DISTINCT pa.idPersona) FROM Voluntariado.tblParticipaciones pa
                   WHERE pa.idEstado = ${ID_ESTADO_ASISTIO}
                     AND pa.idGrupo IN (SELECT idGrupo FROM Voluntariado.tblGruposCampus
                                         WHERE idCampus = c.idCampus)) AS participantes,
                 (SELECT COALESCE(SUM(pa.horasParticipacion), 0) FROM Voluntariado.tblParticipaciones pa
                   WHERE pa.idEstado = ${ID_ESTADO_ASISTIO}
                     AND pa.idGrupo IN (SELECT idGrupo FROM Voluntariado.tblGruposCampus
                                         WHERE idCampus = c.idCampus)) AS horas,
                 (SELECT COUNT(*) FROM Voluntariado.tblInformesTrimestrales i
                   INNER JOIN Catalogo.tblEstados e ON e.idEstado = i.idEstado
                   WHERE i.idTrimestre = (SELECT idTrimestre FROM vigente)
                     AND e.codigoEstado IN (N'ENVIADO', N'ACEPTADO')
                     AND i.idGrupo IN (SELECT idGrupo FROM Voluntariado.tblGruposCampus
                                        WHERE idCampus = c.idCampus)) AS informesEntregados
            FROM Catalogo.tblCampus c
            INNER JOIN Voluntariado.tblGruposCampus gc ON gc.idCampus = c.idCampus
            INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = gc.idGrupo AND g.estadoGrupo = 1
           GROUP BY c.idCampus, c.nombreCampus
      )
      SELECT porCampus.*,
             CASE WHEN informesEntregados >= grupos THEN N'Entregado'
                  WHEN (SELECT fechaLimiteInforme FROM vigente) < CAST(SYSDATETIME() AS DATE) THEN N'Atrasado'
                  ELSE N'Por vencer' END AS semaforo
        FROM porCampus
       ORDER BY nombreCampus
    `),
    consultar(`
      SELECT r.idRedTematica, r.nombreRedTematica,
             (SELECT COUNT(*) FROM Voluntariado.tblGruposRedesTematicas gr
               WHERE gr.idRedTematica = r.idRedTematica) AS grupos,
             (SELECT COALESCE(SUM(pa.horasParticipacion), 0) FROM Voluntariado.tblParticipaciones pa
               WHERE pa.idEstado = ${ID_ESTADO_ASISTIO}
                 AND pa.idGrupo IN (SELECT idGrupo FROM Voluntariado.tblGruposRedesTematicas
                                     WHERE idRedTematica = r.idRedTematica)) AS horas
        FROM Voluntariado.tblRedesTematicas r
       WHERE r.estadoRedTematica = 1
       ORDER BY r.nombreRedTematica
    `),
    consultarUna(TRIMESTRE_VIGENTE),
  ]);

  return { totales, trimestreVigente: trimestre, porCampus, porRed };
}

/**
 * Una fila por actividad, sin agregar: el panel filtra y suma en el cliente.
 * Devolver la unidad y no totales precocinados evita que dos graficos del
 * mismo panel cuenten distinto. Campus y red son los primeros del grupo
 * organizador, en orden alfabetico.
 */
export const listarEstadisticas = () =>
  consultar(`
    SELECT a.idActividad, a.fechaActividad AS fecha, per.anioPeriodo, per.numeroPac,
           (SELECT TOP 1 c.nombreCampus FROM Voluntariado.tblGruposCampus gc
              INNER JOIN Catalogo.tblCampus c ON c.idCampus = gc.idCampus
             WHERE gc.idGrupo = a.idGrupoOrganizador ORDER BY c.nombreCampus) AS campus,
           (SELECT TOP 1 r.idRedTematica FROM Voluntariado.tblGruposRedesTematicas gr
              INNER JOIN Voluntariado.tblRedesTematicas r ON r.idRedTematica = gr.idRedTematica
             WHERE gr.idGrupo = a.idGrupoOrganizador ORDER BY r.nombreRedTematica) AS idRedTematica,
           g.nombreGrupo AS grupo, e.codigoEstado AS estado, e.nombreEstado,
           (SELECT COUNT(*) FROM Voluntariado.tblParticipaciones pa
             WHERE pa.idActividad = a.idActividad AND pa.idEstado = ${ID_ESTADO_ASISTIO}) AS participantes,
           (SELECT COALESCE(SUM(pa.horasParticipacion), 0) FROM Voluntariado.tblParticipaciones pa
             WHERE pa.idActividad = a.idActividad AND pa.idEstado = ${ID_ESTADO_ASISTIO}) AS horas
      FROM Voluntariado.tblActividades a
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = a.idGrupoOrganizador
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = a.idEstado
      INNER JOIN Catalogo.tblPeriodos per ON per.idPeriodo = a.idPeriodo
     WHERE a.fechaActividad IS NOT NULL
     ORDER BY a.fechaActividad
  `);
