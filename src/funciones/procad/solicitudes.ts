/**
 * Solicitudes de ingreso a una agrupacion y lo que cuelga de ellas:
 * resolucion, excepciones de talento (condicionados), expulsiones y
 * matriculas excepcionales.
 *
 * Las reglas las ponen los triggers de Procad.tblSolicitudes y
 * Procad.tblSolicitudesExpulsion (matricula verificada, indice minimo con
 * doble firma, una solicitud activa por periodo, mismo campus, categoria de
 * sexo, quien puede solicitar y resolver una expulsion, que la expulsion
 * aprobada pase la solicitud a EXPULSADO...). Aqui no se repite ninguna.
 *
 * Lo unico que se decide aqui es desde que estado se puede partir, porque
 * ningun trigger lo cubre: una solicitud solo se resuelve si esta PENDIENTE
 * (§12 del diseno: los estados finales no se revierten a mano), y el log de
 * estados lo escribe la aplicacion porque ningun trigger lo hace.
 */
import { consultar, consultarUna, enTransaccion, sql, type Parametro } from "../../compartido/db";
import { conflicto, noEncontrado, solicitudInvalida } from "../../compartido/errores";
import { Filtros, CONTEXTO, idEstado, usuarioParam, type Ejecutor } from "./entrada";

export const ESTADOS_SOLICITUD = [
  "PENDIENTE", "APROBADO", "NO_CUMPLE_REQUISITO", "OBSERVADO", "EXPULSADO",
] as const;
/** EXPULSADO no se asigna a mano: lo pone tgrSolicitudesExpulsionAplicar al aprobar una expulsion. */
export const DECISIONES_SOLICITUD = ["APROBADO", "OBSERVADO", "NO_CUMPLE_REQUISITO"] as const;
export const ESTADOS_EXPULSION = ["PENDIENTE", "APROBADA", "RECHAZADA"] as const;
export const DECISIONES_EXPULSION = ["APROBADA", "RECHAZADA"] as const;

/** Columnas del estudiante que toda lista necesita para identificarlo. */
const ESTUDIANTE = `
  p.nombrePersona, p.apellidosPersona, p.correoPersona, de.numeroCuenta`;

const DESDE_SOLICITUD = `
  FROM Procad.tblSolicitudes s
 INNER JOIN Procad.tblGrupos g       ON g.idGrupo = s.idGrupo
 INNER JOIN Procad.tblTiposGrupo tg  ON tg.idTipoGrupo = g.idTipoGrupo
 INNER JOIN Catalogo.tblCampus c     ON c.idCampus = g.idCampus
 INNER JOIN Catalogo.tblPersonas p   ON p.idPersona = s.idPersona
 INNER JOIN Catalogo.tblEstados e    ON e.idEstado = s.idEstado
  LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = s.idPersona`;

const COLUMNAS_SOLICITUD = `
  s.idSolicitud, s.idPersona, ${ESTUDIANTE},
  s.idGrupo, g.nombreGrupo, tg.nombreTipoGrupo AS tipoGrupo, g.idCampus, c.nombreCampus,
  s.idPeriodo, e.codigoEstado, e.nombreEstado,
  s.cumpleIndiceMinimo, s.esEquipo, s.esCondicionado, s.idVisoriaAsignada,
  s.fechaInscripcion, s.fechaActualizacion, s.fechaRegistro`;

/* ------------------------------- Solicitudes ------------------------------ */

export interface FiltrosSolicitudes {
  campus: number | null;
  tipoGrupo: string | null;
  grupo: number | null;
  estado: string | null;
  periodo: number | null;
  /** Busca en nombre, apellidos y numero de cuenta (RF-10). */
  texto: string | null;
}

