/**
 * Consultas de la funcion voae-catalogo.
 *
 * Todo el SQL de la funcion vive aqui, separado de las rutas, para que se
 * pueda leer contra bd_voae_script/DbVoae_final.sql sin ruido de HTTP en
 * medio. Los nombres de columna se devuelven tal como estan en la base
 * (camelCase) en vez de renombrarse: el frontend tambien es camelCase y una
 * traduccion de nombres es una capa mas donde desincronizarse.
 */
import { consultar, consultarUna, sql, type Parametro } from "../../compartido/db";
import { enCache } from "../../compartido/catalogos";

/* --------------------------- Tablas de referencia -------------------------
   Diminutas, casi estaticas y las pide casi toda pantalla, asi que van todas
   por cache con TTL.                                                      */

export const listarCampus = (incluirInactivos: boolean) =>
  enCache(`campus:${incluirInactivos}`, () =>
    consultar(`
      SELECT idCampus, nombreCampus, codigoCortoCampus, tipoCampus,
             regionCampus, estadoCampus
        FROM Catalogo.tblCampus
       WHERE (@todos = 1 OR estadoCampus = 1)
       ORDER BY nombreCampus
    `, { todos: [sql.Bit, incluirInactivos] }),
  );

export const listarEstados = (contexto: string | null) =>
  enCache(`estados:${contexto ?? "todos"}`, () =>
    consultar(`
      SELECT idEstado, contextoEstado, codigoEstado, nombreEstado
        FROM Catalogo.tblEstados
       WHERE (@contexto IS NULL OR contextoEstado = @contexto)
       ORDER BY contextoEstado, idEstado
    `, { contexto: [sql.NVarChar(40), contexto] }),
  );

/** Los contextos existentes (GIRA_SOLICITUD, PROCAD_ACTIVIDAD, VOL_ACTIVIDAD...). */
export const listarContextosDeEstado = () =>
  enCache("estados:contextos", () =>
    consultar(`
      SELECT contextoEstado, COUNT(*) AS cantidadEstados
        FROM Catalogo.tblEstados
       GROUP BY contextoEstado
       ORDER BY contextoEstado
    `),
  );

export const listarPeriodos = () =>
  enCache("periodos", () =>
    consultar(`
      SELECT idPeriodo, anioPeriodo, numeroPac, fechaInicioPeriodo,
             fechaFinPeriodo, estadoPeriodo
        FROM Catalogo.tblPeriodos
       ORDER BY anioPeriodo DESC, numeroPac DESC
    `),
  );

/**
 * El periodo vigente.
 *
 * No hay columna "es el activo" ni trigger que garantice uno solo: se elige
 * el periodo activo cuyo rango de fechas contiene hoy y, si ninguno lo hace
 * (o las fechas estan en NULL), el activo mas reciente por anio y PAC. El
 * TTL es corto porque el resultado cambia solo al cruzar una fecha, pero
 * cuando cambia conviene que se note el mismo dia.
 */
export const obtenerPeriodoActivo = () =>
  enCache(
    "periodos:activo",
    () =>
      consultarUna(`
        SELECT TOP 1 idPeriodo, anioPeriodo, numeroPac, fechaInicioPeriodo,
                     fechaFinPeriodo, estadoPeriodo
          FROM Catalogo.tblPeriodos
         WHERE estadoPeriodo = 1
         ORDER BY
           CASE WHEN CAST(SYSDATETIME() AS DATE)
                     BETWEEN fechaInicioPeriodo AND fechaFinPeriodo
                THEN 0 ELSE 1 END,
           anioPeriodo DESC, numeroPac DESC
      `),
    60 * 1000,
  );

export const listarRoles = (sistema: string | null) =>
  enCache(`roles:${sistema ?? "todos"}`, () =>
    consultar(`
      SELECT idRol, nombreRol, descripcionRol, sistemaRol, estadoRol
        FROM Catalogo.tblRoles
       WHERE estadoRol = 1
         AND (@sistema IS NULL OR sistemaRol = @sistema)
       ORDER BY sistemaRol, nombreRol
    `, { sistema: [sql.NVarChar(15), sistema] }),
  );

export const listarPerfiles = () =>
  enCache("perfiles", () =>
    consultar(`
      SELECT idPerfil, nombre, descripcion, estadoPerfil
        FROM Catalogo.tblPerfiles
       WHERE estadoPerfil = 1
       ORDER BY idPerfil
    `),
  );

export const listarProgramas = () =>
  enCache("programas", () =>
    consultar(`
      SELECT idPrograma, nombrePrograma, siglasPrograma, descripcionPrograma,
             estadoPrograma
        FROM Catalogo.tblProgramasVoae
       WHERE estadoPrograma = 1
       ORDER BY idPrograma
    `),
  );

/* ------------------------------- Identidad -------------------------------
   No hay tablas "Empleado" ni "Estudiante": hay una sola tblPersonas, y ser
   empleado o estudiante es un rol que la persona tiene (tblPersonaPerfilRol),
   con sus atributos en tablas de detalle 1:1. Los endpoints respetan eso: se
   pide la persona, y aparte su detalle.                                    */

