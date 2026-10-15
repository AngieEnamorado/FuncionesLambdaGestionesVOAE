/**
 * Visorias (pruebas de ingreso): calendario del periodo y estudiantes citados.
 *
 * Reglas que pone la base y no se repiten aqui:
 * - tgrVisoriasNoTraslape: no dos visorias en el mismo lugar, fecha y hora (RF-51).
 * - tgrVisoriasLugarMismoCampus: el lugar es del mismo campus que la visoria.
 *
 * El esquema no tiene estado de visoria (BORRADOR/PROGRAMADA) ni cupo: una
 * visoria existe en cuanto se crea, y citar a un estudiante es asignarle la
 * visoria en su solicitud (tblSolicitudes.idVisoriaAsignada).
 */
import { consultar, consultarUna, enTransaccion, sql, type Parametro } from "../../compartido/db";
import { noEncontrado } from "../../compartido/errores";
import { Filtros, usuarioParam } from "./entrada";

const COLUMNAS_VISORIA = `
  v.idVisoria, v.idPeriodo, v.idCampus, c.nombreCampus, v.fechaVisoria,
  CONVERT(VARCHAR(5), v.horaVisoria, 108) AS horaVisoria,
  v.idLugarVisoria, lv.nombreLugar, v.idAula, au.nombreAula, v.usuarioRegistro, v.fechaRegistro,
  (SELECT COUNT(*) FROM Procad.tblSolicitudes s WHERE s.idVisoriaAsignada = v.idVisoria) AS citados`;

const DESDE_VISORIA = `
  FROM Procad.tblVisorias v
 INNER JOIN Catalogo.tblCampus c ON c.idCampus = v.idCampus
  LEFT JOIN Procad.tblLugaresVisoria lv ON lv.idLugarVisoria = v.idLugarVisoria
  LEFT JOIN Procad.tblAulas au ON au.idAula = v.idAula`;

export function listarVisorias(f: { periodo: number | null; campus: number | null; desde: string | null; hasta: string | null }) {
  const filtros = new Filtros()
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

  const citados = await consultar(`
    SELECT s.idSolicitud, s.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona, de.numeroCuenta,
           s.idGrupo, g.nombreGrupo, e.codigoEstado
      FROM Procad.tblSolicitudes s
     INNER JOIN Catalogo.tblPersonas p ON p.idPersona = s.idPersona
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = s.idPersona
     INNER JOIN Procad.tblGrupos g     ON g.idGrupo = s.idGrupo
     INNER JOIN Catalogo.tblEstados e  ON e.idEstado = s.idEstado
     WHERE s.idVisoriaAsignada = @id
     ORDER BY g.nombreGrupo, p.apellidosPersona
  `, { id: [sql.Int, idVisoria] });

  return { ...visoria, estudiantes: citados };
}

export interface NuevaVisoria {
  idPeriodo: number;
  idCampus: number;
  fechaVisoria: string;
  horaVisoria: string | null;
  idLugarVisoria: number | null;
  idAula: number | null;
}

export async function crearVisoria(n: NuevaVisoria, usuario: string) {
  const filas = await consultar<{ id: number }>(`
    INSERT INTO Procad.tblVisorias
      (idPeriodo, idCampus, fechaVisoria, horaVisoria, idLugarVisoria, idAula, usuarioRegistro)
    VALUES (@periodo, @campus, @fecha, @hora, @lugar, @aula, @usuario);
    SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
  `, {
    periodo: [sql.Int, n.idPeriodo],
    campus: [sql.Int, n.idCampus],
    fecha: [sql.Date, n.fechaVisoria],
    hora: [sql.VarChar(8), n.horaVisoria],
    lugar: [sql.Int, n.idLugarVisoria],
    aula: [sql.Int, n.idAula],
    usuario: usuarioParam(usuario),
  });
  return obtenerVisoria(filas[0]!.id);
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