export function listarSolicitudes(f: FiltrosSolicitudes) {
  const filtros = new Filtros()
    .si(f.campus, "campus", sql.Int, "g.idCampus = @campus")
    .si(f.tipoGrupo, "tipoGrupo", sql.NVarChar(20), "tg.nombreTipoGrupo = @tipoGrupo")
    .si(f.grupo, "grupo", sql.Int, "s.idGrupo = @grupo")
    .si(f.estado, "estado", sql.NVarChar(40), "e.codigoEstado = @estado")
    .si(f.periodo, "periodo", sql.Int, "s.idPeriodo = @periodo")
    .si(
      f.texto === null ? null : `%${f.texto}%`, "texto", sql.NVarChar(210),
      "(p.nombrePersona + N' ' + p.apellidosPersona LIKE @texto OR de.numeroCuenta LIKE @texto)",
    );

  return consultar(`
    SELECT ${COLUMNAS_SOLICITUD}
    ${DESDE_SOLICITUD}
    ${filtros.where}
     ORDER BY s.fechaRegistro DESC
  `, filtros.parametros);
}

/** Ficha completa: solicitud, estudiante, detalle, adjuntos de experiencia e historial de estados. */
export async function obtenerSolicitud(idSolicitud: number) {
  const parametros: Record<string, Parametro> = { id: [sql.Int, idSolicitud] };

  const solicitud = await consultarUna(`
    SELECT ${COLUMNAS_SOLICITUD},
           p.telefonoPersona, p.sexoPersona,
           de.carreraEstudiante, de.indicePeriodo, de.indiceGlobal, de.matriculaVerificada,
           de.fotoUrl, de.carnetDigitalUrl, de.forma003Url,
           s.idUltimoPeriodo,
           s.idPersonaProponeCondicionado, s.idPersonaAutorizaCondicionado
    ${DESDE_SOLICITUD}
     WHERE s.idSolicitud = @id
  `, { ...parametros });
  if (!solicitud) throw noEncontrado(`No existe la solicitud ${idSolicitud}.`);

  const [detalle, adjuntos, historial] = await Promise.all([
    consultarUna(`
      SELECT d.idDetalleSolicitud, d.contactoEmergenciaNombre, d.contactoEmergenciaTelefono,
             d.aceptoReglamento, d.idPosicion, po.nombrePosicion, d.alergia,
             d.idInstrumento, i.nombreInstrumento, d.nivelExperiencia
        FROM Procad.tblDetallesSolicitudes d
        LEFT JOIN Procad.tblPosiciones po  ON po.idPosicion = d.idPosicion
        LEFT JOIN Procad.tblInstrumentos i ON i.idInstrumento = d.idInstrumento
       WHERE d.idSolicitud = @id
    `, { ...parametros }),
    consultar(`
      SELECT idAdjunto, tipoAdjunto, contenidoTexto, urlArchivo, fechaRegistro
        FROM Procad.tblAdjuntosSolicitudes
       WHERE idSolicitud = @id
       ORDER BY idAdjunto
    `, { ...parametros }),
    consultar(`
      SELECT l.idLogEstadoSolicitud, ea.codigoEstado AS estadoAnterior, en.codigoEstado AS estadoNuevo,
             l.observacionCambio, l.idPersona, p.nombrePersona, p.apellidosPersona, l.fechaCambio
        FROM Procad.tblLogsEstadosSolicitudes l
        LEFT JOIN Catalogo.tblEstados ea  ON ea.idEstado = l.idEstadoAnterior
       INNER JOIN Catalogo.tblEstados en  ON en.idEstado = l.idEstadoNuevo
        LEFT JOIN Catalogo.tblPersonas p  ON p.idPersona = l.idPersona
       WHERE l.idSolicitud = @id
       ORDER BY l.fechaCambio, l.idLogEstadoSolicitud
    `, { ...parametros }),
  ]);

  return { ...solicitud, detalle, adjuntos, historial };
}

