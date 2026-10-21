/**
 * Listas preferenciales: los elegibles de un grupo en un periodo, que se
 * envian a Registro para la matricula preferencial del periodo siguiente.
 *
 * Quien es elegible NO se calcula aqui: lo decide la vista Procad.vwElegibilidad
 * (asistencias validadas contra la regla del grupo, o PROSENE). La lista solo
 * toma una foto de esa vista.
 *
 * Reglas que pone la base y no se repiten aqui:
 * - tgrListasPreferencialesMismoCampus: el campus de la lista es el del grupo.
 * - tgrListasPreferencialesPeriodoAplicacion: el periodo de aplicacion es posterior al evaluado (RF-44).
 * - tgrListasPreferencialesNoModificarEnviada / tgrDetallesListasNoModificarEnviada:
 *   una lista ENVIADA ya no cambia.
 * - ukListaPreferencial_GrupoPeriodoEvaluado: una lista por grupo y periodo evaluado.
 * - Procad.spGenerarListaPreferencial (v2): deja fuera, y les quita el rol
 *   INTEGRANTE, a los elegibles que ya no estan matriculados en Registro.
 */
import { consultar, consultarUna, ejecutarProcedimiento, enTransaccion, sql } from "../../compartido/db";
import { conflicto, noEncontrado } from "../../compartido/errores";
import { CONTEXTO, Filtros, idEstado, usuarioParam } from "./entrada";
import { conDatosDeRegistro, ordenarPorNombre } from "./registro";

export const ESTADOS_LISTA = ["GENERADA", "ENVIADA"] as const;

const COLUMNAS_LISTA = `
  l.idLista, l.idGrupo, g.nombreGrupo, tg.nombreTipoGrupo AS tipoGrupo, l.idCampus, c.nombreCampus,
  l.idPeriodoEvaluado, pe.anioPeriodo AS anioEvaluado, pe.numeroPac AS pacEvaluado,
  l.idPeriodoAplicacion, pa.anioPeriodo AS anioAplicacion, pa.numeroPac AS pacAplicacion,
  e.codigoEstado, e.nombreEstado, l.cantidadElegibles, l.fechaGeneracion, l.fechaEnvio, l.usuarioRegistro`;

const DESDE_LISTA = `
  FROM Procad.tblListasPreferenciales l
 INNER JOIN Procad.tblGrupos g      ON g.idGrupo = l.idGrupo
 INNER JOIN Procad.tblTiposGrupo tg ON tg.idTipoGrupo = g.idTipoGrupo
 INNER JOIN Catalogo.tblCampus c    ON c.idCampus = l.idCampus
 INNER JOIN Catalogo.tblPeriodos pe ON pe.idPeriodo = l.idPeriodoEvaluado
 INNER JOIN Catalogo.tblPeriodos pa ON pa.idPeriodo = l.idPeriodoAplicacion
 INNER JOIN Catalogo.tblEstados e   ON e.idEstado = l.idEstado`;

export function listarListas(f: { grupo: number | null; campus: number | null; periodo: number | null; estado: string | null }) {
  const filtros = new Filtros()
    .si(f.grupo, "grupo", sql.Int, "l.idGrupo = @grupo")
    .si(f.campus, "campus", sql.Int, "l.idCampus = @campus")
    .si(f.periodo, "periodo", sql.Int, "l.idPeriodoEvaluado = @periodo")
    .si(f.estado, "estado", sql.NVarChar(40), "e.codigoEstado = @estado");
  return consultar(`
    SELECT ${COLUMNAS_LISTA}
    ${DESDE_LISTA}
    ${filtros.where}
     ORDER BY l.fechaGeneracion DESC
  `, filtros.parametros);
}

export async function obtenerLista(idLista: number) {
  const lista = await consultarUna(`
    SELECT ${COLUMNAS_LISTA}
    ${DESDE_LISTA}
     WHERE l.idLista = @id
  `, { id: [sql.Int, idLista] });
  if (!lista) throw noEncontrado(`No existe la lista preferencial ${idLista}.`);

  const filas = await consultar(`
    SELECT d.idListaDetalle, d.idSolicitud, s.idPersona,
           de.numeroCuenta, d.actividadesAsistidas
      FROM Procad.tblDetallesListasPreferenciales d
     INNER JOIN Procad.tblSolicitudes s ON s.idSolicitud = d.idSolicitud
      LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = s.idPersona
     WHERE d.idLista = @id
  `, { id: [sql.Int, idLista] });
  const detalles = ordenarPorNombre(await conDatosDeRegistro(filas, (r) => ({ carreraEstudiante: r.carrera })));

  return { ...lista, detalles };
}

/**
 * Genera la lista del grupo para el periodo evaluado con los elegibles de
 * Procad.vwElegibilidad en este momento, por Procad.spGenerarListaPreferencial.
 * El SP consulta Registro, asi que va sin transaccion propia. Su id sale por
 * OUTPUT; como solo hay una lista por grupo y periodo evaluado, se busca por
 * esa llave en vez de leer el parametro de salida.
 */
export async function generarLista(
  g: { idGrupo: number; idPeriodoEvaluado: number; idPeriodoAplicacion: number },
  usuario: string,
) {
  const grupo = await consultarUna(
    "SELECT idGrupo FROM Procad.tblGrupos WHERE idGrupo = @grupo",
    { grupo: [sql.Int, g.idGrupo] },
  );
  if (!grupo) throw noEncontrado(`No existe el grupo ${g.idGrupo}.`);

  await ejecutarProcedimiento("Procad.spGenerarListaPreferencial", {
    idGrupo: [sql.Int, g.idGrupo],
    idPeriodoEvaluado: [sql.Int, g.idPeriodoEvaluado],
    idPeriodoAplicacion: [sql.Int, g.idPeriodoAplicacion],
    usuarioRegistro: usuarioParam(usuario),
    idLista: [sql.Int, null],
  });

  const creada = await consultarUna<{ idLista: number }>(
    "SELECT idLista FROM Procad.tblListasPreferenciales WHERE idGrupo = @grupo AND idPeriodoEvaluado = @evaluado",
    { grupo: [sql.Int, g.idGrupo], evaluado: [sql.Int, g.idPeriodoEvaluado] },
  );
  if (!creada) throw noEncontrado(`No se genero la lista del grupo ${g.idGrupo}.`);
  return obtenerLista(creada.idLista);
}

/** Marca la lista como enviada a Registro. Desde ahi los triggers la congelan. */
export async function enviarLista(idLista: number) {
  await enTransaccion(async (ejecutar) => {
    const actual = await ejecutar<{ codigoEstado: string }>(`
      SELECT e.codigoEstado
        FROM Procad.tblListasPreferenciales l WITH (UPDLOCK)
       INNER JOIN Catalogo.tblEstados e ON e.idEstado = l.idEstado
       WHERE l.idLista = @id
    `, { id: [sql.Int, idLista] });
    if (!actual[0]) throw noEncontrado(`No existe la lista preferencial ${idLista}.`);
    if (actual[0].codigoEstado !== "GENERADA") {
      throw conflicto(`La lista preferencial ${idLista} ya fue enviada.`);
    }

    await ejecutar(`
      UPDATE Procad.tblListasPreferenciales
         SET idEstado = ${idEstado(CONTEXTO.lista, "enviada")}, fechaEnvio = SYSDATETIME()
       WHERE idLista = @id
    `, { id: [sql.Int, idLista], enviada: [sql.NVarChar(40), "ENVIADA"] });
  });
  return obtenerLista(idLista);
}
