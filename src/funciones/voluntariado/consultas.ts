/**
 * Consultas de voae-voluntariado.
 *
 * Todo el SQL vive aqui, separado de las rutas, para poder leerlo contra
 * bd_voae_script/DbVoae_final.sql sin ruido de HTTP en medio. Los nombres de
 * columna salen tal como estan en la base.
 */
import {
  consultar,
  consultarUna,
  enTransaccion,
  sql,
  type Parametro,
} from "../../compartido/db";
import { enCache } from "../../compartido/catalogos";
import { conflicto, noEncontrado } from "../../compartido/errores";

/** Cargo 2 = Coordinador. Un indice unico filtrado permite uno solo activo por grupo. */
export const CARGO_COORDINADOR = 2;

/* ------------------------------- Estados --------------------------------
   Los estados de los tres sistemas viven en Catalogo.tblEstados, separados
   por contextoEstado. Los handlers hablan por codigo (APROBADA, ASISTIO) y
   aqui se traduce a idEstado, cacheado porque no cambia nunca.            */

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

/* ------------------------------ Catalogos ------------------------------- */

export const listarCatalogos = () =>
  enCache("catalogos", async () => {
    const [redes, trimestres, cargos, requisitos] = await Promise.all([
      consultar(`SELECT idRedTematica, nombreRedTematica FROM Voluntariado.tblRedesTematicas
                  WHERE estadoRedTematica = 1 ORDER BY nombreRedTematica`),
      consultar(`SELECT idTrimestre, anioTrimestre, numeroTrimestre, fechaInicioTrimestre,
                        fechaFinTrimestre, fechaLimiteInforme
                   FROM Voluntariado.tblTrimestres WHERE estadoTrimestre = 1
                  ORDER BY anioTrimestre DESC, numeroTrimestre DESC`),
      consultar(`SELECT idCargo, nombreCargo, descripcionCargo FROM Voluntariado.tblCargos
                  WHERE estadoCargo = 1 ORDER BY idCargo`),
      consultar(`SELECT idRequisitoAdjunto, procesoRequisito, tipoRequisito,
                        obligatorioRequisito, minimoRequisito, maximoRequisito
                   FROM Voluntariado.tblRequisitosAdjuntos WHERE estadoRequisitoAdjunto = 1
                  ORDER BY procesoRequisito, tipoRequisito`),
    ]);
    return { redes, trimestres, cargos, requisitos };
  });

/* -------------------------------- Grupos -------------------------------- */

export function listarGrupos(idCampus: number | null, idRedTematica: number | null) {
  return consultar(`
    SELECT g.idGrupo, g.nombreGrupo, g.descripcionGrupo, g.fechaCreacionGrupo,
           g.logoUrl, g.redesSociales, g.estadoGrupo,
           (SELECT COUNT(*) FROM Voluntariado.tblMiembrosGrupos m
             WHERE m.idGrupo = g.idGrupo AND m.estadoMiembroGrupo = 1) AS totalMiembros,
           (SELECT STRING_AGG(c.nombreCampus, N', ')
              FROM Voluntariado.tblGruposCampus gc
              INNER JOIN Catalogo.tblCampus c ON c.idCampus = gc.idCampus
             WHERE gc.idGrupo = g.idGrupo) AS campus,
           (SELECT STRING_AGG(r.nombreRedTematica, N', ')
              FROM Voluntariado.tblGruposRedesTematicas gr
              INNER JOIN Voluntariado.tblRedesTematicas r ON r.idRedTematica = gr.idRedTematica
             WHERE gr.idGrupo = g.idGrupo) AS redesTematicas
      FROM Voluntariado.tblGrupos g
     WHERE g.estadoGrupo = 1
       AND (@idCampus IS NULL OR EXISTS (
             SELECT 1 FROM Voluntariado.tblGruposCampus gc
              WHERE gc.idGrupo = g.idGrupo AND gc.idCampus = @idCampus))
       AND (@idRed IS NULL OR EXISTS (
             SELECT 1 FROM Voluntariado.tblGruposRedesTematicas gr
              WHERE gr.idGrupo = g.idGrupo AND gr.idRedTematica = @idRed))
     ORDER BY g.nombreGrupo
  `, {
    idCampus: [sql.Int, idCampus],
    idRed: [sql.Int, idRedTematica],
  });
}

export async function obtenerGrupo(idGrupo: number) {
  const grupo = await consultarUna(`
    SELECT idGrupo, nombreGrupo, descripcionGrupo, fechaCreacionGrupo, logoUrl,
           redesSociales, estadoGrupo, fechaRegistro
      FROM Voluntariado.tblGrupos WHERE idGrupo = @idGrupo
  `, { idGrupo: [sql.Int, idGrupo] });
  if (!grupo) return null;

  const [campus, redes, junta] = await Promise.all([
    listarCampusDeGrupo(idGrupo),
    consultar(`SELECT r.idRedTematica, r.nombreRedTematica
                 FROM Voluntariado.tblGruposRedesTematicas gr
                 INNER JOIN Voluntariado.tblRedesTematicas r ON r.idRedTematica = gr.idRedTematica
                WHERE gr.idGrupo = @idGrupo ORDER BY r.nombreRedTematica`,
      { idGrupo: [sql.Int, idGrupo] }),
    // Junta directiva: todo miembro con cargo distinto de Miembro.
    consultar(`SELECT m.idMiembroGrupo, m.idPersona, m.idCargo, c.nombreCargo,
                      m.anioVigencia, p.nombrePersona, p.apellidosPersona, p.correoPersona
                 FROM Voluntariado.tblMiembrosGrupos m
                 INNER JOIN Voluntariado.tblCargos c ON c.idCargo = m.idCargo
                 INNER JOIN Catalogo.tblPersonas p ON p.idPersona = m.idPersona
                WHERE m.idGrupo = @idGrupo AND m.estadoMiembroGrupo = 1 AND m.idCargo <> 1
                ORDER BY m.idCargo`,
      { idGrupo: [sql.Int, idGrupo] }),
  ]);

  return { ...grupo, campus, redesTematicas: redes, juntaDirectiva: junta };
}

export const listarCampusDeGrupo = (idGrupo: number) =>
  consultar(`
    SELECT gc.idGrupoCampus, gc.idCampus, c.nombreCampus, c.codigoCortoCampus
      FROM Voluntariado.tblGruposCampus gc
      INNER JOIN Catalogo.tblCampus c ON c.idCampus = gc.idCampus
     WHERE gc.idGrupo = @idGrupo
     ORDER BY c.nombreCampus
  `, { idGrupo: [sql.Int, idGrupo] });

export const listarMiembros = (idGrupo: number, soloActivos: boolean) =>
  consultar(`
    SELECT m.idMiembroGrupo, m.idPersona, m.idCargo, c.nombreCargo, m.anioVigencia,
           m.esFundador, m.fechaIngreso, m.fechaBaja, m.estadoMiembroGrupo,
           p.nombrePersona, p.apellidosPersona, p.correoPersona, p.idCampus,
           de.numeroCuenta, de.carreraEstudiante
      FROM Voluntariado.tblMiembrosGrupos m
      INNER JOIN Voluntariado.tblCargos c ON c.idCargo = m.idCargo
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = m.idPersona
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = m.idPersona
     WHERE m.idGrupo = @idGrupo
       AND (@soloActivos = 0 OR m.estadoMiembroGrupo = 1)
     ORDER BY m.idCargo, p.apellidosPersona
  `, {
    idGrupo: [sql.Int, idGrupo],
    soloActivos: [sql.Bit, soloActivos],
  });

