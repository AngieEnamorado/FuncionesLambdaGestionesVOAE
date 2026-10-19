/**
 * Avisos de Voluntariado en Catalogo.tblNotificaciones.
 *
 * Esa tabla es la cola de correos compartida de los tres sistemas. Nadie envia
 * correos todavia, asi que cada aviso queda PENDIENTE y el portal lo muestra
 * como notificacion; si mas adelante se conecta un envio, saldran solos. La
 * lectura y el "marcar leida" los sirve voae-catalogo (/notificaciones).
 *
 * Cada aviso es un INSERT ... SELECT: destinatario, correo y nombres salen de
 * la base, y si la persona o el grupo no existen no se inserta nada. Las
 * columnas de PROCAD y Giras quedan en NULL.
 */
import { consultar, sql, type Parametro } from "../../compartido/db";
import { CARGO_COORDINADOR } from "./consultas";

const INSERTAR = `
  INSERT INTO Catalogo.tblNotificaciones
      (sistemaOrigen, tipoNotificacion, idPersonaDestino, correoDestino,
       asuntoCorreo, cuerpoCorreo, idSolicitudVoluntariado, usuarioRegistro)`;

/** Los coordinadores activos de un grupo, con su correo. */
const COORDINADORES = `
  FROM Voluntariado.tblMiembrosGrupos m
  INNER JOIN Catalogo.tblPersonas c ON c.idPersona = m.idPersona
 WHERE m.idCargo = ${CARGO_COORDINADOR} AND m.estadoMiembroGrupo = 1`;

/** "IV Trimestre 2026" a partir de una fila t de tblTrimestres. */
const NOMBRE_TRIMESTRE = `CONCAT(CASE t.numeroTrimestre WHEN 1 THEN N'I' WHEN 2 THEN N'II' WHEN 3 THEN N'III' ELSE N'IV' END,
                                 N' Trimestre ', t.anioTrimestre)`;

const texto = (valor: string | null, largo = 4000): Parametro => [sql.NVarChar(largo), valor];

const SOLICITUD_GRUPO: Record<string, { verbo: string; cuerpo: string }> = {
  APROBADA: { verbo: "fue aprobada", cuerpo: "La VOAE aprobó tu grupo: ya aparece en el portal y puedes administrarlo." },
  RECHAZADA: { verbo: "fue rechazada", cuerpo: "La VOAE rechazó la solicitud." },
  DEVUELTA: { verbo: "fue devuelta para corrección", cuerpo: "La VOAE la devolvió para que la corrijas." },
};

export function solicitudGrupoResuelta(idSolicitud: number, estado: string, motivo: string | null, usuario: string) {
  const aviso = SOLICITUD_GRUPO[estado];
  if (!aviso) return Promise.resolve();
  return consultar(`${INSERTAR}
    SELECT N'VOLUNTARIADO', @tipo, p.idPersona, COALESCE(p.correoPersona, N''),
           LEFT(CONCAT(N'Tu solicitud del grupo «', s.nombreGrupo, N'» ', @verbo), 200),
           CONCAT(@cuerpo, CASE WHEN @motivo IS NULL THEN N'' ELSE CONCAT(N' Motivo: ', @motivo) END),
           s.idSolicitudGrupoNuevo, @usuario
      FROM Voluntariado.tblSolicitudesGruposNuevos s
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = s.idPersonaSolicitante
     WHERE s.idSolicitudGrupoNuevo = @id
  `, {
    id: [sql.Int, idSolicitud],
    tipo: texto(`GRUPO_${estado}`, 50),
    verbo: texto(aviso.verbo, 100),
    cuerpo: texto(aviso.cuerpo),
    motivo: texto(motivo),
    usuario: texto(usuario, 90),
  });
}

/** Alguien pidio unirse: se avisa a los coordinadores del grupo. */
export function solicitudUnionCreada(idGrupo: number, idPersona: number, usuario: string) {
  return consultar(`${INSERTAR}
    SELECT N'VOLUNTARIADO', N'UNION_SOLICITADA', c.idPersona, COALESCE(c.correoPersona, N''),
           LEFT(CONCAT(N'Nueva solicitud para unirse a «', g.nombreGrupo, N'»'), 200),
           CONCAT(sol.nombrePersona, N' ', sol.apellidosPersona,
                  N' pidió unirse al grupo. Revísala en el panel de coordinador, en Solicitudes.'),
           NULL, @usuario
      ${COORDINADORES.replace("WHERE", `INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = m.idGrupo
      INNER JOIN Catalogo.tblPersonas sol ON sol.idPersona = @idPersona
     WHERE m.idGrupo = @idGrupo AND`)}
  `, {
    idGrupo: [sql.Int, idGrupo],
    idPersona: [sql.Int, idPersona],
    usuario: texto(usuario, 90),
  });
}