/** Lee y BLOQUEA la solicitud: dos resoluciones simultaneas se serializan aqui. */
async function bloquearSolicitud(ejecutar: Ejecutor, idSolicitud: number) {
  const filas = await ejecutar<{ idEstado: number; codigoEstado: string; esCondicionado: boolean }>(`
    SELECT s.idEstado, e.codigoEstado, s.esCondicionado
      FROM Procad.tblSolicitudes s WITH (UPDLOCK)
     INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
     WHERE s.idSolicitud = @id
  `, { id: [sql.Int, idSolicitud] });
  if (!filas[0]) throw noEncontrado(`No existe la solicitud ${idSolicitud}.`);
  return filas[0];
}

/** Escribe una fila en el log de auditoria de estados (RF-15). Ningun trigger lo hace. */
async function registrarCambioDeEstado(
  ejecutar: Ejecutor,
  cambio: {
    idSolicitud: number;
    idPersona: number | null;
    idEstadoAnterior: number;
    observacion: string | null;
    usuario: string;
  },
) {
  await ejecutar(`
    INSERT INTO Procad.tblLogsEstadosSolicitudes
      (idSolicitud, idPersona, idEstadoAnterior, idEstadoNuevo, observacionCambio, usuarioRegistro)
    SELECT @idSolicitud, @idPersona, @idEstadoAnterior, s.idEstado, @observacion, @usuario
      FROM Procad.tblSolicitudes s
     WHERE s.idSolicitud = @idSolicitud
  `, {
    idSolicitud: [sql.Int, cambio.idSolicitud],
    idPersona: [sql.Int, cambio.idPersona],
    idEstadoAnterior: [sql.Int, cambio.idEstadoAnterior],
    observacion: [sql.NVarChar(300), cambio.observacion],
    usuario: usuarioParam(cambio.usuario),
  });
}

export interface Resolucion {
  decision: (typeof DECISIONES_SOLICITUD)[number];
  /** Quien resuelve (encargado o administrador). Queda en el log. */
  idPersona: number;
  observacion: string | null;
}

/**
 * Aprobar, observar o marcar como no cumple. Lo que haga falta para aprobar
 * (matricula verificada, indice o condicionado con doble firma, una sola
 * solicitud activa en el periodo) lo exige la base al hacer el UPDATE.
 */
export async function resolverSolicitud(idSolicitud: number, r: Resolucion, usuario: string) {
  if (r.decision === "OBSERVADO" && r.observacion === null) {
    // RF-12: al observar hay que decir que corregir.
    throw solicitudInvalida("Para observar una solicitud hay que indicar en observacion que debe corregirse.");
  }

  await enTransaccion(async (ejecutar) => {
    const actual = await bloquearSolicitud(ejecutar, idSolicitud);
    if (actual.codigoEstado !== "PENDIENTE") {
      throw conflicto(
        `La solicitud ${idSolicitud} esta en estado ${actual.codigoEstado}: solo se resuelve una solicitud PENDIENTE.`,
      );
    }

    await ejecutar(`
      UPDATE Procad.tblSolicitudes
         SET idEstado = ${idEstado(CONTEXTO.solicitud, "decision")},
             fechaActualizacion = SYSDATETIME()
       WHERE idSolicitud = @id
    `, { id: [sql.Int, idSolicitud], decision: [sql.NVarChar(40), r.decision] });

    await registrarCambioDeEstado(ejecutar, {
      idSolicitud,
      idPersona: r.idPersona,
      idEstadoAnterior: actual.idEstado,
      observacion: r.observacion,
      usuario,
    });
  });

  return obtenerSolicitud(idSolicitud);
}

/**
 * Marca o desmarca a un integrante como parte del equipo que compite. Solo
 * los del equipo pueden entrar a una seleccion (tgrSeleccionIntegrantesCoherente);
 * al desmarcarlo, tgrSolicitudesSincronizarSeleccion lo saca de sus selecciones.
 */
