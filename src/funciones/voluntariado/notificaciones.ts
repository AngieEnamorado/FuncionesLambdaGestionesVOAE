/**
 * Avisos de Voluntariado en Catalogo.tblNotificaciones.
 *
 * Esa tabla es la cola de correos compartida de los tres sistemas. Nadie envia
 * correos todavia, asi que cada aviso queda PENDIENTE y el portal lo muestra
 * como notificacion; si mas adelante se conecta un envio, saldran solos. La
 * lectura y el "marcar leida" los sirve voae-catalogo (/notificaciones).
 *
 * Cada aviso se arma en dos pasos: primero se leen los destinatarios (y lo que
 * el texto necesita), luego se insertan. Desde la v2 el correo y el nombre de
 * un estudiante viven en Registro, no en tblPersonas: se completan entre los
 * dos pasos con una sola consulta (compartido/registro.ts), fuera de cualquier
 * transaccion. correoDestino queda como registro del envio (asi lo decidio el
 * equipo); si Registro no da correo se guarda vacio. Si la persona o el grupo
 * no existen no se inserta nada. Las columnas de PROCAD y Giras quedan en NULL.
 */
import { consultar, sql, type Parametro } from "../../compartido/db";
import { completarConRegistro, completarUnaConRegistro } from "../../compartido/registro";
import { CARGO_COORDINADOR } from "./consultas";

/** Destinatario de un aviso, mas las columnas de contexto que traiga su consulta. */
type Destino = Record<string, unknown> & {
  idPersona: number;
  correoPersona: string | null;
  numeroCuenta: string | null;
};

interface Aviso {
  tipo: string;
  asunto: string;
  cuerpo: string;
  idSolicitudVoluntariado?: number | null;
}

/** Columnas de destinatario para un alias de tblPersonas (p) y de tblDetallesEstudiantes (de). */
const DESTINO = (p: string, de: string) => `${p}.idPersona, ${p}.correoPersona, ${de}.numeroCuenta`;

/** Los coordinadores activos de un grupo (alias c), con su cuenta (alias dc). */
const COORDINADORES = `
  FROM Voluntariado.tblMiembrosGrupos m
  INNER JOIN Catalogo.tblPersonas c ON c.idPersona = m.idPersona
  LEFT JOIN Catalogo.tblDetallesEstudiantes dc ON dc.idPersona = m.idPersona`;
const SOLO_COORDINADORES = `m.idCargo = ${CARGO_COORDINADOR} AND m.estadoMiembroGrupo = 1`;

const ROMANOS = ["I", "II", "III", "IV"];
const conMotivo = (cuerpo: string, etiqueta: string, detalle: string | null) =>
  detalle ? `${cuerpo} ${etiqueta}: ${detalle}` : cuerpo;

async function enviar(destinos: Destino[], armar: (destino: Destino) => Aviso, usuario: string) {
  if (destinos.length === 0) return;
  await completarConRegistro(destinos, { correoPersona: "correo" });
  for (const destino of destinos) {
    const aviso = armar(destino);
    await consultar(`
      INSERT INTO Catalogo.tblNotificaciones
          (sistemaOrigen, tipoNotificacion, idPersonaDestino, correoDestino,
           asuntoCorreo, cuerpoCorreo, idSolicitudVoluntariado, usuarioRegistro)
      VALUES (N'VOLUNTARIADO', @tipo, @idPersona, @correo, @asunto, @cuerpo, @idSolicitud, @usuario)
    `, {
      tipo: [sql.NVarChar(50), aviso.tipo],
      idPersona: [sql.Int, destino.idPersona],
      correo: [sql.NVarChar(120), (destino.correoPersona ?? "").slice(0, 120)],
      asunto: [sql.NVarChar(200), aviso.asunto.slice(0, 200)],
      cuerpo: [sql.NVarChar(sql.MAX), aviso.cuerpo],
      idSolicitud: [sql.Int, aviso.idSolicitudVoluntariado ?? null],
      usuario: [sql.NVarChar(90), usuario],
    });
  }
}

const id = (valor: number): Parametro => [sql.Int, valor];

const SOLICITUD_GRUPO: Record<string, { verbo: string; cuerpo: string }> = {
  APROBADA: { verbo: "fue aprobada", cuerpo: "La VOAE aprobó tu grupo: ya aparece en el portal y puedes administrarlo." },
  RECHAZADA: { verbo: "fue rechazada", cuerpo: "La VOAE rechazó la solicitud." },
  DEVUELTA: { verbo: "fue devuelta para corrección", cuerpo: "La VOAE la devolvió para que la corrijas." },
};

export async function solicitudGrupoResuelta(idSolicitud: number, estado: string, motivo: string | null, usuario: string) {
  const aviso = SOLICITUD_GRUPO[estado];
  if (!aviso) return;
  const destinos = await consultar<Destino>(`
    SELECT ${DESTINO("p", "de")}, s.nombreGrupo, s.idSolicitudGrupoNuevo
      FROM Voluntariado.tblSolicitudesGruposNuevos s
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = s.idPersonaSolicitante
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = p.idPersona
     WHERE s.idSolicitudGrupoNuevo = @id
  `, { id: id(idSolicitud) });
  await enviar(destinos, (d) => ({
    tipo: `GRUPO_${estado}`,
    asunto: `Tu solicitud del grupo «${d["nombreGrupo"]}» ${aviso.verbo}`,
    cuerpo: conMotivo(aviso.cuerpo, "Motivo", motivo),
    idSolicitudVoluntariado: d["idSolicitudGrupoNuevo"] as number,
  }), usuario);
}

