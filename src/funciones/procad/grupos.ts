/**
 * Agrupaciones y lo que se configura sobre ellas: disciplinas, tipos de
 * actividad permitidos, integrantes (incluidas las selecciones multi-campus),
 * configuracion de elegibilidad por periodo, accesos al panel y PROSENE.
 *
 * Reglas que pone la base y no se repiten aqui:
 * - tgrGruposDeporteObligatorio: un grupo deportivo indica su deporte.
 * - tgrGruposDisciplinasCoherente: disciplinas solo en grupos artisticos.
 * - tgrGruposTiposActividadesCoherente: el tipo de actividad es del mismo tipo que el grupo.
 * - tgrConfiguracionesGruposPeriodosCoherente: cada tipo de grupo configura su propia regla.
 * - tgrAccesosValidar / tgrAccesosColaboradorInternoRequierePerfil: quien puede tener acceso.
 */
import { consultar, consultarUna, enTransaccion, sql, type Parametro } from "../../compartido/db";
import { noEncontrado } from "../../compartido/errores";
import { Filtros, usuarioParam, type Ejecutor } from "./entrada";

export const CATEGORIAS_SEXO = ["masculino", "femenino", "mixto"] as const;
export const TIPOS_GRUPO = ["deportivo", "artistico"] as const;

/** Las subconsultas FOR JSON llegan como texto; se devuelven como listas. */
function conListas<T extends Record<string, unknown>>(fila: T, columnas: string[]): T {
  const copia: Record<string, unknown> = { ...fila };
  for (const columna of columnas) {
    const valor = copia[columna];
    copia[columna] = typeof valor === "string" && valor !== "" ? JSON.parse(valor) : [];
  }
  return copia as T;
}

const LISTAS_GRUPO = ["disciplinas", "tiposActividad"];

const COLUMNAS_GRUPO = `
  g.idGrupo, g.nombreGrupo, g.idTipoGrupo, tg.nombreTipoGrupo AS tipoGrupo,
  g.idDeporte, d.nombreDeporte, g.categoriaSexo, g.idCampus, c.nombreCampus,
  g.esSeleccion, g.estadoGrupo AS activo, g.fechaRegistro,
  (SELECT gd.idDisciplina, da.nombreDisciplina
     FROM Procad.tblGruposDisciplinas gd
    INNER JOIN Procad.tblDisciplinasArtisticas da ON da.idDisciplina = gd.idDisciplina
    WHERE gd.idGrupo = g.idGrupo
    ORDER BY da.nombreDisciplina
      FOR JSON PATH) AS disciplinas,
  (SELECT gt.idTipoActividad, ta.nombreTipoActividad
     FROM Procad.tblGruposTiposActividades gt
    INNER JOIN Procad.tblTiposActividades ta ON ta.idTipoActividad = gt.idTipoActividad
    WHERE gt.idGrupo = g.idGrupo
    ORDER BY ta.nombreTipoActividad
      FOR JSON PATH) AS tiposActividad`;

const DESDE_GRUPO = `
  FROM Procad.tblGrupos g
 INNER JOIN Procad.tblTiposGrupo tg ON tg.idTipoGrupo = g.idTipoGrupo
 INNER JOIN Catalogo.tblCampus c    ON c.idCampus = g.idCampus
  LEFT JOIN Procad.tblDeportes d    ON d.idDeporte = g.idDeporte`;

/* --------------------------------- Grupos -------------------------------- */

export interface FiltrosGrupos {
  campus: number | null;
  tipoGrupo: string | null;
  esSeleccion: boolean | null;
  incluirInactivos: boolean;
  /** Si viene, `integrantes` cuenta los APROBADO de ese periodo; si no, de todos. */
  periodo: number | null;
}