export async function marcarEquipo(idSolicitud: number, esEquipo: boolean) {
  await enTransaccion(async (ejecutar) => {
    const actual = await bloquearSolicitud(ejecutar, idSolicitud);
    if (actual.codigoEstado !== "APROBADO") {
      throw conflicto(
        `La solicitud ${idSolicitud} esta en estado ${actual.codigoEstado}: solo un integrante APROBADO puede ser parte del equipo.`,
      );
    }
    await ejecutar(`
      UPDATE Procad.tblSolicitudes
         SET esEquipo = @esEquipo, fechaActualizacion = SYSDATETIME()
       WHERE idSolicitud = @id
    `, { id: [sql.Int, idSolicitud], esEquipo: [sql.Bit, esEquipo] });
  });
  return obtenerSolicitud(idSolicitud);
}

/* ------------------------------ Condicionados ----------------------------- */

/**
 * Excepcion de talento: un estudiante que no cumple el indice minimo entra
 * con doble firma. tgrSolicitudesCondicionadoAutorizado exige las dos a la vez
 * en cuanto esCondicionado = 1, asi que el flujo en dos pasos queda asi:
 *
 *   1. propuesta:    se guarda idPersonaProponeCondicionado, esCondicionado sigue en 0.
 *   2. autorizacion: esCondicionado = 1 + idPersonaAutorizaCondicionado. Aqui el
 *                    trigger valida AMBAS firmas (director interno con acceso
 *                    vigente al grupo, y administrador PROCAD).
 */
/** POR_RECONFIRMAR: arrastrados PENDIENTE al periodo nuevo, esperando que sus firmantes repitan el flujo. */
export const ESTADOS_CONDICIONADO = ["PROPUESTO", "AUTORIZADO", "POR_RECONFIRMAR"] as const;

export function listarCondicionados(f: {
  estado: (typeof ESTADOS_CONDICIONADO)[number] | null;
  grupo: number | null;
  campus: number | null;
  periodo: number | null;
}) {
  const condicion = {
    PROPUESTO: "(s.idPersonaProponeCondicionado IS NOT NULL AND s.esCondicionado = 0)",
    AUTORIZADO: "s.esCondicionado = 1",
    POR_RECONFIRMAR: `(s.idPersonaProponeCondicionado IS NULL AND s.esCondicionado = 0
                       AND ant.idSolicitud IS NOT NULL AND e.codigoEstado = N'PENDIENTE')`,
  };
  const filtros = new Filtros()
    .siempre(f.estado ? condicion[f.estado] : `(${Object.values(condicion).join(" OR ")})`)
    .si(f.grupo, "grupo", sql.Int, "s.idGrupo = @grupo")
    .si(f.campus, "campus", sql.Int, "g.idCampus = @campus")
    .si(f.periodo, "periodo", sql.Int, "s.idPeriodo = @periodo");

  // ant: la solicitud del periodo anterior, si fue condicionada. Sus firmantes
  // son quienes tienen que decidir si repiten la propuesta y la autorizacion.
  return consultar(`
    SELECT ${COLUMNAS_SOLICITUD},
           de.indiceGlobal,
           s.idPersonaProponeCondicionado,
           pp.nombrePersona AS nombrePropone, pp.apellidosPersona AS apellidosPropone,
           s.idPersonaAutorizaCondicionado,
           pa.nombrePersona AS nombreAutoriza, pa.apellidosPersona AS apellidosAutoriza,
           ant.idSolicitud AS idSolicitudAnterior,
           ant.idPersonaProponeCondicionado AS idPersonaProponeAnterior,
           ant.idPersonaAutorizaCondicionado AS idPersonaAutorizaAnterior
    ${DESDE_SOLICITUD}
      LEFT JOIN Catalogo.tblPersonas pp ON pp.idPersona = s.idPersonaProponeCondicionado
      LEFT JOIN Catalogo.tblPersonas pa ON pa.idPersona = s.idPersonaAutorizaCondicionado
     OUTER APPLY (
        SELECT TOP 1 sa.idSolicitud, sa.idPersonaProponeCondicionado, sa.idPersonaAutorizaCondicionado
          FROM Procad.tblSolicitudes sa
         WHERE sa.idPersona = s.idPersona AND sa.idGrupo = s.idGrupo
           AND sa.idPeriodo = s.idUltimoPeriodo AND sa.esCondicionado = 1
     ) ant
    ${filtros.where}
     ORDER BY s.esCondicionado, s.fechaActualizacion DESC
  `, filtros.parametros);
}