export const existeGrupo = async (idGrupo: number): Promise<boolean> =>
  (await consultarUna(`SELECT 1 AS hay FROM Voluntariado.tblGrupos WHERE idGrupo = @idGrupo`,
    { idGrupo: [sql.Int, idGrupo] })) !== null;

/* ------------------- Solicitudes de grupos nuevos ----------------------- */

export function listarSolicitudesGrupos(idEstadoFiltro: number | null, idCampus: number | null) {
  return consultar(`
    SELECT s.idSolicitudGrupoNuevo, s.nombreGrupo, s.idPersonaSolicitante,
           p.nombrePersona, p.apellidosPersona, s.idCampus, c.nombreCampus,
           s.idEstado, e.codigoEstado, e.nombreEstado,
           s.fechaSolicitud, s.fechaResolucion, s.idGrupoCreado,
           (SELECT COUNT(*) FROM Voluntariado.tblSolicitudesMiembrosFundadores f
             WHERE f.idSolicitudGrupoNuevo = s.idSolicitudGrupoNuevo) AS totalFundadores
      FROM Voluntariado.tblSolicitudesGruposNuevos s
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = s.idPersonaSolicitante
      INNER JOIN Catalogo.tblCampus c ON c.idCampus = s.idCampus
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
     WHERE (@idEstado IS NULL OR s.idEstado = @idEstado)
       AND (@idCampus IS NULL OR s.idCampus = @idCampus)
     ORDER BY s.fechaSolicitud DESC
  `, {
    idEstado: [sql.Int, idEstadoFiltro],
    idCampus: [sql.Int, idCampus],
  });
}

export async function obtenerSolicitudGrupo(id: number) {
  const solicitud = await consultarUna(`
    SELECT s.*, e.codigoEstado, e.nombreEstado, c.nombreCampus,
           p.nombrePersona, p.apellidosPersona, p.correoPersona
      FROM Voluntariado.tblSolicitudesGruposNuevos s
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
      INNER JOIN Catalogo.tblCampus c ON c.idCampus = s.idCampus
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = s.idPersonaSolicitante
     WHERE s.idSolicitudGrupoNuevo = @id
  `, { id: [sql.Int, id] });
  if (!solicitud) return null;

  const parametro: Record<string, Parametro> = { id: [sql.Int, id] };
  const [fundadores, junta, actividades, adjuntos] = await Promise.all([
    consultar(`SELECT idSolicitudMiembroFundador, numeroCuenta, matriculaValida
                 FROM Voluntariado.tblSolicitudesMiembrosFundadores
                WHERE idSolicitudGrupoNuevo = @id ORDER BY idSolicitudMiembroFundador`, parametro),
    consultar(`SELECT j.idSolicitudJuntaDirectiva, j.numeroCuenta, j.idCargo, c.nombreCargo
                 FROM Voluntariado.tblSolicitudesJuntasDirectivas j
                 INNER JOIN Voluntariado.tblCargos c ON c.idCargo = j.idCargo
                WHERE j.idSolicitudGrupoNuevo = @id ORDER BY j.idCargo`, parametro),
    consultar(`SELECT idSolicitudActividadProyectada, nombreActividad, objetivoActividad,
                      fechaTentativa
                 FROM Voluntariado.tblSolicitudesActividadesProyectadas
                WHERE idSolicitudGrupoNuevo = @id ORDER BY fechaTentativa`, parametro),
    consultar(`SELECT a.idAdjuntoSolicitud, a.idRequisitoAdjunto, r.tipoRequisito, a.archivoUrl,
                      a.fechaRegistro
                 FROM Voluntariado.tblAdjuntosSolicitudes a
                 INNER JOIN Voluntariado.tblRequisitosAdjuntos r
                    ON r.idRequisitoAdjunto = a.idRequisitoAdjunto
                WHERE a.idSolicitudGrupoNuevo = @id ORDER BY a.idAdjuntoSolicitud`, parametro),
  ]);

  return { ...solicitud, fundadores, juntaDirectiva: junta, actividadesProyectadas: actividades, adjuntos };
}

export interface NuevaSolicitudGrupo {
  idPersonaSolicitante: number;
  idCampus: number;
  nombreGrupo: string;
  fechaCreacionGrupo: string | null;
  colaboraOtrasUnidades: boolean;
  detalleColaboracion: string | null;
  resenaHistorica: string | null;
  propositoGrupo: string | null;
  misionGrupo: string | null;
  visionGrupo: string | null;
  edadSolicitante: number | null;
  dniSolicitante: string | null;
  celularSolicitante: string | null;
  direccionSolicitante: string | null;
  fundadores: string[];
  juntaDirectiva: { numeroCuenta: string; idCargo: number }[];
  actividadesProyectadas: { nombreActividad: string; objetivoActividad: string | null; fechaTentativa: string | null }[];
}

/**
 * La cabecera y sus tres listas se escriben juntas o no se escriben. Una
 * solicitud a medio insertar dejaria una junta directiva sin grupo.
 */
export async function crearSolicitudGrupo(datos: NuevaSolicitudGrupo, usuario: string) {
  const estadoPendiente = await idEstado("VOL_SOLICITUD_GRUPO", "PENDIENTE");

  return enTransaccion(async (ejecutar) => {
    const cabecera = await ejecutar<{ idSolicitudGrupoNuevo: number }>(`
      INSERT INTO Voluntariado.tblSolicitudesGruposNuevos
          (idPersonaSolicitante, idCampus, idEstado, nombreGrupo, fechaCreacionGrupo,
           colaboraOtrasUnidades, detalleColaboracion, resenaHistorica, propositoGrupo,
           misionGrupo, visionGrupo, edadSolicitante, dniSolicitante, celularSolicitante,
           direccionSolicitante, usuarioRegistro)
      OUTPUT INSERTED.idSolicitudGrupoNuevo
      VALUES (@idPersona, @idCampus, @idEstado, @nombreGrupo, @fechaCreacion,
              @colabora, @detalleColaboracion, @resena, @proposito,
              @mision, @vision, @edad, @dni, @celular, @direccion, @usuario)
    `, {
      idPersona: [sql.Int, datos.idPersonaSolicitante],
      idCampus: [sql.Int, datos.idCampus],
      idEstado: [sql.Int, estadoPendiente],
      nombreGrupo: [sql.NVarChar(150), datos.nombreGrupo],
      fechaCreacion: [sql.Date, datos.fechaCreacionGrupo],
      colabora: [sql.Bit, datos.colaboraOtrasUnidades],
      detalleColaboracion: [sql.NVarChar(sql.MAX), datos.detalleColaboracion],
      resena: [sql.NVarChar(sql.MAX), datos.resenaHistorica],
      proposito: [sql.NVarChar(sql.MAX), datos.propositoGrupo],
      mision: [sql.NVarChar(sql.MAX), datos.misionGrupo],
      vision: [sql.NVarChar(sql.MAX), datos.visionGrupo],
      edad: [sql.TinyInt, datos.edadSolicitante],
      dni: [sql.NVarChar(20), datos.dniSolicitante],
      celular: [sql.NVarChar(30), datos.celularSolicitante],
      direccion: [sql.NVarChar(300), datos.direccionSolicitante],
      usuario: [sql.NVarChar(90), usuario],
    });

    const idSolicitud = cabecera[0]!.idSolicitudGrupoNuevo;

    for (const numeroCuenta of datos.fundadores) {
      await ejecutar(`
        INSERT INTO Voluntariado.tblSolicitudesMiembrosFundadores
            (idSolicitudGrupoNuevo, numeroCuenta, usuarioRegistro)
        VALUES (@idSolicitud, @numeroCuenta, @usuario)
      `, {
        idSolicitud: [sql.Int, idSolicitud],
        numeroCuenta: [sql.NVarChar(15), numeroCuenta],
        usuario: [sql.NVarChar(90), usuario],
      });
    }

    for (const cargo of datos.juntaDirectiva) {
      await ejecutar(`
        INSERT INTO Voluntariado.tblSolicitudesJuntasDirectivas
            (idSolicitudGrupoNuevo, numeroCuenta, idCargo, usuarioRegistro)
        VALUES (@idSolicitud, @numeroCuenta, @idCargo, @usuario)
      `, {
        idSolicitud: [sql.Int, idSolicitud],
        numeroCuenta: [sql.NVarChar(15), cargo.numeroCuenta],
        idCargo: [sql.TinyInt, cargo.idCargo],
        usuario: [sql.NVarChar(90), usuario],
      });
    }

    for (const actividad of datos.actividadesProyectadas) {
      await ejecutar(`
        INSERT INTO Voluntariado.tblSolicitudesActividadesProyectadas
            (idSolicitudGrupoNuevo, nombreActividad, objetivoActividad, fechaTentativa, usuarioRegistro)
        VALUES (@idSolicitud, @nombre, @objetivo, @fecha, @usuario)
      `, {
        idSolicitud: [sql.Int, idSolicitud],
        nombre: [sql.NVarChar(200), actividad.nombreActividad],
        objetivo: [sql.NVarChar(sql.MAX), actividad.objetivoActividad],
        fecha: [sql.Date, actividad.fechaTentativa],
        usuario: [sql.NVarChar(90), usuario],
      });
    }

    return idSolicitud;
  });
}