/** Alguien pidio unirse: se avisa a los coordinadores del grupo. */
export async function solicitudUnionCreada(idGrupo: number, idPersona: number, usuario: string) {
  const [destinos, solicitante] = await Promise.all([
    consultar<Destino>(`
      SELECT ${DESTINO("c", "dc")}, g.nombreGrupo
      ${COORDINADORES}
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = m.idGrupo
     WHERE m.idGrupo = @idGrupo AND ${SOLO_COORDINADORES}
    `, { idGrupo: id(idGrupo) }),
    consultar<Record<string, unknown>>(`
      SELECT NULLIF(LTRIM(RTRIM(CONCAT(p.nombrePersona, N' ', p.apellidosPersona))), N'') AS nombre, de.numeroCuenta
        FROM Catalogo.tblPersonas p
        LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = p.idPersona
       WHERE p.idPersona = @idPersona
    `, { idPersona: id(idPersona) }).then((filas) => completarUnaConRegistro(filas[0] ?? null, { nombre: "completo" })),
  ]);
  const nombre = (solicitante?.["nombre"] as string | null) ?? "Un estudiante";
  await enviar(destinos, (d) => ({
    tipo: "UNION_SOLICITADA",
    asunto: `Nueva solicitud para unirse a «${d["nombreGrupo"]}»`,
    cuerpo: `${nombre} pidió unirse al grupo. Revísala en el panel de coordinador, en Solicitudes.`,
  }), usuario);
}

export async function solicitudUnionResuelta(idSolicitudUnion: number, estado: string, motivo: string | null, usuario: string) {
  const aprobada = estado === "APROBADA";
  const destinos = await consultar<Destino>(`
    SELECT ${DESTINO("p", "de")}, g.nombreGrupo
      FROM Voluntariado.tblSolicitudesUniones su
      INNER JOIN Catalogo.tblPersonas p ON p.idPersona = su.idPersona
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = p.idPersona
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = su.idGrupo
     WHERE su.idSolicitudUnion = @id
  `, { id: id(idSolicitudUnion) });
  await enviar(destinos, (d) => ({
    tipo: `UNION_${estado}`,
    asunto: `Tu solicitud para unirte a «${d["nombreGrupo"]}» ${aprobada ? "fue aprobada" : "fue rechazada"}`,
    cuerpo: conMotivo(aprobada ? "Ya eres miembro del grupo." : "El coordinador del grupo no la aceptó.", "Motivo", motivo),
  }), usuario);
}

/** La VOAE aprobo o rechazo una actividad: se avisa a los coordinadores del grupo organizador. */
export async function actividadResuelta(idActividad: number, estado: string, usuario: string) {
  if (estado !== "APROBADA" && estado !== "RECHAZADA") return;
  const aprobada = estado === "APROBADA";
  const destinos = await consultar<Destino>(`
    SELECT ${DESTINO("c", "dc")}, a.nombreActividad
    ${COORDINADORES}
    INNER JOIN Voluntariado.tblActividades a ON a.idGrupoOrganizador = m.idGrupo
     WHERE a.idActividad = @id AND ${SOLO_COORDINADORES}
  `, { id: id(idActividad) });
  await enviar(destinos, (d) => ({
    tipo: `ACTIVIDAD_${estado}`,
    asunto: `La actividad «${d["nombreActividad"]}» ${aprobada ? "fue aprobada" : "fue rechazada"}`,
    cuerpo: aprobada
      ? "La VOAE la aprobó: ya pueden inscribirse los estudiantes y, cuando ocurra, pasar lista."
      : "La VOAE la rechazó.",
  }), usuario);
}

/** La VOAE acepto u observo un informe trimestral: se avisa a los coordinadores del grupo. */
export async function informeDictaminado(idInforme: number, estado: string, observaciones: string | null, usuario: string) {
  const aceptado = estado === "ACEPTADO";
  const destinos = await consultar<Destino>(`
    SELECT ${DESTINO("c", "dc")}, t.numeroTrimestre, t.anioTrimestre
    ${COORDINADORES}
    INNER JOIN Voluntariado.tblInformesTrimestrales i ON i.idGrupo = m.idGrupo
    INNER JOIN Voluntariado.tblTrimestres t ON t.idTrimestre = i.idTrimestre
     WHERE i.idInformeTrimestral = @id AND ${SOLO_COORDINADORES}
  `, { id: id(idInforme) });
  await enviar(destinos, (d) => ({
    tipo: `INFORME_${estado}`,
    asunto: `Tu informe del ${ROMANOS[Number(d["numeroTrimestre"]) - 1] ?? d["numeroTrimestre"]} Trimestre ${d["anioTrimestre"]} ${aceptado ? "fue aceptado" : "fue observado"}`,
    cuerpo: conMotivo(aceptado
      ? "La VOAE aceptó el informe."
      : "La VOAE lo observó: corrige las actividades indicadas y reenvíalo desde el panel de coordinador.",
      "Observaciones", observaciones),
  }), usuario);
}

export async function diplomaEmitido(idGrupo: number, idPersona: number, usuario: string) {
  const destinos = await consultar<Destino>(`
    SELECT ${DESTINO("p", "de")}, g.nombreGrupo
      FROM Catalogo.tblPersonas p
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = p.idPersona
      INNER JOIN Voluntariado.tblGrupos g ON g.idGrupo = @idGrupo
     WHERE p.idPersona = @idPersona
  `, { idGrupo: id(idGrupo), idPersona: id(idPersona) });
  await enviar(destinos, (d) => ({
    tipo: "DIPLOMA_EMITIDO",
    asunto: `Recibiste el diploma de «${d["nombreGrupo"]}»`,
    cuerpo: "La VOAE emitió tu diploma de reconocimiento. Descárgalo en el portal, en Mi historial.",
  }), usuario);
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