export async function proponerCondicionado(idSolicitud: number, idPersonaPropone: number) {
  await enTransaccion(async (ejecutar) => {
    const actual = await bloquearSolicitud(ejecutar, idSolicitud);
    if (actual.esCondicionado) {
      throw conflicto(`La solicitud ${idSolicitud} ya fue autorizada como condicionado.`);
    }
    await ejecutar(`
      UPDATE Procad.tblSolicitudes
         SET idPersonaProponeCondicionado = @propone, fechaActualizacion = SYSDATETIME()
       WHERE idSolicitud = @id
    `, { id: [sql.Int, idSolicitud], propone: [sql.Int, idPersonaPropone] });
  });
  return obtenerSolicitud(idSolicitud);
}

export async function autorizarCondicionado(idSolicitud: number, idPersonaAutoriza: number) {
  await enTransaccion(async (ejecutar) => {
    const actual = await bloquearSolicitud(ejecutar, idSolicitud);
    if (actual.esCondicionado) {
      throw conflicto(`La solicitud ${idSolicitud} ya fue autorizada como condicionado.`);
    }
    // Si falta la propuesta o alguna firma no califica, el trigger lo rechaza con su mensaje.
    await ejecutar(`
      UPDATE Procad.tblSolicitudes
         SET esCondicionado = 1, idPersonaAutorizaCondicionado = @autoriza,
             fechaActualizacion = SYSDATETIME()
       WHERE idSolicitud = @id
    `, { id: [sql.Int, idSolicitud], autoriza: [sql.Int, idPersonaAutoriza] });
  });
  return obtenerSolicitud(idSolicitud);
}

/* ------------------------------- Expulsiones ------------------------------ */

const COLUMNAS_EXPULSION = `
  x.idSolicitudExpulsion, x.idSolicitud, s.idPersona, ${ESTUDIANTE},
  s.idGrupo, g.nombreGrupo, g.idCampus, c.nombreCampus, s.idPeriodo,
  x.idMotivoExpulsion, m.nombreMotivoExpulsion, x.detalleMotivo,
  ex.codigoEstado, ex.nombreEstado,
  x.idPersonaSolicita, ps.nombrePersona AS nombreSolicita, ps.apellidosPersona AS apellidosSolicita,
  x.idPersonaResuelve, pr.nombrePersona AS nombreResuelve, pr.apellidosPersona AS apellidosResuelve,
  x.observacionResolucion, x.fechaResolucion, x.fechaRegistro`;

const DESDE_EXPULSION = `
  FROM Procad.tblSolicitudesExpulsion x
 INNER JOIN Procad.tblSolicitudes s       ON s.idSolicitud = x.idSolicitud
 INNER JOIN Procad.tblGrupos g            ON g.idGrupo = s.idGrupo
 INNER JOIN Catalogo.tblCampus c          ON c.idCampus = g.idCampus
 INNER JOIN Catalogo.tblPersonas p        ON p.idPersona = s.idPersona
  LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = s.idPersona
 INNER JOIN Procad.tblMotivosExpulsion m  ON m.idMotivoExpulsion = x.idMotivoExpulsion
 INNER JOIN Catalogo.tblEstados ex        ON ex.idEstado = x.idEstado
 INNER JOIN Catalogo.tblPersonas ps       ON ps.idPersona = x.idPersonaSolicita
  LEFT JOIN Catalogo.tblPersonas pr       ON pr.idPersona = x.idPersonaResuelve`;