export const agregarAdjuntoSolicitud = (
  idSolicitud: number,
  idRequisitoAdjunto: number,
  archivoUrl: string,
  usuario: string,
) =>
  consultarUna(`
    INSERT INTO Voluntariado.tblAdjuntosSolicitudes
        (idSolicitudGrupoNuevo, idRequisitoAdjunto, archivoUrl, usuarioRegistro)
    OUTPUT INSERTED.idAdjuntoSolicitud, INSERTED.archivoUrl
    VALUES (@idSolicitud, @idRequisito, @url, @usuario)
  `, {
    idSolicitud: [sql.Int, idSolicitud],
    idRequisito: [sql.Int, idRequisitoAdjunto],
    url: [sql.NVarChar(300), archivoUrl],
    usuario: [sql.NVarChar(90), usuario],
  });

/**
 * Resuelve una solicitud de grupo. Si se aprueba, crea el grupo en la misma
 * transaccion y lo enlaza en idGrupoCreado.
 *
 * Ojo: no hay trigger ni procedimiento que haga esta creacion, asi que esta
 * es la unica regla de negocio del dominio que vive en el handler. Es
 * candidata a bajar a la base; mientras tanto, el enlace solicitud - grupo se
 * escribe aqui o no se escribe en ningun lado.
 */
export async function resolverSolicitudGrupo(
  idSolicitud: number,
  codigoEstado: string,
  motivo: string | null,
  usuario: string,
) {
  const nuevoEstado = await idEstado("VOL_SOLICITUD_GRUPO", codigoEstado);

  return enTransaccion(async (ejecutar) => {
    const actuales = await ejecutar<{
      idSolicitudGrupoNuevo: number; nombreGrupo: string; idCampus: number;
      idGrupoCreado: number | null; resenaHistorica: string | null;
      propositoGrupo: string | null; fechaCreacionGrupo: Date | null;
      codigoEstado: string;
    }>(`
      SELECT s.idSolicitudGrupoNuevo, s.nombreGrupo, s.idCampus, s.idGrupoCreado,
             s.resenaHistorica, s.propositoGrupo, s.fechaCreacionGrupo, e.codigoEstado
        FROM Voluntariado.tblSolicitudesGruposNuevos s
        INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
       WHERE s.idSolicitudGrupoNuevo = @id
    `, { id: [sql.Int, idSolicitud] });

    const solicitud = actuales[0];
    if (!solicitud) throw noEncontrado(`No existe la solicitud ${idSolicitud}.`);
    if (solicitud.idGrupoCreado !== null) {
      throw conflicto("Esa solicitud ya tiene un grupo creado, no se puede volver a resolver.");
    }

    let idGrupoCreado: number | null = null;
    const cuentasSinPersona: string[] = [];

    if (codigoEstado === "APROBADA") {
      const grupo = await ejecutar<{ idGrupo: number }>(`
        INSERT INTO Voluntariado.tblGrupos
            (nombreGrupo, descripcionGrupo, fechaCreacionGrupo, usuarioRegistro)
        OUTPUT INSERTED.idGrupo
        VALUES (@nombre, @descripcion, @fechaCreacion, @usuario)
      `, {
        nombre: [sql.NVarChar(150), solicitud.nombreGrupo],
        descripcion: [sql.NVarChar(sql.MAX), solicitud.propositoGrupo ?? solicitud.resenaHistorica],
        fechaCreacion: [sql.Date, solicitud.fechaCreacionGrupo],
        usuario: [sql.NVarChar(90), usuario],
      });
      idGrupoCreado = grupo[0]!.idGrupo;

      await ejecutar(`
        INSERT INTO Voluntariado.tblGruposCampus (idGrupo, idCampus, usuarioRegistro)
        VALUES (@idGrupo, @idCampus, @usuario)
      `, {
        idGrupo: [sql.Int, idGrupoCreado],
        idCampus: [sql.Int, solicitud.idCampus],
        usuario: [sql.NVarChar(90), usuario],
      });

      // La junta directiva pedida se vuelve membresia real. Una cuenta que
      // todavia no existe como persona no se inventa: se reporta y queda para
      // que la agreguen a mano cuando la persona exista.
      const junta = await ejecutar<{ numeroCuenta: string; idCargo: number; idPersona: number | null }>(`
        SELECT j.numeroCuenta, j.idCargo, de.idPersona
          FROM Voluntariado.tblSolicitudesJuntasDirectivas j
          LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.numeroCuenta = j.numeroCuenta
         WHERE j.idSolicitudGrupoNuevo = @id
      `, { id: [sql.Int, idSolicitud] });

      for (const fila of junta) {
        if (fila.idPersona === null) {
          cuentasSinPersona.push(fila.numeroCuenta);
          continue;
        }
        await ejecutar(`
          INSERT INTO Voluntariado.tblMiembrosGrupos
              (idGrupo, idPersona, idCargo, esFundador, fechaIngreso, usuarioRegistro)
          VALUES (@idGrupo, @idPersona, @idCargo, 1, CAST(SYSDATETIME() AS DATE), @usuario)
        `, {
          idGrupo: [sql.Int, idGrupoCreado],
          idPersona: [sql.Int, fila.idPersona],
          idCargo: [sql.TinyInt, fila.idCargo],
          usuario: [sql.NVarChar(90), usuario],
        });
      }
    }

    await ejecutar(`
      UPDATE Voluntariado.tblSolicitudesGruposNuevos
         SET idEstado = @idEstado,
             motivoResolucion = @motivo,
             fechaResolucion = SYSDATETIME(),
             idGrupoCreado = @idGrupoCreado
       WHERE idSolicitudGrupoNuevo = @id
    `, {
      idEstado: [sql.Int, nuevoEstado],
      motivo: [sql.NVarChar(sql.MAX), motivo],
      idGrupoCreado: [sql.Int, idGrupoCreado],
      id: [sql.Int, idSolicitud],
    });

    return { idSolicitudGrupoNuevo: idSolicitud, estado: codigoEstado, idGrupoCreado, cuentasSinPersona };
  });
}