export async function listarGrupos(f: FiltrosGrupos) {
  const filtros = new Filtros()
    .si(f.campus, "campus", sql.Int, "g.idCampus = @campus")
    .si(f.tipoGrupo, "tipoGrupo", sql.NVarChar(20), "tg.nombreTipoGrupo = @tipoGrupo")
    .si(f.esSeleccion, "esSeleccion", sql.Bit, "g.esSeleccion = @esSeleccion");
  if (!f.incluirInactivos) filtros.siempre("g.estadoGrupo = 1");
  filtros.parametros["periodo"] = [sql.Int, f.periodo];

  const filas = await consultar(`
    SELECT ${COLUMNAS_GRUPO},
           (SELECT COUNT(*)
              FROM Procad.tblSolicitudes s
             INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
             WHERE s.idGrupo = g.idGrupo
               AND e.contextoEstado = N'PROCAD_SOLICITUD' AND e.codigoEstado = N'APROBADO'
               AND (@periodo IS NULL OR s.idPeriodo = @periodo)) AS integrantes
    ${DESDE_GRUPO}
    ${filtros.where}
     ORDER BY c.nombreCampus, g.nombreGrupo
  `, filtros.parametros);
  return filas.map((fila) => conListas(fila, LISTAS_GRUPO));
}

export async function obtenerGrupo(idGrupo: number) {
  const parametros: Record<string, Parametro> = { id: [sql.Int, idGrupo] };
  const grupo = await consultarUna(`
    SELECT ${COLUMNAS_GRUPO}
    ${DESDE_GRUPO}
     WHERE g.idGrupo = @id
  `, { ...parametros });
  if (!grupo) throw noEncontrado(`No existe el grupo ${idGrupo}.`);

  const [accesos, configuraciones] = await Promise.all([
    consultar(`
      SELECT a.idAcceso, a.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona,
             a.esColaboradorExterno, a.estadoAcceso AS activo
        FROM Procad.tblAccesos a
       INNER JOIN Catalogo.tblPersonas p ON p.idPersona = a.idPersona
       WHERE a.idGrupo = @id
       ORDER BY a.estadoAcceso DESC, p.apellidosPersona
    `, { ...parametros }),
    consultar(`
      SELECT cfg.idConfiguracion, cfg.idPeriodo, pe.anioPeriodo, pe.numeroPac,
             cfg.minimoActividades, cfg.minimoActividadesPorMes, cfg.porcentajeMinimoEntrenamientos
        FROM Procad.tblConfiguracionesGruposPeriodos cfg
       INNER JOIN Catalogo.tblPeriodos pe ON pe.idPeriodo = cfg.idPeriodo
       WHERE cfg.idGrupo = @id
       ORDER BY pe.anioPeriodo DESC, pe.numeroPac DESC
    `, { ...parametros }),
  ]);

  return { ...conListas(grupo, LISTAS_GRUPO), directores: accesos, configuraciones };
}

export interface DatosGrupo {
  nombreGrupo?: string;
  idTipoGrupo?: number;
  idDeporte?: number | null;
  categoriaSexo?: string;
  idCampus?: number;
  esSeleccion?: boolean;
  activo?: boolean;
  /** Si viene, reemplaza por completo las disciplinas del grupo. */
  disciplinas?: number[];
  /** Si viene, reemplaza por completo los tipos de actividad habilitados (RF-48). */
  tiposActividad?: number[];
}

const COLUMNA_DE: Record<string, [columna: string, tipo: Parametro[0]]> = {
  nombreGrupo: ["nombreGrupo", sql.NVarChar(150)],
  idTipoGrupo: ["idTipoGrupo", sql.TinyInt],
  idDeporte: ["idDeporte", sql.Int],
  categoriaSexo: ["categoriaSexo", sql.NVarChar(20)],
  idCampus: ["idCampus", sql.Int],
  esSeleccion: ["esSeleccion", sql.Bit],
  activo: ["estadoGrupo", sql.Bit],
};

function columnasDe(datos: DatosGrupo) {
  const columnas: string[] = [];
  const parametros: Record<string, Parametro> = {};
  for (const [campo, [columna, tipo]] of Object.entries(COLUMNA_DE)) {
    const valor = datos[campo as keyof DatosGrupo];
    if (valor === undefined) continue;
    columnas.push(columna);
    parametros[columna] = [tipo, valor];
  }
  return { columnas, parametros };
}

