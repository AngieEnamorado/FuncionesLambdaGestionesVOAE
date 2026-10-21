/**
 * Visorias (pruebas de ingreso): calendario del periodo y estudiantes citados.
 *
 * Reglas que pone la base y no se repiten aqui:
 * - tgrVisoriasNoTraslape: no dos visorias en el mismo lugar, fecha y hora (RF-51).
 * - tgrVisoriasLugarMismoCampus: el lugar es del mismo campus que la visoria.
 *
 * - tgrVisoriasGrupoMismoCampus: el grupo que cita es del mismo campus (salvo una seleccion).
 *
 * Una visoria nace BORRADOR: solo la ve el administrador hasta que la programa.
 * No tiene cupo; citar a un estudiante es asignarle la visoria en su solicitud
 * (tblSolicitudes.idVisoriaAsignada).
 */
import { consultar, consultarUna, enTransaccion, sql, type Parametro } from "../../compartido/db";
import { conflicto, noEncontrado } from "../../compartido/errores";
import { Filtros, usuarioParam } from "./entrada";
import { conDatosDeRegistro, ordenarPorNombre } from "./registro";

const COLUMNAS_VISORIA = `
  v.idVisoria, v.idPeriodo, v.idCampus, c.nombreCampus, v.fechaVisoria,
  CONVERT(VARCHAR(5), v.horaVisoria, 108) AS horaVisoria,
  v.idLugarVisoria, lv.nombreLugar, v.idAula, au.nombreAula, v.idGrupo, g.nombreGrupo, v.estadoVisoria,
  v.usuarioRegistro, v.fechaRegistro,
  (SELECT COUNT(*) FROM Procad.tblSolicitudes s WHERE s.idVisoriaAsignada = v.idVisoria) AS citados`;

const DESDE_VISORIA = `
  FROM Procad.tblVisorias v
 INNER JOIN Catalogo.tblCampus c ON c.idCampus = v.idCampus
  LEFT JOIN Procad.tblLugaresVisoria lv ON lv.idLugarVisoria = v.idLugarVisoria
  LEFT JOIN Procad.tblAulas au ON au.idAula = v.idAula
  LEFT JOIN Procad.tblGrupos g ON g.idGrupo = v.idGrupo`;

export const ESTADOS_VISORIA = ["BORRADOR", "PROGRAMADA"] as const;

export function listarVisorias(f: {
  periodo: number | null;
  campus: number | null;
  grupo: number | null;
  estado: string | null;
  desde: string | null;
  hasta: string | null;
}) {
  const filtros = new Filtros()
    .si(f.grupo, "grupo", sql.Int, "v.idGrupo = @grupo")
    .si(f.estado, "estado", sql.NVarChar(15), "v.estadoVisoria = @estado")
    .si(f.periodo, "periodo", sql.Int, "v.idPeriodo = @periodo")
    .si(f.campus, "campus", sql.Int, "v.idCampus = @campus")
    .si(f.desde, "desde", sql.Date, "v.fechaVisoria >= @desde")
    .si(f.hasta, "hasta", sql.Date, "v.fechaVisoria <= @hasta");
  return consultar(`
    SELECT ${COLUMNAS_VISORIA}
    ${DESDE_VISORIA}
    ${filtros.where}
     ORDER BY v.fechaVisoria, v.horaVisoria
  `, filtros.parametros);
}

export async function obtenerVisoria(idVisoria: number) {
  const visoria = await consultarUna(`
    SELECT ${COLUMNAS_VISORIA}
    ${DESDE_VISORIA}
     WHERE v.idVisoria = @id
  `, { id: [sql.Int, idVisoria] });
  if (!visoria) throw noEncontrado(`No existe la visoria ${idVisoria}.`);

  const filas = await consultar(`
    SELECT s.idSolicitud, s.idPersona, de.numeroCuenta,
           s.idGrupo, g.nombreGrupo, e.codigoEstado
      FROM Procad.tblSolicitudes s
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = s.idPersona
     INNER JOIN Procad.tblGrupos g     ON g.idGrupo = s.idGrupo
     INNER JOIN Catalogo.tblEstados e  ON e.idEstado = s.idEstado
     WHERE s.idVisoriaAsignada = @id
  `, { id: [sql.Int, idVisoria] });
  const citados = ordenarPorNombre(await conDatosDeRegistro(filas), (f) => String(f["nombreGrupo"] ?? ""));

  return { ...visoria, estudiantes: citados };
}