/* ------------------------- Solicitudes de union ------------------------- */

export const listarSolicitudesUnion = (idGrupo: number, idEstadoFiltro: number | null) =>
  consultar(`
    SELECT su.idSolicitudUnion, su.idGrupo, su.idPersona, su.mensajeSolicitud,
           su.idEstado, e.codigoEstado, e.nombreEstado, su.fechaSolicitud,
           su.fechaResolucion, su.motivoResolucion,
           p.nombrePersona, p.apellidosPersona, p.correoPersona,
           de.numeroCuenta, de.carreraEstudiante
      FROM Voluntariado.tblSolicitudesUniones su
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = su.idEstado
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = su.idPersona
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = su.idPersona
     WHERE su.idGrupo = @idGrupo
       AND (@idEstado IS NULL OR su.idEstado = @idEstado)
     ORDER BY su.fechaSolicitud DESC
  `, {
    idGrupo: [sql.Int, idGrupo],
    idEstado: [sql.Int, idEstadoFiltro],
  });

export async function crearSolicitudUnion(
  idGrupo: number,
  idPersona: number,
  mensaje: string | null,
  usuario: string,
) {
  const estadoPendiente = await idEstado("VOL_SOLICITUD_UNION", "PENDIENTE");
  return consultarUna(`
    INSERT INTO Voluntariado.tblSolicitudesUniones
        (idGrupo, idPersona, idEstado, mensajeSolicitud, usuarioRegistro)
    OUTPUT INSERTED.idSolicitudUnion, INSERTED.idGrupo, INSERTED.idPersona
    VALUES (@idGrupo, @idPersona, @idEstado, @mensaje, @usuario)
  `, {
    idGrupo: [sql.Int, idGrupo],
    idPersona: [sql.Int, idPersona],
    idEstado: [sql.Int, estadoPendiente],
    mensaje: [sql.NVarChar(500), mensaje],
    usuario: [sql.NVarChar(90), usuario],
  });
}

/** Aprobar une a la persona al grupo como Miembro; rechazar solo cierra la solicitud. */
export async function resolverSolicitudUnion(
  idSolicitudUnion: number,
  codigoEstado: string,
  idPersonaResuelve: number | null,
  motivo: string | null,
  usuario: string,
) {
  const nuevoEstado = await idEstado("VOL_SOLICITUD_UNION", codigoEstado);

  return enTransaccion(async (ejecutar) => {
    const filas = await ejecutar<{ idGrupo: number; idPersona: number; codigoEstado: string }>(`
      SELECT su.idGrupo, su.idPersona, e.codigoEstado
        FROM Voluntariado.tblSolicitudesUniones su
        INNER JOIN Catalogo.tblEstados e ON e.idEstado = su.idEstado
       WHERE su.idSolicitudUnion = @id
    `, { id: [sql.Int, idSolicitudUnion] });

    const solicitud = filas[0];
    if (!solicitud) throw noEncontrado(`No existe la solicitud de union ${idSolicitudUnion}.`);
    if (solicitud.codigoEstado !== "PENDIENTE") {
      throw conflicto(`La solicitud ya esta ${solicitud.codigoEstado}, no se puede resolver de nuevo.`);
    }

    if (codigoEstado === "APROBADA") {
      await ejecutar(`
        INSERT INTO Voluntariado.tblMiembrosGrupos
            (idGrupo, idPersona, idCargo, fechaIngreso, usuarioRegistro)
        VALUES (@idGrupo, @idPersona, 1, CAST(SYSDATETIME() AS DATE), @usuario)
      `, {
        idGrupo: [sql.Int, solicitud.idGrupo],
        idPersona: [sql.Int, solicitud.idPersona],
        usuario: [sql.NVarChar(90), usuario],
      });
    }

    await ejecutar(`
      UPDATE Voluntariado.tblSolicitudesUniones
         SET idEstado = @idEstado, idPersonaResuelve = @idPersonaResuelve,
             motivoResolucion = @motivo, fechaResolucion = SYSDATETIME()
       WHERE idSolicitudUnion = @id
    `, {
      idEstado: [sql.Int, nuevoEstado],
      idPersonaResuelve: [sql.Int, idPersonaResuelve],
      motivo: [sql.NVarChar(sql.MAX), motivo],
      id: [sql.Int, idSolicitudUnion],
    });

    return { idSolicitudUnion, estado: codigoEstado, idGrupo: solicitud.idGrupo };
  });
}

/* ------------------------------ Actividades ----------------------------- */

export function listarActividades(filtros: {
  idGrupo: number | null;
  idTrimestre: number | null;
  idPeriodo: number | null;
  idEstado: number | null;
}) {
  return consultar(`
    SELECT a.idActividad, a.idGrupoOrganizador, g.nombreGrupo, a.idPeriodo,
           a.idTrimestre, t.anioTrimestre, t.numeroTrimestre,
           a.idEstado, e.codigoEstado, e.nombreEstado,
           a.nombreActividad, a.objetivoActividad, a.fechaActividad, a.lugarActividad,
           a.esConjunta, a.aprobadaPorAdmin, a.fechaSolicitud, a.fechaResolucion,
           (SELECT COUNT(*) FROM Voluntariado.tblParticipaciones pa
             WHERE pa.idActividad = a.idActividad) AS totalParticipaciones
      FROM Voluntariado.tblActividades a
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = a.idGrupoOrganizador
      INNER JOIN Voluntariado.tblTrimestres t ON t.idTrimestre = a.idTrimestre
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = a.idEstado
     WHERE (@idGrupo IS NULL OR a.idGrupoOrganizador = @idGrupo
            OR EXISTS (SELECT 1 FROM Voluntariado.tblActividadesGrupos ag
                        WHERE ag.idActividad = a.idActividad AND ag.idGrupo = @idGrupo))
       AND (@idTrimestre IS NULL OR a.idTrimestre = @idTrimestre)
       AND (@idPeriodo IS NULL OR a.idPeriodo = @idPeriodo)
       AND (@idEstado IS NULL OR a.idEstado = @idEstado)
     ORDER BY a.fechaActividad DESC, a.idActividad DESC
  `, {
    idGrupo: [sql.Int, filtros.idGrupo],
    idTrimestre: [sql.Int, filtros.idTrimestre],
    idPeriodo: [sql.Int, filtros.idPeriodo],
    idEstado: [sql.Int, filtros.idEstado],
  });
}

/** Campos de la actividad que los handlers usan por nombre. */
export interface FilaActividad {
  idActividad: number;
  idGrupoOrganizador: number;
  idPeriodo: number;
  idTrimestre: number;
  [columna: string]: unknown;
}

export async function obtenerActividad(idActividad: number) {
  const actividad = await consultarUna<FilaActividad>(`
    SELECT a.*, e.codigoEstado, e.nombreEstado, g.nombreGrupo
      FROM Voluntariado.tblActividades a
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = a.idEstado
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = a.idGrupoOrganizador
     WHERE a.idActividad = @id
  `, { id: [sql.Int, idActividad] });
  if (!actividad) return null;

  const parametro: Record<string, Parametro> = { id: [sql.Int, idActividad] };
  const [coorganizadores, fotos] = await Promise.all([
    consultar(`SELECT ag.idActividadGrupo, ag.idGrupo, g.nombreGrupo
                 FROM Voluntariado.tblActividadesGrupos ag
                 INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = ag.idGrupo
                WHERE ag.idActividad = @id`, parametro),
    consultar(`SELECT idFotoActividad, archivoUrl, descripcionFoto, fechaRegistro
                 FROM Voluntariado.tblFotosActividades
                WHERE idActividad = @id ORDER BY idFotoActividad`, parametro),
  ]);

  return { ...actividad, coorganizadores, fotos };
}