export const obtenerPersona = (idPersona: number) =>
  consultarUna(`
    SELECT p.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona,
           p.sexoPersona, p.telefonoPersona, p.idCampus, c.nombreCampus,
           p.estadoPersona, p.fechaRegistro
      FROM Catalogo.tblPersonas p
      LEFT JOIN Catalogo.tblCampus c ON c.idCampus = p.idCampus
     WHERE p.idPersona = @idPersona
  `, { idPersona: [sql.Int, idPersona] });

/**
 * Que es esa persona y en que programa. Es el endpoint que reemplazara al
 * mock de sesion del frontend (`currentUser.ts`) cuando exista auth.
 */
export const listarPerfilesDePersona = (idPersona: number) =>
  consultar(`
    SELECT ppr.idPersonaPerfilRol, ppr.idPersona,
           ppr.idPerfil, pf.nombre AS nombrePerfil,
           ppr.idRol, r.nombreRol, r.sistemaRol,
           ppr.fechaAsignacion, ppr.estadoPersonaPerfilRol
      FROM Catalogo.tblPersonaPerfilRol ppr
      INNER JOIN Catalogo.tblPerfiles pf ON pf.idPerfil = ppr.idPerfil
      INNER JOIN Catalogo.tblRoles r ON r.idRol = ppr.idRol
     WHERE ppr.idPersona = @idPersona
       AND ppr.estadoPersonaPerfilRol = 1
     ORDER BY r.sistemaRol, r.nombreRol
  `, { idPersona: [sql.Int, idPersona] });

export const obtenerEstudiante = (numeroCuenta: string) =>
  consultarUna(`
    SELECT de.idPersona, de.numeroCuenta, de.carreraEstudiante,
           de.indicePeriodo, de.indiceGlobal, de.forma003Url, de.fotoUrl,
           de.carnetDigitalUrl, de.matriculaVerificada,
           de.fechaMatriculaVerificada,
           p.nombrePersona, p.apellidosPersona, p.correoPersona,
           p.telefonoPersona, p.sexoPersona, p.idCampus, c.nombreCampus
      FROM Catalogo.tblDetallesEstudiantes de
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = de.idPersona
      LEFT JOIN Catalogo.tblCampus c ON c.idCampus = p.idCampus
     WHERE de.numeroCuenta = @numeroCuenta
  `, { numeroCuenta: [sql.NVarChar(15), numeroCuenta] });

export const obtenerEmpleado = (numeroEmpleado: string) =>
  consultarUna(`
    SELECT dm.idPersona, dm.numeroEmpleado, dm.contratadoVoae,
           p.nombrePersona, p.apellidosPersona, p.correoPersona,
           p.telefonoPersona, p.sexoPersona, p.idCampus, c.nombreCampus
      FROM Catalogo.tblDetallesEmpleados dm
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = dm.idPersona
      LEFT JOIN Catalogo.tblCampus c ON c.idCampus = p.idCampus
     WHERE dm.numeroEmpleado = @numeroEmpleado
  `, { numeroEmpleado: [sql.NVarChar(20), numeroEmpleado] });

/* ----------------------------- Notificaciones ---------------------------- */

export function listarNotificaciones(
  idPersona: number,
  soloNoLeidas: boolean,
  limite: number,
) {
  const parametros: Record<string, Parametro> = {
    idPersona: [sql.Int, idPersona],
    soloNoLeidas: [sql.Bit, soloNoLeidas],
    limite: [sql.Int, limite],
  };

  return consultar(`
    SELECT TOP (@limite)
           idNotificacion, sistemaOrigen, tipoNotificacion, idPersonaDestino,
           asuntoCorreo, cuerpoCorreo, estadoEnvio, fechaEnvio,
           leidaNotificacion, fechaRegistro,
           idSolicitudVoluntariado, idSolicitudProcad, idSolicitudGira,
           idInscripcionGira, idGira
      FROM Catalogo.tblNotificaciones
     WHERE idPersonaDestino = @idPersona
       AND (@soloNoLeidas = 0 OR leidaNotificacion = 0)
     ORDER BY fechaRegistro DESC
  `, parametros);
}

/** Devuelve la fila actualizada, o null si esa notificacion no existe. */
export const marcarNotificacionLeida = (idNotificacion: number) =>
  consultarUna(`
    UPDATE Catalogo.tblNotificaciones
       SET leidaNotificacion = 1
     OUTPUT INSERTED.idNotificacion, INSERTED.leidaNotificacion,
            INSERTED.idPersonaDestino, INSERTED.asuntoCorreo
     WHERE idNotificacion = @idNotificacion
  `, { idNotificacion: [sql.Int, idNotificacion] });

/* -------------------------------- Diagnostico ---------------------------- */

/**
 * Ping a la base. No es un endpoint del dominio: sirve para medir la latencia
 * real contra Azure desde us-east-1 y para ver si la base serverless estaba
 * pausada, cosas que no se pueden medir desde fuera de la Lambda.
 */
export async function medirBaseDeDatos() {
  const inicio = Date.now();
  const fila = await consultarUna<{ ahora: Date; version: string }>(`
    SELECT SYSDATETIME() AS ahora, @@VERSION AS version
  `);
  return {
    ok: fila !== null,
    msConsulta: Date.now() - inicio,
    ahoraEnBase: fila?.ahora ?? null,
  };
}