/** Reemplaza una tabla puente del grupo: borra lo que habia y escribe la lista nueva. */
async function reemplazarPuente(
  ejecutar: Ejecutor,
  tabla: string,
  columna: string,
  idGrupo: number,
  ids: number[],
  usuario: string,
) {
  await ejecutar(`DELETE FROM ${tabla} WHERE idGrupo = @idGrupo`, { idGrupo: [sql.Int, idGrupo] });
  for (const id of ids) {
    await ejecutar(`
      INSERT INTO ${tabla} (idGrupo, ${columna}, usuarioRegistro) VALUES (@idGrupo, @id, @usuario)
    `, { idGrupo: [sql.Int, idGrupo], id: [sql.Int, id], usuario: usuarioParam(usuario) });
  }
}

async function escribirPuentes(ejecutar: Ejecutor, idGrupo: number, datos: DatosGrupo, usuario: string) {
  if (datos.disciplinas !== undefined) {
    await reemplazarPuente(ejecutar, "Procad.tblGruposDisciplinas", "idDisciplina", idGrupo, datos.disciplinas, usuario);
  }
  if (datos.tiposActividad !== undefined) {
    await reemplazarPuente(
      ejecutar, "Procad.tblGruposTiposActividades", "idTipoActividad", idGrupo, datos.tiposActividad, usuario,
    );
  }
}

export async function crearGrupo(datos: DatosGrupo, usuario: string) {
  const { columnas, parametros } = columnasDe(datos);
  const idGrupo = await enTransaccion(async (ejecutar) => {
    const filas = await ejecutar<{ id: number }>(`
      INSERT INTO Procad.tblGrupos (${[...columnas, "usuarioRegistro"].join(", ")})
      VALUES (${[...columnas.map((c) => `@${c}`), "@usuario"].join(", ")});
      SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
    `, { ...parametros, usuario: usuarioParam(usuario) });
    const id = filas[0]!.id;
    await escribirPuentes(ejecutar, id, datos, usuario);
    return id;
  });
  return obtenerGrupo(idGrupo);
}

export async function actualizarGrupo(idGrupo: number, datos: DatosGrupo, usuario: string) {
  const { columnas, parametros } = columnasDe(datos);
  await enTransaccion(async (ejecutar) => {
    const existe = await ejecutar(
      "SELECT idGrupo FROM Procad.tblGrupos WITH (UPDLOCK) WHERE idGrupo = @id",
      { id: [sql.Int, idGrupo] },
    );
    if (!existe[0]) throw noEncontrado(`No existe el grupo ${idGrupo}.`);

    if (columnas.length > 0) {
      await ejecutar(`
        UPDATE Procad.tblGrupos
           SET ${columnas.map((c) => `${c} = @${c}`).join(", ")}
         WHERE idGrupo = @id
      `, { ...parametros, id: [sql.Int, idGrupo] });
    }
    await escribirPuentes(ejecutar, idGrupo, datos, usuario);
  });
  return obtenerGrupo(idGrupo);
}

/* ------------------------------- Integrantes ------------------------------ */

/**
 * Integrantes APROBADO del grupo. Si el grupo es una seleccion, sus
 * integrantes no tienen solicitud propia en el: son las solicitudes de sus
 * grupos de origen, ligadas por tblSeleccionIntegrantes, y pueden venir de
 * varios campus.
 */