export interface NuevaActividad {
  idGrupoOrganizador: number;
  idPeriodo: number;
  idTrimestre: number;
  nombreActividad: string;
  objetivoActividad: string;
  fechaActividad: string | null;
  lugarActividad: string | null;
  coorganizadores: number[];
}

export async function crearActividad(datos: NuevaActividad, usuario: string) {
  const estadoSolicitada = await idEstado("VOL_ACTIVIDAD", "SOLICITADA");
  const esConjunta = datos.coorganizadores.length > 0;

  return enTransaccion(async (ejecutar) => {
    const filas = await ejecutar<{ idActividad: number }>(`
      INSERT INTO Voluntariado.tblActividades
          (idGrupoOrganizador, idPeriodo, idTrimestre, idEstado, nombreActividad,
           objetivoActividad, fechaActividad, lugarActividad, esConjunta, usuarioRegistro)
      OUTPUT INSERTED.idActividad
      VALUES (@idGrupo, @idPeriodo, @idTrimestre, @idEstado, @nombre,
              @objetivo, @fecha, @lugar, @esConjunta, @usuario)
    `, {
      idGrupo: [sql.Int, datos.idGrupoOrganizador],
      idPeriodo: [sql.Int, datos.idPeriodo],
      idTrimestre: [sql.Int, datos.idTrimestre],
      idEstado: [sql.Int, estadoSolicitada],
      nombre: [sql.NVarChar(200), datos.nombreActividad],
      objetivo: [sql.NVarChar(sql.MAX), datos.objetivoActividad],
      fecha: [sql.Date, datos.fechaActividad],
      lugar: [sql.NVarChar(200), datos.lugarActividad],
      esConjunta: [sql.Bit, esConjunta],
      usuario: [sql.NVarChar(90), usuario],
    });

    const idActividad = filas[0]!.idActividad;

    for (const idGrupo of datos.coorganizadores) {
      await ejecutar(`
        INSERT INTO Voluntariado.tblActividadesGrupos (idActividad, idGrupo, usuarioRegistro)
        VALUES (@idActividad, @idGrupo, @usuario)
      `, {
        idActividad: [sql.Int, idActividad],
        idGrupo: [sql.Int, idGrupo],
        usuario: [sql.NVarChar(90), usuario],
      });
    }

    return idActividad;
  });
}

/**
 * usuarioRegistro no se toca: es quien creo la fila, no quien la resuelve.
 * Quien aprueba no queda registrado en ningun lado porque tblActividades no
 * tiene columna para eso, a diferencia de tblSolicitudesUniones, que si lleva
 * idPersonaResuelve. Es un hueco del esquema, no un olvido de aqui.
 */
export async function resolverActividad(idActividad: number, codigoEstado: string) {
  const nuevoEstado = await idEstado("VOL_ACTIVIDAD", codigoEstado);
  return consultarUna(`
    UPDATE Voluntariado.tblActividades
       SET idEstado = @idEstado,
           aprobadaPorAdmin = @aprobada,
           fechaResolucion = SYSDATETIME()
     OUTPUT INSERTED.idActividad, INSERTED.idEstado, INSERTED.aprobadaPorAdmin
     WHERE idActividad = @id
  `, {
    idEstado: [sql.Int, nuevoEstado],
    aprobada: [sql.Bit, codigoEstado === "APROBADA"],
    id: [sql.Int, idActividad],
  });
}

export const guardarResultados = (idActividad: number, resultados: string) =>
  consultarUna(`
    UPDATE Voluntariado.tblActividades
       SET resultadosActividad = @resultados
     OUTPUT INSERTED.idActividad, INSERTED.resultadosActividad
     WHERE idActividad = @id
  `, {
    resultados: [sql.NVarChar(sql.MAX), resultados],
    id: [sql.Int, idActividad],
  });

export const agregarFoto = (
  idActividad: number,
  archivoUrl: string,
  descripcion: string | null,
  idRequisitoAdjunto: number | null,
  usuario: string,
) =>
  consultarUna(`
    INSERT INTO Voluntariado.tblFotosActividades
        (idActividad, idRequisitoAdjunto, archivoUrl, descripcionFoto, usuarioRegistro)
    OUTPUT INSERTED.idFotoActividad, INSERTED.archivoUrl
    VALUES (@idActividad, @idRequisito, @url, @descripcion, @usuario)
  `, {
    idActividad: [sql.Int, idActividad],
    idRequisito: [sql.Int, idRequisitoAdjunto],
    url: [sql.NVarChar(300), archivoUrl],
    descripcion: [sql.NVarChar(200), descripcion],
    usuario: [sql.NVarChar(90), usuario],
  });

/* ----------------------------- Participaciones --------------------------
   De aqui salen las horas confirmadas y el porcentaje que decide la
   elegibilidad a diploma. Un trigger exige que toda participacion marcada
   ASISTIO traiga horas; esa regla no se repite aqui, se deja fallar y su
   mensaje sale como 409.                                                  */

export const listarParticipaciones = (idActividad: number) =>
  consultar(`
    SELECT pa.idParticipacion, pa.idPersona, pa.idGrupo, pa.tipoParticipante,
           pa.idEstado, e.codigoEstado, e.nombreEstado, pa.horasParticipacion,
           pa.fechaInscripcion, pa.fechaConfirmacion, pa.idPersonaConfirma,
           pa.validadoComoMiembro, pa.validadoMismoCampus,
           COALESCE(pa.nombreSnapshot, CONCAT(p.nombrePersona, N' ', p.apellidosPersona)) AS nombre,
           de.numeroCuenta
      FROM Voluntariado.tblParticipaciones pa
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = pa.idEstado
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = pa.idPersona
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = pa.idPersona
     WHERE pa.idActividad = @idActividad
     ORDER BY nombre
  `, { idActividad: [sql.Int, idActividad] });

export interface LineaAsistencia {
  idPersona: number;
  idGrupo: number;
  codigoEstado: string;
  tipoParticipante: string;
  horasParticipacion: number | null;
}

/**
 * Pasar lista. Cada linea se inserta o se actualiza segun exista ya la
 * participacion, y todas van en una transaccion: media lista pasada es peor
 * que ninguna.
 */