export function listarExpulsiones(f: { estado: string | null; grupo: number | null; campus: number | null }) {
  const filtros = new Filtros()
    .si(f.estado, "estado", sql.NVarChar(40), "ex.codigoEstado = @estado")
    .si(f.grupo, "grupo", sql.Int, "s.idGrupo = @grupo")
    .si(f.campus, "campus", sql.Int, "g.idCampus = @campus");

  return consultar(`
    SELECT ${COLUMNAS_EXPULSION}
    ${DESDE_EXPULSION}
    ${filtros.where}
     ORDER BY x.fechaRegistro DESC
  `, filtros.parametros);
}

export async function obtenerExpulsion(idExpulsion: number) {
  const fila = await consultarUna(`
    SELECT ${COLUMNAS_EXPULSION}
    ${DESDE_EXPULSION}
     WHERE x.idSolicitudExpulsion = @id
  `, { id: [sql.Int, idExpulsion] });
  if (!fila) throw noEncontrado(`No existe la solicitud de expulsion ${idExpulsion}.`);
  return fila;
}

export interface NuevaExpulsion {
  idSolicitud: number;
  idPersonaSolicita: number;
  idMotivoExpulsion: number;
  detalleMotivo: string | null;
}

/** Quien puede pedirla (director interno del grupo o admin) lo valida tgrSolicitudesExpulsionValidarSolicitante. */
export async function solicitarExpulsion(x: NuevaExpulsion, usuario: string) {
  const id = await enTransaccion(async (ejecutar) => {
    const solicitud = await bloquearSolicitud(ejecutar, x.idSolicitud);
    if (solicitud.codigoEstado !== "APROBADO") {
      throw conflicto(
        `La solicitud ${x.idSolicitud} esta en estado ${solicitud.codigoEstado}: solo se puede expulsar a un integrante APROBADO.`,
      );
    }

    const filas = await ejecutar<{ id: number }>(`
      INSERT INTO Procad.tblSolicitudesExpulsion
        (idSolicitud, idPersonaSolicita, idMotivoExpulsion, detalleMotivo, idEstado, usuarioRegistro)
      VALUES (@idSolicitud, @solicita, @motivo, @detalle, ${idEstado(CONTEXTO.expulsion, "pendiente")}, @usuario);
      SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
    `, {
      idSolicitud: [sql.Int, x.idSolicitud],
      solicita: [sql.Int, x.idPersonaSolicita],
      motivo: [sql.Int, x.idMotivoExpulsion],
      detalle: [sql.NVarChar(300), x.detalleMotivo],
      pendiente: [sql.NVarChar(40), "PENDIENTE"],
      usuario: usuarioParam(usuario),
    });
    return filas[0]!.id;
  });
  return obtenerExpulsion(id);
}

export interface ResolucionExpulsion {
  decision: (typeof DECISIONES_EXPULSION)[number];
  idPersonaResuelve: number;
  observacion: string | null;
}

/**
 * Aprueba o rechaza. Los triggers exigen que resuelva un administrador,
 * impiden tocar una ya resuelta, y al aprobar pasan la solicitud a EXPULSADO
 * (tgrSolicitudesExpulsionAplicar). Ese cambio de estado de la solicitud no
 * queda en el log por si solo, asi que se registra aqui si efectivamente ocurrio.
 */