export async function listarIntegrantes(idGrupo: number, periodo: number | null) {
  const grupo = await consultarUna<{ idGrupo: number; nombreGrupo: string; esSeleccion: boolean }>(
    "SELECT idGrupo, nombreGrupo, esSeleccion FROM Procad.tblGrupos WHERE idGrupo = @id",
    { id: [sql.Int, idGrupo] },
  );
  if (!grupo) throw noEncontrado(`No existe el grupo ${idGrupo}.`);

  const parametros: Record<string, Parametro> = { id: [sql.Int, idGrupo], periodo: [sql.Int, periodo] };
  const columnas = `
    s.idSolicitud, s.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona, p.telefonoPersona,
    de.numeroCuenta, s.idPeriodo, s.esEquipo, s.fechaInscripcion,
    s.idGrupo AS idGrupoOrigen, gor.nombreGrupo AS nombreGrupoOrigen, gor.idCampus, c.nombreCampus`;
  const desde = `
    INNER JOIN Procad.tblGrupos gor    ON gor.idGrupo = s.idGrupo
    INNER JOIN Catalogo.tblCampus c    ON c.idCampus = gor.idCampus
    INNER JOIN Catalogo.tblPersonas p  ON p.idPersona = s.idPersona
     LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = s.idPersona`;

  const integrantes = grupo.esSeleccion
    ? await consultar(`
        SELECT ${columnas}
          FROM Procad.tblSeleccionIntegrantes si
         INNER JOIN Procad.tblSolicitudes s ON s.idSolicitud = si.idSolicitud
        ${desde}
         WHERE si.idGrupoSeleccion = @id
           AND (@periodo IS NULL OR s.idPeriodo = @periodo)
         ORDER BY c.nombreCampus, p.apellidosPersona
      `, parametros)
    : await consultar(`
        SELECT ${columnas},
               (SELECT si.idGrupoSeleccion, gs.nombreGrupo AS nombreSeleccion
                  FROM Procad.tblSeleccionIntegrantes si
                 INNER JOIN Procad.tblGrupos gs ON gs.idGrupo = si.idGrupoSeleccion
                 WHERE si.idSolicitud = s.idSolicitud
                   FOR JSON PATH) AS selecciones
          FROM Procad.tblSolicitudes s
         INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
        ${desde}
         WHERE s.idGrupo = @id
           AND e.contextoEstado = N'PROCAD_SOLICITUD' AND e.codigoEstado = N'APROBADO'
           AND (@periodo IS NULL OR s.idPeriodo = @periodo)
         ORDER BY p.apellidosPersona, p.nombrePersona
      `, parametros).then((filas) => filas.map((fila) => conListas(fila, ["selecciones"])));

  return { ...grupo, integrantes };
}

/* ------------------------ Configuracion por periodo ----------------------- */

export function listarConfiguraciones(f: { periodo: number | null; grupo: number | null; campus: number | null }) {
  const filtros = new Filtros()
    .si(f.periodo, "periodo", sql.Int, "cfg.idPeriodo = @periodo")
    .si(f.grupo, "grupo", sql.Int, "cfg.idGrupo = @grupo")
    .si(f.campus, "campus", sql.Int, "g.idCampus = @campus");
  return consultar(`
    SELECT cfg.idConfiguracion, cfg.idGrupo, g.nombreGrupo, tg.nombreTipoGrupo AS tipoGrupo,
           g.idCampus, cfg.idPeriodo, pe.anioPeriodo, pe.numeroPac,
           cfg.minimoActividades, cfg.minimoActividadesPorMes, cfg.porcentajeMinimoEntrenamientos,
           cfg.fechaRegistro
      FROM Procad.tblConfiguracionesGruposPeriodos cfg
     INNER JOIN Procad.tblGrupos g      ON g.idGrupo = cfg.idGrupo
     INNER JOIN Procad.tblTiposGrupo tg ON tg.idTipoGrupo = g.idTipoGrupo
     INNER JOIN Catalogo.tblPeriodos pe ON pe.idPeriodo = cfg.idPeriodo
    ${filtros.where}
     ORDER BY pe.anioPeriodo DESC, pe.numeroPac DESC, g.nombreGrupo
  `, filtros.parametros);
}

export interface Configuracion {
  idGrupo: number;
  idPeriodo: number;
  minimoActividades: number | null;
  minimoActividadesPorMes: number | null;
  porcentajeMinimoEntrenamientos: number | null;
}

/**
 * Crea o reemplaza la configuracion del grupo en el periodo (RF-25: se puede
 * ajustar en cualquier momento del periodo). Que regla aplica a cada tipo de
 * grupo lo exige tgrConfiguracionesGruposPeriodosCoherente.
 */