export async function registrarAsistencia(
  idActividad: number,
  idPeriodo: number,
  lineas: LineaAsistencia[],
  idPersonaConfirma: number | null,
  usuario: string,
) {
  const estados = new Map<string, number>();
  for (const codigo of new Set(lineas.map((l) => l.codigoEstado))) {
    estados.set(codigo, await idEstado("VOL_PARTICIPACION", codigo));
  }

  return enTransaccion(async (ejecutar) => {
    let insertadas = 0;
    let actualizadas = 0;

    for (const linea of lineas) {
      const parametros: Record<string, Parametro> = {
        idActividad: [sql.Int, idActividad],
        idGrupo: [sql.Int, linea.idGrupo],
        idPersona: [sql.Int, linea.idPersona],
        idPeriodo: [sql.Int, idPeriodo],
        idEstado: [sql.Int, estados.get(linea.codigoEstado)!],
        tipo: [sql.NVarChar(25), linea.tipoParticipante],
        horas: [sql.Decimal(5, 2), linea.horasParticipacion],
        idPersonaConfirma: [sql.Int, idPersonaConfirma],
        usuario: [sql.NVarChar(90), usuario],
      };

      const existentes = await ejecutar<{ idParticipacion: number }>(`
        SELECT idParticipacion FROM Voluntariado.tblParticipaciones
         WHERE idActividad = @idActividad AND idGrupo = @idGrupo AND idPersona = @idPersona
      `, parametros);

      if (existentes.length > 0) {
        await ejecutar(`
          UPDATE Voluntariado.tblParticipaciones
             SET idEstado = @idEstado, horasParticipacion = @horas,
                 tipoParticipante = @tipo, idPersonaConfirma = @idPersonaConfirma,
                 fechaConfirmacion = SYSDATETIME()
           WHERE idActividad = @idActividad AND idGrupo = @idGrupo AND idPersona = @idPersona
        `, parametros);
        actualizadas++;
      } else {
        // El snapshot del nombre se guarda al inscribir para que el historico
        // no cambie si la persona despues se renombra o se da de baja.
        await ejecutar(`
          INSERT INTO Voluntariado.tblParticipaciones
              (idActividad, idGrupo, idPersona, idPeriodo, idEstado, tipoParticipante,
               horasParticipacion, idPersonaConfirma, fechaConfirmacion,
               nombreSnapshot, sexoSnapshot, usuarioRegistro)
          SELECT @idActividad, @idGrupo, @idPersona, @idPeriodo, @idEstado, @tipo,
                 @horas, @idPersonaConfirma, SYSDATETIME(),
                 CONCAT(p.nombrePersona, N' ', p.apellidosPersona), p.sexoPersona, @usuario
            FROM Catalogo.tblPersonas p
           WHERE p.idPersona = @idPersona
        `, parametros);
        insertadas++;
      }
    }

    return { idActividad, insertadas, actualizadas };
  });
}

/* --------------------------- Informes trimestrales ---------------------- */

export const listarInformes = (
  idGrupo: number | null,
  idTrimestre: number | null,
  idEstadoFiltro: number | null,
) =>
  consultar(`
    SELECT i.idInformeTrimestral, i.idGrupo, g.nombreGrupo, i.idTrimestre,
           t.anioTrimestre, t.numeroTrimestre, t.fechaLimiteInforme,
           i.idEstado, e.codigoEstado, e.nombreEstado, i.fechaEnvio,
           i.observacionesAdmin, i.fechaRegistro,
           (SELECT COUNT(*) FROM Voluntariado.tblInformesTrimestralesActividades ia
             WHERE ia.idInformeTrimestral = i.idInformeTrimestral) AS totalActividades
      FROM Voluntariado.tblInformesTrimestrales i
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = i.idGrupo
      INNER JOIN Voluntariado.tblTrimestres t ON t.idTrimestre = i.idTrimestre
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = i.idEstado
     WHERE (@idGrupo IS NULL OR i.idGrupo = @idGrupo)
       AND (@idTrimestre IS NULL OR i.idTrimestre = @idTrimestre)
       AND (@idEstado IS NULL OR i.idEstado = @idEstado)
     ORDER BY t.anioTrimestre DESC, t.numeroTrimestre DESC, g.nombreGrupo
  `, {
    idGrupo: [sql.Int, idGrupo],
    idTrimestre: [sql.Int, idTrimestre],
    idEstado: [sql.Int, idEstadoFiltro],
  });

export async function obtenerInforme(idInforme: number) {
  const informe = await consultarUna(`
    SELECT i.*, e.codigoEstado, e.nombreEstado, g.nombreGrupo,
           t.anioTrimestre, t.numeroTrimestre, t.fechaLimiteInforme
      FROM Voluntariado.tblInformesTrimestrales i
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = i.idEstado
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = i.idGrupo
      INNER JOIN Voluntariado.tblTrimestres t ON t.idTrimestre = i.idTrimestre
     WHERE i.idInformeTrimestral = @id
  `, { id: [sql.Int, idInforme] });
  if (!informe) return null;

  const actividades = await consultar(`
    SELECT ia.idInformeTrimestralActividad, a.idActividad, a.nombreActividad,
           a.fechaActividad, a.lugarActividad, e.codigoEstado,
           (SELECT COUNT(*) FROM Voluntariado.tblParticipaciones pa
             WHERE pa.idActividad = a.idActividad
               AND pa.idEstado = (SELECT idEstado FROM Catalogo.tblEstados
                                   WHERE contextoEstado = N'VOL_PARTICIPACION'
                                     AND codigoEstado = N'ASISTIO')) AS asistentes
      FROM Voluntariado.tblInformesTrimestralesActividades ia
      INNER JOIN Voluntariado.tblActividades a ON a.idActividad = ia.idActividad
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = a.idEstado
     WHERE ia.idInformeTrimestral = @id
     ORDER BY a.fechaActividad
  `, { id: [sql.Int, idInforme] });

  return { ...informe, actividades };
}

export async function crearInforme(idGrupo: number, idTrimestre: number, usuario: string) {
  const estadoCaptura = await idEstado("VOL_INFORME", "EN_CAPTURA");
  return consultarUna(`
    INSERT INTO Voluntariado.tblInformesTrimestrales
        (idGrupo, idTrimestre, idEstado, usuarioRegistro)
    OUTPUT INSERTED.idInformeTrimestral, INSERTED.idGrupo, INSERTED.idTrimestre
    VALUES (@idGrupo, @idTrimestre, @idEstado, @usuario)
  `, {
    idGrupo: [sql.Int, idGrupo],
    idTrimestre: [sql.Int, idTrimestre],
    idEstado: [sql.Int, estadoCaptura],
    usuario: [sql.NVarChar(90), usuario],
  });
}

/** Reemplaza la lista de actividades incluidas en el informe. */
export function fijarActividadesDeInforme(
  idInforme: number,
  idsActividades: number[],
  usuario: string,
) {
  return enTransaccion(async (ejecutar) => {
    await ejecutar(`
      DELETE FROM Voluntariado.tblInformesTrimestralesActividades
       WHERE idInformeTrimestral = @id
    `, { id: [sql.Int, idInforme] });

    for (const idActividad of idsActividades) {
      await ejecutar(`
        INSERT INTO Voluntariado.tblInformesTrimestralesActividades
            (idInformeTrimestral, idActividad, usuarioRegistro)
        VALUES (@idInforme, @idActividad, @usuario)
      `, {
        idInforme: [sql.Int, idInforme],
        idActividad: [sql.Int, idActividad],
        usuario: [sql.NVarChar(90), usuario],
      });
    }

    return { idInformeTrimestral: idInforme, actividades: idsActividades.length };
  });
}

/**
 * Cambia el estado del informe validando la transicion. El esquema no tiene
 * trigger para esto, asi que la secuencia se comprueba aqui: EN_CAPTURA va a
 * ENVIADO, y ENVIADO va a OBSERVADO o ACEPTADO.
 */