export function solicitudUnionResuelta(idSolicitudUnion: number, estado: string, motivo: string | null, usuario: string) {
  const aprobada = estado === "APROBADA";
  return consultar(`${INSERTAR}
    SELECT N'VOLUNTARIADO', @tipo, p.idPersona, COALESCE(p.correoPersona, N''),
           LEFT(CONCAT(N'Tu solicitud para unirte a «', g.nombreGrupo, N'» ', @verbo), 200),
           CONCAT(@cuerpo, CASE WHEN @motivo IS NULL THEN N'' ELSE CONCAT(N' Motivo: ', @motivo) END),
           NULL, @usuario
      FROM Voluntariado.tblSolicitudesUniones su
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = su.idPersona
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = su.idGrupo
     WHERE su.idSolicitudUnion = @id
  `, {
    id: [sql.Int, idSolicitudUnion],
    tipo: texto(`UNION_${estado}`, 50),
    verbo: texto(aprobada ? "fue aprobada" : "fue rechazada", 100),
    cuerpo: texto(aprobada ? "Ya eres miembro del grupo." : "El coordinador del grupo no la aceptó."),
    motivo: texto(motivo),
    usuario: texto(usuario, 90),
  });
}

/** La VOAE aprobo o rechazo una actividad: se avisa a los coordinadores del grupo organizador. */
export function actividadResuelta(idActividad: number, estado: string, usuario: string) {
  if (estado !== "APROBADA" && estado !== "RECHAZADA") return Promise.resolve();
  const aprobada = estado === "APROBADA";
  return consultar(`${INSERTAR}
    SELECT N'VOLUNTARIADO', @tipo, c.idPersona, COALESCE(c.correoPersona, N''),
           LEFT(CONCAT(N'La actividad «', a.nombreActividad, N'» ', @verbo), 200),
           @cuerpo, NULL, @usuario
      ${COORDINADORES.replace("WHERE", `INNER JOIN Voluntariado.tblActividades a ON a.idGrupoOrganizador = m.idGrupo
     WHERE a.idActividad = @id AND`)}
  `, {
    id: [sql.Int, idActividad],
    tipo: texto(`ACTIVIDAD_${estado}`, 50),
    verbo: texto(aprobada ? "fue aprobada" : "fue rechazada", 100),
    cuerpo: texto(aprobada
      ? "La VOAE la aprobó: ya pueden inscribirse los estudiantes y, cuando ocurra, pasar lista."
      : "La VOAE la rechazó."),
    usuario: texto(usuario, 90),
  });
}

/** La VOAE acepto u observo un informe trimestral: se avisa a los coordinadores del grupo. */
export function informeDictaminado(idInforme: number, estado: string, observaciones: string | null, usuario: string) {
  const aceptado = estado === "ACEPTADO";
  return consultar(`${INSERTAR}
    SELECT N'VOLUNTARIADO', @tipo, c.idPersona, COALESCE(c.correoPersona, N''),
           LEFT(CONCAT(N'Tu informe del ', ${NOMBRE_TRIMESTRE}, N' ', @verbo), 200),
           CONCAT(@cuerpo, CASE WHEN @observaciones IS NULL THEN N'' ELSE CONCAT(N' Observaciones: ', @observaciones) END),
           NULL, @usuario
      ${COORDINADORES.replace("WHERE", `INNER JOIN Voluntariado.tblInformesTrimestrales i ON i.idGrupo = m.idGrupo
      INNER JOIN Voluntariado.tblTrimestres t ON t.idTrimestre = i.idTrimestre
     WHERE i.idInformeTrimestral = @id AND`)}
  `, {
    id: [sql.Int, idInforme],
    tipo: texto(`INFORME_${estado}`, 50),
    verbo: texto(aceptado ? "fue aceptado" : "fue observado", 100),
    cuerpo: texto(aceptado
      ? "La VOAE aceptó el informe."
      : "La VOAE lo observó: corrige las actividades indicadas y reenvíalo desde el panel de coordinador."),
    observaciones: texto(observaciones),
    usuario: texto(usuario, 90),
  });
}

export function diplomaEmitido(idGrupo: number, idPersona: number, usuario: string) {
  return consultar(`${INSERTAR}
    SELECT N'VOLUNTARIADO', N'DIPLOMA_EMITIDO', p.idPersona, COALESCE(p.correoPersona, N''),
           LEFT(CONCAT(N'Recibiste el diploma de «', g.nombreGrupo, N'»'), 200),
           N'La VOAE emitió tu diploma de reconocimiento. Descárgalo en el portal, en Mi historial.',
           NULL, @usuario
      FROM Catalogo.tblPersonas p
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = @idGrupo
     WHERE p.idPersona = @idPersona
  `, {
    idGrupo: [sql.Int, idGrupo],
    idPersona: [sql.Int, idPersona],
    usuario: texto(usuario, 90),
  });
}

/**
 * Corre un aviso sin que su falla tumbe la accion que lo provoco: lo
 * importante (aprobar, dictaminar...) ya quedo guardado. La falla queda en
 * CloudWatch.
 */
export async function avisar(nombre: string, trabajo: () => Promise<unknown>): Promise<void> {
  try {
    await trabajo();
  } catch (error) {
    console.warn(JSON.stringify({ nivel: "aviso", notificacion: nombre, mensaje: (error as Error)?.message ?? String(error) }));
  }
}