export async function guardarConfiguracion(cfg: Configuracion, usuario: string) {
  const parametros: Record<string, Parametro> = {
    grupo: [sql.Int, cfg.idGrupo],
    periodo: [sql.Int, cfg.idPeriodo],
    minimo: [sql.Int, cfg.minimoActividades],
    minimoMes: [sql.Int, cfg.minimoActividadesPorMes],
    porcentaje: [sql.TinyInt, cfg.porcentajeMinimoEntrenamientos],
    usuario: usuarioParam(usuario),
  };

  await enTransaccion(async (ejecutar) => {
    const existente = await ejecutar(`
      SELECT idConfiguracion FROM Procad.tblConfiguracionesGruposPeriodos WITH (UPDLOCK, HOLDLOCK)
       WHERE idGrupo = @grupo AND idPeriodo = @periodo
    `, parametros);

    await ejecutar(existente[0]
      ? `UPDATE Procad.tblConfiguracionesGruposPeriodos
            SET minimoActividades = @minimo, minimoActividadesPorMes = @minimoMes,
                porcentajeMinimoEntrenamientos = @porcentaje
          WHERE idGrupo = @grupo AND idPeriodo = @periodo`
      : `INSERT INTO Procad.tblConfiguracionesGruposPeriodos
           (idGrupo, idPeriodo, minimoActividades, minimoActividadesPorMes,
            porcentajeMinimoEntrenamientos, usuarioRegistro)
         VALUES (@grupo, @periodo, @minimo, @minimoMes, @porcentaje, @usuario)`,
      parametros);
  });

  const [guardada] = await listarConfiguraciones({ periodo: cfg.idPeriodo, grupo: cfg.idGrupo, campus: null });
  return guardada;
}

/* ------------------------------ Accesos y PROSENE ------------------------- */

/** Quien tiene acceso al panel de cada grupo. Un colaborador externo figura, pero nunca entra: actua el admin. */
export function listarAccesos(f: {
  grupo: number | null;
  campus: number | null;
  persona: number | null;
  incluirInactivos: boolean;
}) {
  const filtros = new Filtros()
    .si(f.grupo, "grupo", sql.Int, "a.idGrupo = @grupo")
    .si(f.campus, "campus", sql.Int, "a.idCampus = @campus")
    .si(f.persona, "persona", sql.Int, "a.idPersona = @persona");
  if (!f.incluirInactivos) filtros.siempre("a.estadoAcceso = 1");
  return consultar(`
    SELECT a.idAcceso, a.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona,
           a.idGrupo, g.nombreGrupo, tg.nombreTipoGrupo AS tipoGrupo,
           a.idCampus, c.nombreCampus, a.esColaboradorExterno, a.estadoAcceso AS activo, a.fechaRegistro
      FROM Procad.tblAccesos a
     INNER JOIN Catalogo.tblPersonas p  ON p.idPersona = a.idPersona
     INNER JOIN Procad.tblGrupos g      ON g.idGrupo = a.idGrupo
     INNER JOIN Procad.tblTiposGrupo tg ON tg.idTipoGrupo = g.idTipoGrupo
     INNER JOIN Catalogo.tblCampus c    ON c.idCampus = a.idCampus
    ${filtros.where}
     ORDER BY c.nombreCampus, g.nombreGrupo, p.apellidosPersona
  `, filtros.parametros);
}

/** Beneficiarios PROSENE: elegibles automaticos segun Procad.vwElegibilidad. */
export function listarProsene(incluirInactivos: boolean) {
  return consultar(`
    SELECT b.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona, p.idCampus,
           c.nombreCampus, de.numeroCuenta, de.carreraEstudiante,
           b.estadoBeneficio AS activo, b.observacionBeneficio, b.fechaRegistro
      FROM Procad.tblBeneficiariosProsene b
     INNER JOIN Catalogo.tblPersonas p  ON p.idPersona = b.idPersona
     INNER JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = b.idPersona
      LEFT JOIN Catalogo.tblCampus c    ON c.idCampus = p.idCampus
    ${incluirInactivos ? "" : "WHERE b.estadoBeneficio = 1"}
     ORDER BY p.apellidosPersona, p.nombrePersona
  `);
}