export async function cambiarEstadoInforme(
  idInforme: number,
  codigoDestino: string,
  desdePermitidos: string[],
  observaciones: string | null,
  marcarEnvio: boolean,
) {
  const nuevoEstado = await idEstado("VOL_INFORME", codigoDestino);

  return enTransaccion(async (ejecutar) => {
    const filas = await ejecutar<{ codigoEstado: string }>(`
      SELECT e.codigoEstado
        FROM Voluntariado.tblInformesTrimestrales i
        INNER JOIN Catalogo.tblEstados e ON e.idEstado = i.idEstado
       WHERE i.idInformeTrimestral = @id
    `, { id: [sql.Int, idInforme] });

    const actual = filas[0];
    if (!actual) throw noEncontrado(`No existe el informe ${idInforme}.`);
    if (!desdePermitidos.includes(actual.codigoEstado)) {
      throw conflicto(
        `Un informe en ${actual.codigoEstado} no puede pasar a ${codigoDestino}.`,
      );
    }

    await ejecutar(`
      UPDATE Voluntariado.tblInformesTrimestrales
         SET idEstado = @idEstado,
             observacionesAdmin = COALESCE(@observaciones, observacionesAdmin),
             fechaEnvio = CASE WHEN @marcarEnvio = 1 THEN SYSDATETIME() ELSE fechaEnvio END
       WHERE idInformeTrimestral = @id
    `, {
      idEstado: [sql.Int, nuevoEstado],
      observaciones: [sql.NVarChar(sql.MAX), observaciones],
      marcarEnvio: [sql.Bit, marcarEnvio],
      id: [sql.Int, idInforme],
    });

    return { idInformeTrimestral: idInforme, estadoAnterior: actual.codigoEstado, estado: codigoDestino };
  });
}

/* ---------------------------- Informe economico -------------------------
   El informe economico cuelga de la actividad, no del informe trimestral:
   tblInformesEconomicos.idActividad es UNIQUE. Sus movimientos se agrupan
   por grupo participante, que es lo que permite que una actividad conjunta
   lleve las cuentas de cada grupo por separado.                           */

export async function obtenerInformeEconomico(idActividad: number) {
  const informe = await consultarUna<{ idInformeEconomico: number }>(`
    SELECT idInformeEconomico, idActividad, observacionesInformeEconomico, fechaRegistro
      FROM Voluntariado.tblInformesEconomicos WHERE idActividad = @idActividad
  `, { idActividad: [sql.Int, idActividad] });
  if (!informe) return null;

  const grupos = await consultar(`
    SELECT ieg.idInformeEconomicoGrupo, ieg.idGrupo, g.nombreGrupo, ieg.saldoAnterior,
           (SELECT COALESCE(SUM(CASE WHEN m.tipoMovimiento = N'INGRESO'
                                     THEN m.montoMovimiento ELSE 0 END), 0)
              FROM Voluntariado.tblMovimientosEconomicos m
             WHERE m.idInformeEconomicoGrupo = ieg.idInformeEconomicoGrupo) AS totalIngresos,
           (SELECT COALESCE(SUM(CASE WHEN m.tipoMovimiento = N'EGRESO'
                                     THEN m.montoMovimiento ELSE 0 END), 0)
              FROM Voluntariado.tblMovimientosEconomicos m
             WHERE m.idInformeEconomicoGrupo = ieg.idInformeEconomicoGrupo) AS totalEgresos
      FROM Voluntariado.tblInformesEconomicosGrupos ieg
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = ieg.idGrupo
     WHERE ieg.idInformeEconomico = @id
     ORDER BY g.nombreGrupo
  `, { id: [sql.Int, informe.idInformeEconomico] });

  const movimientos = await consultar(`
    SELECT m.*
      FROM Voluntariado.tblMovimientosEconomicos m
      INNER JOIN Voluntariado.tblInformesEconomicosGrupos ieg
         ON ieg.idInformeEconomicoGrupo = m.idInformeEconomicoGrupo
     WHERE ieg.idInformeEconomico = @id
     ORDER BY m.fechaMovimiento, m.idMovimientoEconomico
  `, { id: [sql.Int, informe.idInformeEconomico] });

  return { ...informe, grupos, movimientos };
}

export interface MovimientoEconomico {
  idGrupo: number;
  tipoMovimiento: string;
  fechaMovimiento: string | null;
  descripcionMovimiento: string;
  responsableMovimiento: string | null;
  referenciaMovimiento: string | null;
  tipoComprobante: string | null;
  cantidadMovimiento: number | null;
  valorUnitario: number | null;
  montoMovimiento: number;
  comprobanteUrl: string | null;
}

/** Crea el informe economico si no existe y reemplaza sus movimientos. */
export function guardarInformeEconomico(
  idActividad: number,
  observaciones: string | null,
  saldosAnteriores: Record<number, number>,
  movimientos: MovimientoEconomico[],
  usuario: string,
) {
  return enTransaccion(async (ejecutar) => {
    const existentes = await ejecutar<{ idInformeEconomico: number }>(`
      SELECT idInformeEconomico FROM Voluntariado.tblInformesEconomicos
       WHERE idActividad = @idActividad
    `, { idActividad: [sql.Int, idActividad] });

    let idInforme: number;
    if (existentes.length > 0) {
      idInforme = existentes[0]!.idInformeEconomico;
      await ejecutar(`
        UPDATE Voluntariado.tblInformesEconomicos
           SET observacionesInformeEconomico = @observaciones
         WHERE idInformeEconomico = @id
      `, {
        observaciones: [sql.NVarChar(sql.MAX), observaciones],
        id: [sql.Int, idInforme],
      });
    } else {
      const creado = await ejecutar<{ idInformeEconomico: number }>(`
        INSERT INTO Voluntariado.tblInformesEconomicos
            (idActividad, observacionesInformeEconomico, usuarioRegistro)
        OUTPUT INSERTED.idInformeEconomico
        VALUES (@idActividad, @observaciones, @usuario)
      `, {
        idActividad: [sql.Int, idActividad],
        observaciones: [sql.NVarChar(sql.MAX), observaciones],
        usuario: [sql.NVarChar(90), usuario],
      });
      idInforme = creado[0]!.idInformeEconomico;
    }

    // Un renglon por grupo, creado a demanda segun los movimientos enviados.
    const porGrupo = new Map<number, number>();
    for (const idGrupo of new Set(movimientos.map((m) => m.idGrupo))) {
      const filas = await ejecutar<{ idInformeEconomicoGrupo: number }>(`
        SELECT idInformeEconomicoGrupo FROM Voluntariado.tblInformesEconomicosGrupos
         WHERE idInformeEconomico = @idInforme AND idGrupo = @idGrupo
      `, {
        idInforme: [sql.Int, idInforme],
        idGrupo: [sql.Int, idGrupo],
      });

      if (filas.length > 0) {
        porGrupo.set(idGrupo, filas[0]!.idInformeEconomicoGrupo);
        await ejecutar(`
          UPDATE Voluntariado.tblInformesEconomicosGrupos SET saldoAnterior = @saldo
           WHERE idInformeEconomicoGrupo = @id
        `, {
          saldo: [sql.Decimal(12, 2), saldosAnteriores[idGrupo] ?? 0],
          id: [sql.Int, filas[0]!.idInformeEconomicoGrupo],
        });
      } else {
        const creado = await ejecutar<{ idInformeEconomicoGrupo: number }>(`
          INSERT INTO Voluntariado.tblInformesEconomicosGrupos
              (idInformeEconomico, idGrupo, saldoAnterior, usuarioRegistro)
          OUTPUT INSERTED.idInformeEconomicoGrupo
          VALUES (@idInforme, @idGrupo, @saldo, @usuario)
        `, {
          idInforme: [sql.Int, idInforme],
          idGrupo: [sql.Int, idGrupo],
          saldo: [sql.Decimal(12, 2), saldosAnteriores[idGrupo] ?? 0],
          usuario: [sql.NVarChar(90), usuario],
        });
        porGrupo.set(idGrupo, creado[0]!.idInformeEconomicoGrupo);
      }
    }

    for (const idInformeGrupo of porGrupo.values()) {
      await ejecutar(`
        DELETE FROM Voluntariado.tblMovimientosEconomicos
         WHERE idInformeEconomicoGrupo = @id
      `, { id: [sql.Int, idInformeGrupo] });
    }

    for (const movimiento of movimientos) {
      await ejecutar(`
        INSERT INTO Voluntariado.tblMovimientosEconomicos
            (idInformeEconomicoGrupo, tipoMovimiento, fechaMovimiento, descripcionMovimiento,
             responsableMovimiento, referenciaMovimiento, tipoComprobante, cantidadMovimiento,
             valorUnitario, montoMovimiento, comprobanteUrl, usuarioRegistro)
        VALUES (@idInformeGrupo, @tipo, @fecha, @descripcion, @responsable, @referencia,
                @tipoComprobante, @cantidad, @valorUnitario, @monto, @comprobante, @usuario)
      `, {
        idInformeGrupo: [sql.Int, porGrupo.get(movimiento.idGrupo)!],
        tipo: [sql.NVarChar(10), movimiento.tipoMovimiento],
        fecha: [sql.Date, movimiento.fechaMovimiento],
        descripcion: [sql.NVarChar(300), movimiento.descripcionMovimiento],
        responsable: [sql.NVarChar(150), movimiento.responsableMovimiento],
        referencia: [sql.NVarChar(60), movimiento.referenciaMovimiento],
        tipoComprobante: [sql.NVarChar(30), movimiento.tipoComprobante],
        cantidad: [sql.Decimal(10, 2), movimiento.cantidadMovimiento],
        valorUnitario: [sql.Decimal(12, 2), movimiento.valorUnitario],
        monto: [sql.Decimal(12, 2), movimiento.montoMovimiento],
        comprobante: [sql.NVarChar(300), movimiento.comprobanteUrl],
        usuario: [sql.NVarChar(90), usuario],
      });
    }

    return { idInformeEconomico: idInforme, movimientos: movimientos.length };
  });
}