export interface NuevaVisoria {
  idPeriodo: number;
  idCampus: number;
  fechaVisoria: string;
  horaVisoria: string | null;
  idLugarVisoria: number | null;
  idAula: number | null;
  idGrupo: number | null;
}

export async function crearVisoria(n: NuevaVisoria, usuario: string) {
  const filas = await consultar<{ id: number }>(`
    INSERT INTO Procad.tblVisorias
      (idPeriodo, idCampus, fechaVisoria, horaVisoria, idLugarVisoria, idAula, idGrupo, estadoVisoria, usuarioRegistro)
    VALUES (@periodo, @campus, @fecha, @hora, @lugar, @aula, @grupo, N'BORRADOR', @usuario);
    SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
  `, {
    periodo: [sql.Int, n.idPeriodo],
    campus: [sql.Int, n.idCampus],
    fecha: [sql.Date, n.fechaVisoria],
    hora: [sql.VarChar(8), n.horaVisoria],
    lugar: [sql.Int, n.idLugarVisoria],
    aula: [sql.Int, n.idAula],
    grupo: [sql.Int, n.idGrupo],
    usuario: usuarioParam(usuario),
  });
  return obtenerVisoria(filas[0]!.id);
}

/** De BORRADOR a PROGRAMADA: desde ahi la visoria es visible para los citados. */
export async function programarVisoria(idVisoria: number) {
  await enTransaccion(async (ejecutar) => {
    const actual = await ejecutar<{ estadoVisoria: string }>(
      "SELECT estadoVisoria FROM Procad.tblVisorias WITH (UPDLOCK) WHERE idVisoria = @id",
      { id: [sql.Int, idVisoria] },
    );
    if (!actual[0]) throw noEncontrado(`No existe la visoria ${idVisoria}.`);
    if (actual[0].estadoVisoria !== "BORRADOR") {
      throw conflicto(`La visoria ${idVisoria} ya esta programada.`);
    }
    await ejecutar(
      "UPDATE Procad.tblVisorias SET estadoVisoria = N'PROGRAMADA' WHERE idVisoria = @id",
      { id: [sql.Int, idVisoria] },
    );
  });
  return obtenerVisoria(idVisoria);
}

/**
 * Cita estudiantes a la visoria (RF-23): asigna la visoria a sus solicitudes.
 * Todo o nada: si una solicitud no existe, no se cita a nadie.
 */
export async function citarEstudiantes(idVisoria: number, solicitudes: number[]) {
  await enTransaccion(async (ejecutar) => {
    const existe = await ejecutar(
      "SELECT idVisoria FROM Procad.tblVisorias WHERE idVisoria = @id",
      { id: [sql.Int, idVisoria] },
    );
    if (!existe[0]) throw noEncontrado(`No existe la visoria ${idVisoria}.`);

    for (const idSolicitud of solicitudes) {
      const parametros: Record<string, Parametro> = { visoria: [sql.Int, idVisoria], solicitud: [sql.Int, idSolicitud] };
      const solicitud = await ejecutar(
        "SELECT idSolicitud FROM Procad.tblSolicitudes WITH (UPDLOCK) WHERE idSolicitud = @solicitud",
        { ...parametros },
      );
      if (!solicitud[0]) throw noEncontrado(`No existe la solicitud ${idSolicitud}.`);

      await ejecutar(`
        UPDATE Procad.tblSolicitudes
           SET idVisoriaAsignada = @visoria, fechaActualizacion = SYSDATETIME()
         WHERE idSolicitud = @solicitud
      `, { ...parametros });
    }
  });
  return obtenerVisoria(idVisoria);
}