export async function resolverExpulsion(idExpulsion: number, r: ResolucionExpulsion, usuario: string) {
  await enTransaccion(async (ejecutar) => {
    const antes = await ejecutar<{ idSolicitud: number; idEstadoSolicitud: number }>(`
      SELECT x.idSolicitud, s.idEstado AS idEstadoSolicitud
        FROM Procad.tblSolicitudesExpulsion x WITH (UPDLOCK)
       INNER JOIN Procad.tblSolicitudes s WITH (UPDLOCK) ON s.idSolicitud = x.idSolicitud
       WHERE x.idSolicitudExpulsion = @id
    `, { id: [sql.Int, idExpulsion] });
    if (!antes[0]) throw noEncontrado(`No existe la solicitud de expulsion ${idExpulsion}.`);
    const { idSolicitud, idEstadoSolicitud } = antes[0];

    await ejecutar(`
      UPDATE Procad.tblSolicitudesExpulsion
         SET idEstado = ${idEstado(CONTEXTO.expulsion, "decision")},
             idPersonaResuelve = @resuelve,
             observacionResolucion = @observacion,
             fechaResolucion = SYSDATETIME()
       WHERE idSolicitudExpulsion = @id
    `, {
      id: [sql.Int, idExpulsion],
      decision: [sql.NVarChar(40), r.decision],
      resuelve: [sql.Int, r.idPersonaResuelve],
      observacion: [sql.NVarChar(300), r.observacion],
    });

    const despues = await ejecutar<{ idEstado: number }>(
      "SELECT idEstado FROM Procad.tblSolicitudes WHERE idSolicitud = @id",
      { id: [sql.Int, idSolicitud] },
    );
    if (despues[0] && despues[0].idEstado !== idEstadoSolicitud) {
      await registrarCambioDeEstado(ejecutar, {
        idSolicitud,
        idPersona: r.idPersonaResuelve,
        idEstadoAnterior: idEstadoSolicitud,
        observacion: `Expulsion ${idExpulsion} aprobada.${r.observacion ? ` ${r.observacion}` : ""}`.slice(0, 300),
        usuario,
      });
    }
  });
  return obtenerExpulsion(idExpulsion);
}

/* ------------------------- Matriculas excepcionales ----------------------- */

const COLUMNAS_MATRICULA = `
  me.idMatriculaExcepcional, me.idPersona, ${ESTUDIANTE},
  me.idPeriodo, me.motivoExcepcion, me.estadoExcepcion,
  me.idPersonaAutoriza, pa.nombrePersona AS nombreAutoriza, pa.apellidosPersona AS apellidosAutoriza,
  me.fechaRegistro`;

const DESDE_MATRICULA = `
  FROM Procad.tblMatriculasExcepcionales me
 INNER JOIN Catalogo.tblPersonas p   ON p.idPersona = me.idPersona
  LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = me.idPersona
 INNER JOIN Catalogo.tblPersonas pa  ON pa.idPersona = me.idPersonaAutoriza`;

export function listarMatriculasExcepcionales(f: { periodo: number | null; soloActivas: boolean }) {
  const filtros = new Filtros().si(f.periodo, "periodo", sql.Int, "me.idPeriodo = @periodo");
  if (f.soloActivas) filtros.siempre("me.estadoExcepcion = 1");
  return consultar(`
    SELECT ${COLUMNAS_MATRICULA}
    ${DESDE_MATRICULA}
    ${filtros.where}
     ORDER BY me.fechaRegistro DESC
  `, filtros.parametros);
}

export interface NuevaMatriculaExcepcional {
  idPersona: number;
  idPeriodo: number;
  motivoExcepcion: string;
  idPersonaAutoriza: number;
}

/** Una sola firma, la de un administrador: la exige tgrMatriculasExcepcionalesAutorizanteEsAdmin. */
export async function crearMatriculaExcepcional(m: NuevaMatriculaExcepcional, usuario: string) {
  const filas = await consultar<{ id: number }>(`
    INSERT INTO Procad.tblMatriculasExcepcionales
      (idPersona, idPeriodo, motivoExcepcion, idPersonaAutoriza, usuarioRegistro)
    VALUES (@persona, @periodo, @motivo, @autoriza, @usuario);
    SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
  `, {
    persona: [sql.Int, m.idPersona],
    periodo: [sql.Int, m.idPeriodo],
    motivo: [sql.NVarChar(300), m.motivoExcepcion],
    autoriza: [sql.Int, m.idPersonaAutoriza],
    usuario: usuarioParam(usuario),
  });

  return consultarUna(`
    SELECT ${COLUMNAS_MATRICULA}
    ${DESDE_MATRICULA}
     WHERE me.idMatriculaExcepcional = @id
  `, { id: [sql.Int, filas[0]!.id] });
}