/* -------------------------------- Diplomas ------------------------------
   El porcentaje de participacion decide quien es elegible, asi que se
   calcula contra la base y no en el cliente: si cada pantalla lo recalcula
   por su cuenta, dos pantallas terminan discrepando sobre quien tiene
   diploma.                                                                */

/**
 * Elegibles de un grupo. El denominador son las actividades ejecutadas del
 * grupo en el alcance pedido; el numerador, las que la persona tiene como
 * ASISTIO. Se cuentan tanto las organizadas por el grupo como aquellas en
 * las que figura como coorganizador.
 */
export const listarElegiblesDiploma = (
  idGrupo: number,
  idTrimestre: number | null,
  umbralPorcentaje: number,
) =>
  consultar(`
    WITH actividadesGrupo AS (
        SELECT a.idActividad
          FROM Voluntariado.tblActividades a
          INNER JOIN Catalogo.tblEstados e ON e.idEstado = a.idEstado
         WHERE e.contextoEstado = N'VOL_ACTIVIDAD'
           AND e.codigoEstado = N'EJECUTADA'
           AND (@idTrimestre IS NULL OR a.idTrimestre = @idTrimestre)
           AND (a.idGrupoOrganizador = @idGrupo
                OR EXISTS (SELECT 1 FROM Voluntariado.tblActividadesGrupos ag
                            WHERE ag.idActividad = a.idActividad AND ag.idGrupo = @idGrupo))
    ),
    total AS (SELECT COUNT(*) AS actividadesGrupo FROM actividadesGrupo)
    SELECT pa.idPersona,
           COALESCE(pa.nombreSnapshot, CONCAT(p.nombrePersona, N' ', p.apellidosPersona)) AS nombre,
           de.numeroCuenta,
           t.actividadesGrupo,
           COUNT(*) AS actividadesAsistidas,
           CAST(100.0 * COUNT(*) / NULLIF(t.actividadesGrupo, 0) AS DECIMAL(5,2)) AS porcentajeParticipacion,
           COALESCE(SUM(pa.horasParticipacion), 0) AS horasConfirmadas,
           CASE WHEN EXISTS (SELECT 1 FROM Voluntariado.tblDiplomas d
                              WHERE d.idGrupo = @idGrupo AND d.idPersona = pa.idPersona)
                THEN 1 ELSE 0 END AS yaTieneDiploma
      FROM Voluntariado.tblParticipaciones pa
      INNER JOIN actividadesGrupo ag ON ag.idActividad = pa.idActividad
      INNER JOIN Catalogo.tblEstados e ON e.idEstado = pa.idEstado
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = pa.idPersona
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = pa.idPersona
      CROSS JOIN total t
     WHERE e.contextoEstado = N'VOL_PARTICIPACION' AND e.codigoEstado = N'ASISTIO'
     GROUP BY pa.idPersona, pa.nombreSnapshot, p.nombrePersona, p.apellidosPersona,
              de.numeroCuenta, t.actividadesGrupo
    HAVING CAST(100.0 * COUNT(*) / NULLIF(t.actividadesGrupo, 0) AS DECIMAL(5,2)) >= @umbral
     ORDER BY porcentajeParticipacion DESC, nombre
  `, {
    idGrupo: [sql.Int, idGrupo],
    idTrimestre: [sql.Int, idTrimestre],
    umbral: [sql.Decimal(5, 2), umbralPorcentaje],
  });

export const emitirDiploma = (
  datos: {
    idGrupo: number;
    idPersona: number;
    ventanaDiploma: string;
    actividadesGrupo: number;
    actividadesAsistidas: number;
    porcentajeParticipacion: number;
    archivoUrl: string | null;
  },
  usuario: string,
) =>
  consultarUna(`
    INSERT INTO Voluntariado.tblDiplomas
        (idGrupo, idPersona, ventanaDiploma, actividadesGrupo, actividadesAsistidas,
         porcentajeParticipacion, emitidoDiploma, fechaEmision, archivoUrl, usuarioRegistro)
    OUTPUT INSERTED.idDiploma, INSERTED.idPersona, INSERTED.porcentajeParticipacion,
           INSERTED.fechaEmision
    VALUES (@idGrupo, @idPersona, @ventana, @actividadesGrupo, @actividadesAsistidas,
            @porcentaje, 1, SYSDATETIME(), @archivoUrl, @usuario)
  `, {
    idGrupo: [sql.Int, datos.idGrupo],
    idPersona: [sql.Int, datos.idPersona],
    ventana: [sql.NVarChar(20), datos.ventanaDiploma],
    actividadesGrupo: [sql.Int, datos.actividadesGrupo],
    actividadesAsistidas: [sql.Int, datos.actividadesAsistidas],
    porcentaje: [sql.Decimal(5, 2), datos.porcentajeParticipacion],
    archivoUrl: [sql.NVarChar(300), datos.archivoUrl],
    usuario: [sql.NVarChar(90), usuario],
  });

export const listarDiplomas = (idGrupo: number) =>
  consultar(`
    SELECT d.idDiploma, d.idPersona, d.ventanaDiploma, d.actividadesGrupo,
           d.actividadesAsistidas, d.porcentajeParticipacion, d.emitidoDiploma,
           d.fechaEmision, d.archivoUrl,
           p.nombrePersona, p.apellidosPersona, de.numeroCuenta
      FROM Voluntariado.tblDiplomas d
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = d.idPersona
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = d.idPersona
     WHERE d.idGrupo = @idGrupo
     ORDER BY d.fechaEmision DESC
  `, { idGrupo: [sql.Int, idGrupo] });

/* ------------------------------- Diagnostico ---------------------------- */

export async function medirBaseDeDatos() {
  const inicio = Date.now();
  const fila = await consultarUna<{ ahora: Date }>(`SELECT SYSDATETIME() AS ahora`);
  return { ok: fila !== null, msConsulta: Date.now() - inicio, ahoraEnBase: fila?.ahora ?? null };
}
