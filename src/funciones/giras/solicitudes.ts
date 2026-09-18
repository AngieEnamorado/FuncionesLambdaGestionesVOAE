/**
 * Solicitudes de gira: lectura, alta, edicion, envio, dictamen y baja.
 *
 * Una solicitud es la cabecera (Giras.tblSolicitudes) mas cinco listas N:M
 * (finalidades, facultades, categorias, financiamientos, transportes), el
 * detalle de costos, los docentes acompanantes y los documentos. Se escribe
 * todo en una transaccion: una solicitud a medio insertar dejaria hijos sin
 * cabecera.
 *
 * Lo que los triggers ya hacen y aqui NO se repite:
 *  - tblSolicitudes.costos lo mantiene tgrCostosDetalleActualizar: se escribe
 *    el detalle y jamas el total.
 *  - El maximo de docentes (parametro maxDocentesPorGira) lo exigen
 *    tgrSolicitudesMaxDocentes y tgrDocentesAcompanantesMaximo.
 *  - La coherencia de idTipoCancelacion con aplicaA la valida
 *    tgrSolicitudDictamenesTipoCancelacionAplicaA.
 *  - La bitacora (tblSolicitudesLog) la llena tgrSolicitudesLlenarLog.
 *
 * Lo que NINGUN trigger hace y por eso vive aqui (a diferencia de lo que
 * supone ARQUITECTURA.md): un dictamen no cambia el estado de la solicitud ni
 * crea la fila de tblGiras. dictaminarSolicitud lo hace, en la misma
 * transaccion que inserta el dictamen.
 */
import { consultar, consultarUna, enTransaccion, sql, type Parametro } from "../../compartido/db";
import { conflicto, noEncontrado, solicitudInvalida } from "../../compartido/errores";
import {
  booleanoOpcional,
  enteroOpcional,
  enteroRequerido,
  textoOpcional,
  textoRequerido,
} from "../../compartido/validacion";
import {
  enteroNoNegativo,
  fechaOpcional,
  horaOpcional,
  leerDocumento,
  listaDeIds,
  listaDeObjetos,
  montoRequerido,
  type DocumentoEntrada,
  type Ejecutor,
} from "./entrada";
import {
  CONTEXTO,
  fechaIso,
  horaCorta,
  idEstado,
  nombreDeUsuario,
  paramFecha,
  paramHora,
  periodoDe,
} from "./consultas";

/** Estados en los que el solicitante todavia puede tocar la solicitud. */
const ESTADOS_EDITABLES = ["Borrador", "Correccion"];

/* ---------------------------- Lectura de entrada ------------------------- */

type TipoCabecera = "int" | "tinyint" | "conteo" | "texto" | "fecha" | "hora" | "bit";

interface CampoCabecera {
  nombre: string;
  tipo: TipoCabecera;
  largo?: number;
  /** Ni siquiera un borrador se guarda sin esto: la columna es NOT NULL y sin default. */
  obligatorioAlta?: boolean;
}

const CABECERA: CampoCabecera[] = [
  { nombre: "idJefeMision", tipo: "int", obligatorioAlta: true },
  { nombre: "idJefeAprobacion", tipo: "int", obligatorioAlta: true },
  { nombre: "idCampus", tipo: "int", obligatorioAlta: true },
  { nombre: "idTipoAlcance", tipo: "tinyint" },
  { nombre: "objetivoAcademico", tipo: "texto", largo: 1000 },
  { nombre: "destinoGira", tipo: "texto", largo: 150 },
  { nombre: "fechaSalidaPropuesta", tipo: "fecha" },
  { nombre: "horaSalidaPropuesta", tipo: "hora" },
  { nombre: "fechaRetornoPropuesta", tipo: "fecha" },
  { nombre: "horaRetornoPropuesta", tipo: "hora" },
  { nombre: "fechaInicioInscripcion", tipo: "fecha" },
  { nombre: "fechaFinInscripcion", tipo: "fecha" },
  { nombre: "usaTransporteUniversidad", tipo: "bit" },
  { nombre: "alojamientoGira", tipo: "texto", largo: 150 },
  { nombre: "totalAproximadoEstudiantes", tipo: "conteo" },
  { nombre: "totalAproximadoDocentes", tipo: "conteo" },
];

function leerCampoCabecera(campo: CampoCabecera, valor: unknown, esAlta: boolean): Parametro {
  const { nombre } = campo;
  switch (campo.tipo) {
    case "int":
      return [sql.Int, campo.obligatorioAlta && esAlta ? enteroRequerido(valor, nombre) : enteroOpcional(valor, nombre)];
    case "tinyint": {
      const id = enteroOpcional(valor, nombre);
      if (id !== null && id > 255) throw solicitudInvalida(`El parametro ${nombre} esta fuera de rango.`);
      return [sql.TinyInt, id];
    }
    case "conteo":
      return [sql.Int, enteroNoNegativo(valor, nombre)];
    case "texto":
      return [sql.NVarChar(campo.largo ?? 150), textoOpcional(valor, nombre, campo.largo ?? 150)];
    case "fecha":
      return paramFecha(fechaOpcional(valor, nombre));
    case "hora":
      return paramHora(horaOpcional(valor, nombre));
    case "bit":
      return [sql.Bit, booleanoOpcional(valor, nombre) ?? false];
  }
}

export interface CambiosSolicitud {
  /** Columna → parametro, solo de las claves que llegaron en el cuerpo. */
  cabecera: Record<string, Parametro>;
  /** Una lista ausente significa "no tocar"; una lista vacia, "dejar sin ninguno". */
  finalidades?: number[];
  facultades?: number[];
  categorias?: number[];
  financiamientos?: number[];
  transportes?: { idTipoTransporte: number; observacion: string | null }[];
  costos?: { nombre: string; descripcion: string | null; total: number }[];
  docentes?: number[];
  documentos?: DocumentoEntrada[];
}

/**
 * Los nombres del cuerpo son los de la base (idCampus, destinoGira,
 * fechaSalidaPropuesta...), no los del mock del frontend. `costos[].total` y
 * `docentes[]` (ids de usuario-unidad) tambien: la base pide un docente real,
 * no un nombre en texto libre.
 */
export function leerCuerpoSolicitud(cuerpo: Record<string, unknown>, esAlta: boolean): CambiosSolicitud {
  const cambios: CambiosSolicitud = { cabecera: {} };

  for (const campo of CABECERA) {
    if (campo.nombre in cuerpo || (esAlta && campo.obligatorioAlta)) {
      cambios.cabecera[campo.nombre] = leerCampoCabecera(campo, cuerpo[campo.nombre], esAlta);
    }
  }

  if ("finalidades" in cuerpo) cambios.finalidades = listaDeIds(cuerpo["finalidades"], "finalidades");
  if ("facultades" in cuerpo) cambios.facultades = listaDeIds(cuerpo["facultades"], "facultades");
  if ("categorias" in cuerpo) cambios.categorias = listaDeIds(cuerpo["categorias"], "categorias");
  if ("financiamientos" in cuerpo) cambios.financiamientos = listaDeIds(cuerpo["financiamientos"], "financiamientos");
  if ("docentes" in cuerpo) cambios.docentes = listaDeIds(cuerpo["docentes"], "docentes");

  if ("transportes" in cuerpo) {
    cambios.transportes = listaDeObjetos(cuerpo["transportes"], "transportes", (fila, etiqueta) => ({
      idTipoTransporte: enteroRequerido(fila["idTipoTransporte"], `${etiqueta}.idTipoTransporte`),
      observacion: textoOpcional(fila["observacion"], `${etiqueta}.observacion`, 300),
    }));
  }
  if ("costos" in cuerpo) {
    cambios.costos = listaDeObjetos(cuerpo["costos"], "costos", (fila, etiqueta) => ({
      nombre: textoRequerido(fila["nombre"], `${etiqueta}.nombre`, 120),
      descripcion: textoOpcional(fila["descripcion"], `${etiqueta}.descripcion`, 300),
      total: montoRequerido(fila["total"], `${etiqueta}.total`),
    }));
  }
  if ("documentos" in cuerpo) {
    cambios.documentos = listaDeObjetos(cuerpo["documentos"], "documentos", leerDocumento);
  }

  return cambios;
}

const hayCambios = (c: CambiosSolicitud): boolean =>
  Object.keys(c.cabecera).length > 0 ||
  [c.finalidades, c.facultades, c.categorias, c.financiamientos, c.transportes, c.costos, c.docentes, c.documentos]
    .some((lista) => lista !== undefined);

/* -------------------------------- Lectura -------------------------------- */

const SOLICITUDES_SELECT = `
  SELECT s.idSolicitud, s.idEstado, e.codigoEstado, e.nombreEstado,
         s.idJefeMision, ${nombreDeUsuario("s.idJefeMision")} AS nombreJefeMision,
         s.idJefeAprobacion, ${nombreDeUsuario("s.idJefeAprobacion")} AS nombreJefeAprobacion,
         s.idCampus, c.nombreCampus, s.idTipoAlcance, ta.nombre AS nombreAlcance,
         s.objetivoAcademico, s.destinoGira, s.alojamientoGira,
         ${fechaIso("s.fechaSalidaPropuesta")} AS fechaSalidaPropuesta,
         ${horaCorta("s.horaSalidaPropuesta")} AS horaSalidaPropuesta,
         ${fechaIso("s.fechaRetornoPropuesta")} AS fechaRetornoPropuesta,
         ${horaCorta("s.horaRetornoPropuesta")} AS horaRetornoPropuesta,
         ${fechaIso("s.fechaInicioInscripcion")} AS fechaInicioInscripcion,
         ${fechaIso("s.fechaFinInscripcion")} AS fechaFinInscripcion,
         s.usaTransporteUniversidad, s.totalAproximadoEstudiantes, s.totalAproximadoDocentes,
         s.costos, s.fechaEnvio, s.usuarioRegistro, s.fechaRegistro,
         per.idPeriodo, per.anioPeriodo, per.numeroPac,
         (SELECT STRING_AGG(cat.nombre, N', ')
            FROM Giras.tblSolicitudCategorias sc
           INNER JOIN Giras.tblCategorias cat ON cat.idCategoria = sc.idCategoria
           WHERE sc.idSolicitud = s.idSolicitud) AS categorias,
         (SELECT g.idGira FROM Giras.tblGiras g WHERE g.idSolicitud = s.idSolicitud) AS idGira
    FROM Giras.tblSolicitudes s
   INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
   INNER JOIN Catalogo.tblCampus c ON c.idCampus = s.idCampus
    LEFT JOIN Giras.tblTiposAlcance ta ON ta.idTipoAlcance = s.idTipoAlcance
   ${periodoDe("s.fechaSalidaPropuesta", "per")}`;

export function listarSolicitudes(filtros: {
  codigoEstado: string | null;
  excluirBorradores: boolean;
  idCampus: number | null;
  anio: number | null;
  numeroPac: number | null;
  idJefeMision: number | null;
  idJefeAprobacion: number | null;
  busqueda: string | null;
}) {
  const parametros: Record<string, Parametro> = {};
  let donde = "WHERE 1 = 1";

  if (filtros.codigoEstado) {
    donde += " AND e.codigoEstado = @estado";
    parametros["estado"] = [sql.NVarChar(40), filtros.codigoEstado];
  }
  if (filtros.excluirBorradores) donde += " AND e.codigoEstado <> N'Borrador'";
  if (filtros.idCampus !== null) {
    donde += " AND s.idCampus = @campus";
    parametros["campus"] = [sql.Int, filtros.idCampus];
  }
  if (filtros.anio !== null) {
    donde += " AND per.anioPeriodo = @anio";
    parametros["anio"] = [sql.Int, filtros.anio];
  }
  if (filtros.numeroPac !== null) {
    donde += " AND per.numeroPac = @pac";
    parametros["pac"] = [sql.TinyInt, filtros.numeroPac];
  }
  if (filtros.idJefeMision !== null) {
    donde += " AND s.idJefeMision = @jefeMision";
    parametros["jefeMision"] = [sql.Int, filtros.idJefeMision];
  }
  if (filtros.idJefeAprobacion !== null) {
    donde += " AND s.idJefeAprobacion = @jefeAprobacion";
    parametros["jefeAprobacion"] = [sql.Int, filtros.idJefeAprobacion];
  }
  if (filtros.busqueda) {
    donde += " AND (s.destinoGira LIKE @busqueda OR CAST(s.idSolicitud AS NVARCHAR(12)) = @exacto)";
    parametros["busqueda"] = [sql.NVarChar(150), `%${filtros.busqueda}%`];
    parametros["exacto"] = [sql.NVarChar(12), filtros.busqueda];
  }

  return consultar(`${SOLICITUDES_SELECT} ${donde} ORDER BY s.idSolicitud DESC`, parametros);
}

export async function obtenerSolicitud(idSolicitud: number) {
  const p = { id: [sql.Int, idSolicitud] as Parametro };

  const cabecera = await consultarUna(`${SOLICITUDES_SELECT} WHERE s.idSolicitud = @id`, p);
  if (!cabecera) return null;

  const [finalidades, facultades, categorias, financiamientos, transportes, costos, docentes, documentos, dictamenes] =
    await Promise.all([
      consultar(`
        SELECT x.idTipoFinalidad, t.nombre FROM Giras.tblSolicitudFinalidades x
         INNER JOIN Giras.tblTiposFinalidades t ON t.idTipoFinalidad = x.idTipoFinalidad
         WHERE x.idSolicitud = @id ORDER BY t.nombre`, { id: p.id }),
      consultar(`
        SELECT x.idFacultad, f.nombre FROM Giras.tblSolicitudFacultades x
         INNER JOIN Giras.tblFacultades f ON f.idFacultad = x.idFacultad
         WHERE x.idSolicitud = @id ORDER BY f.nombre`, { id: p.id }),
      consultar(`
        SELECT x.idCategoria, c.nombre, c.idTipoCategoria FROM Giras.tblSolicitudCategorias x
         INNER JOIN Giras.tblCategorias c ON c.idCategoria = x.idCategoria
         WHERE x.idSolicitud = @id ORDER BY c.nombre`, { id: p.id }),
      consultar(`
        SELECT x.idTipoFinanciamiento, t.nombre FROM Giras.tblSolicitudFinanciamientos x
         INNER JOIN Giras.tblTiposFinanciamientos t ON t.idTipoFinanciamiento = x.idTipoFinanciamiento
         WHERE x.idSolicitud = @id ORDER BY t.nombre`, { id: p.id }),
      consultar(`
        SELECT x.idTipoTransporte, t.nombre, x.observacion FROM Giras.tblSolicitudTransportes x
         INNER JOIN Giras.tblTiposTransporte t ON t.idTipoTransporte = x.idTipoTransporte
         WHERE x.idSolicitud = @id ORDER BY t.nombre`, { id: p.id }),
      consultar(`
        SELECT idCostoDetalle, nombre, descripcion, total FROM Giras.tblCostosDetalle
         WHERE idSolicitud = @id ORDER BY idCostoDetalle`, { id: p.id }),
      consultar(`
        SELECT da.idDocenteAcompanante, da.idUsuarioAcompanante,
               ${nombreDeUsuario("da.idUsuarioAcompanante")} AS nombreCompleto
          FROM Giras.tblDocentesAcompanantes da
         WHERE da.idSolicitud = @id ORDER BY da.idDocenteAcompanante`, { id: p.id }),
      consultar(`
        SELECT idSolicitudDocumento, tipoDocumento, nombre, linkDocumento, fechaRegistro
          FROM Giras.tblSolicitudDocumentos WHERE idSolicitud = @id ORDER BY idSolicitudDocumento`, { id: p.id }),
      consultar(`
        SELECT d.idSolicitudDictamen, d.idJefeAprobacion, ${nombreDeUsuario("d.idJefeAprobacion")} AS nombreJefeAprobacion,
               d.idEstado, e.codigoEstado, e.nombreEstado, d.idTipoCancelacion,
               tc.nombre AS nombreTipoCancelacion, d.justificacionDictamen, d.numeroVersion, d.fechaDictamen
          FROM Giras.tblSolicitudDictamenes d
         INNER JOIN Catalogo.tblEstados e ON e.idEstado = d.idEstado
          LEFT JOIN Giras.tblTiposCancelacion tc ON tc.idTipoCancelacion = d.idTipoCancelacion
         WHERE d.idSolicitud = @id ORDER BY d.fechaDictamen DESC, d.idSolicitudDictamen DESC`, { id: p.id }),
    ]);

  return { ...cabecera, finalidades, facultades, categorias, financiamientos, transportes, costos, docentes, documentos, dictamenes };
}

/* -------------------------------- Escritura ------------------------------ */

const usuarioParam = (usuario: string): Parametro => [sql.NVarChar(90), usuario];

/** Lee y BLOQUEA la fila: dos peticiones que cambian el estado a la vez se serializan aqui. */
async function bloquear(ejecutar: Ejecutor, idSolicitud: number) {
  const filas = await ejecutar<{ codigoEstado: string; usaTransporteUniversidad: boolean }>(`
    SELECT e.codigoEstado, s.usaTransporteUniversidad
      FROM Giras.tblSolicitudes s WITH (UPDLOCK)
     INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
     WHERE s.idSolicitud = @id
  `, { id: [sql.Int, idSolicitud] });
  if (!filas[0]) throw noEncontrado(`No existe la solicitud ${idSolicitud}.`);
  return filas[0];
}

function exigirEditable(codigoEstado: string, idSolicitud: number): void {
  if (!ESTADOS_EDITABLES.includes(codigoEstado)) {
    throw conflicto(
      `La solicitud ${idSolicitud} esta en estado ${codigoEstado} y ya no se puede modificar: solo en ${ESTADOS_EDITABLES.join(" o ")}.`,
    );
  }
}

/** Reemplaza el contenido de una tabla hija: borra lo que habia y escribe la lista nueva. */
async function reemplazar<T>(
  ejecutar: Ejecutor,
  tabla: string,
  idSolicitud: number,
  filas: T[],
  insertar: string,
  parametrosDe: (fila: T) => Record<string, Parametro>,
  usuario: string,
): Promise<void> {
  await ejecutar(`DELETE FROM ${tabla} WHERE idSolicitud = @idSolicitud`, { idSolicitud: [sql.Int, idSolicitud] });
  for (const fila of filas) {
    await ejecutar(insertar, {
      ...parametrosDe(fila),
      idSolicitud: [sql.Int, idSolicitud],
      usuario: usuarioParam(usuario),
    });
  }
}

async function escribirHijos(
  ejecutar: Ejecutor,
  idSolicitud: number,
  c: CambiosSolicitud,
  usuario: string,
): Promise<void> {
  if (c.finalidades) {
    await reemplazar(ejecutar, "Giras.tblSolicitudFinalidades", idSolicitud, c.finalidades,
      `INSERT INTO Giras.tblSolicitudFinalidades (idSolicitud, idTipoFinalidad, usuarioRegistro)
       VALUES (@idSolicitud, @id, @usuario)`, (id) => ({ id: [sql.TinyInt, id] }), usuario);
  }
  if (c.facultades) {
    await reemplazar(ejecutar, "Giras.tblSolicitudFacultades", idSolicitud, c.facultades,
      `INSERT INTO Giras.tblSolicitudFacultades (idSolicitud, idFacultad, usuarioRegistro)
       VALUES (@idSolicitud, @id, @usuario)`, (id) => ({ id: [sql.Int, id] }), usuario);
  }
  if (c.categorias) {
    await reemplazar(ejecutar, "Giras.tblSolicitudCategorias", idSolicitud, c.categorias,
      `INSERT INTO Giras.tblSolicitudCategorias (idSolicitud, idCategoria, usuarioRegistro)
       VALUES (@idSolicitud, @id, @usuario)`, (id) => ({ id: [sql.Int, id] }), usuario);
  }
  if (c.financiamientos) {
    await reemplazar(ejecutar, "Giras.tblSolicitudFinanciamientos", idSolicitud, c.financiamientos,
      `INSERT INTO Giras.tblSolicitudFinanciamientos (idSolicitud, idTipoFinanciamiento, usuarioRegistro)
       VALUES (@idSolicitud, @id, @usuario)`, (id) => ({ id: [sql.TinyInt, id] }), usuario);
  }
  if (c.transportes) {
    await reemplazar(ejecutar, "Giras.tblSolicitudTransportes", idSolicitud, c.transportes,
      `INSERT INTO Giras.tblSolicitudTransportes (idSolicitud, idTipoTransporte, observacion, usuarioRegistro)
       VALUES (@idSolicitud, @idTipo, @observacion, @usuario)`,
      (t) => ({ idTipo: [sql.TinyInt, t.idTipoTransporte], observacion: [sql.NVarChar(300), t.observacion] }), usuario);
  }
  if (c.costos) {
    // El total de la cabecera lo recalcula tgrCostosDetalleActualizar en cada alta y baja.
    await reemplazar(ejecutar, "Giras.tblCostosDetalle", idSolicitud, c.costos,
      `INSERT INTO Giras.tblCostosDetalle (idSolicitud, nombre, descripcion, total, usuarioRegistro)
       VALUES (@idSolicitud, @nombre, @descripcion, @total, @usuario)`,
      (k) => ({
        nombre: [sql.NVarChar(120), k.nombre],
        descripcion: [sql.NVarChar(300), k.descripcion],
        total: [sql.Decimal(12, 2), k.total],
      }), usuario);
  }
  if (c.docentes) {
    await reemplazar(ejecutar, "Giras.tblDocentesAcompanantes", idSolicitud, c.docentes,
      `INSERT INTO Giras.tblDocentesAcompanantes (idSolicitud, idUsuarioAcompanante, usuarioRegistro)
       VALUES (@idSolicitud, @id, @usuario)`, (id) => ({ id: [sql.Int, id] }), usuario);
  }
  if (c.documentos) {
    await reemplazar(ejecutar, "Giras.tblSolicitudDocumentos", idSolicitud, c.documentos,
      `INSERT INTO Giras.tblSolicitudDocumentos (idSolicitud, tipoDocumento, nombre, linkDocumento, usuarioRegistro)
       VALUES (@idSolicitud, @tipo, @nombre, @link, @usuario)`,
      (d) => ({
        tipo: [sql.NVarChar(40), d.tipoDocumento],
        nombre: [sql.NVarChar(200), d.nombre],
        link: [sql.NVarChar(400), d.linkDocumento],
      }), usuario);
  }
}

/** Lo minimo que una solicitud debe tener para salir de Borrador. Es forma, no regla de negocio. */
const REQUERIDOS_PARA_ENVIO: [columna: string, etiqueta: string][] = [
  ["idTipoAlcance", "idTipoAlcance"],
  ["destinoGira", "destinoGira"],
  ["objetivoAcademico", "objetivoAcademico"],
  ["fechaSalidaPropuesta", "fechaSalidaPropuesta"],
  ["fechaRetornoPropuesta", "fechaRetornoPropuesta"],
];

async function enviarEnTransaccion(ejecutar: Ejecutor, idSolicitud: number): Promise<void> {
  const { codigoEstado } = await bloquear(ejecutar, idSolicitud);
  exigirEditable(codigoEstado, idSolicitud);

  const filas = await ejecutar<Record<string, unknown>>(`
    SELECT idTipoAlcance, destinoGira, objetivoAcademico, fechaSalidaPropuesta, fechaRetornoPropuesta
      FROM Giras.tblSolicitudes WHERE idSolicitud = @id
  `, { id: [sql.Int, idSolicitud] });
  const fila = filas[0] ?? {};
  const faltantes = REQUERIDOS_PARA_ENVIO.filter(([columna]) => fila[columna] === null || fila[columna] === undefined)
    .map(([, etiqueta]) => etiqueta);
  if (faltantes.length > 0) {
    throw solicitudInvalida(`Para enviar la solicitud faltan datos: ${faltantes.join(", ")}.`, { faltantes });
  }

  await ejecutar(`
    UPDATE Giras.tblSolicitudes
       SET idEstado = @estado, fechaEnvio = SYSDATETIME()
     WHERE idSolicitud = @id
  `, {
    estado: [sql.Int, await idEstado(CONTEXTO.solicitud, "Pendiente")],
    id: [sql.Int, idSolicitud],
  });
}

/** Crea la solicitud como Borrador, o ya como Pendiente si `enviar`. */
export async function crearSolicitud(cambios: CambiosSolicitud, enviar: boolean, usuario: string): Promise<number> {
  const estadoBorrador = await idEstado(CONTEXTO.solicitud, "Borrador");

  return enTransaccion(async (ejecutar) => {
    const columnas = [...Object.keys(cambios.cabecera), "idEstado", "usuarioRegistro"];
    const filas = await ejecutar<{ id: number }>(`
      INSERT INTO Giras.tblSolicitudes (${columnas.join(", ")})
      VALUES (${columnas.map((c) => `@${c}`).join(", ")});
      SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
    `, {
      ...cambios.cabecera,
      idEstado: [sql.Int, estadoBorrador],
      usuarioRegistro: usuarioParam(usuario),
    });
    const idSolicitud = filas[0]!.id;

    await escribirHijos(ejecutar, idSolicitud, cambios, usuario);
    if (enviar) await enviarEnTransaccion(ejecutar, idSolicitud);
    return idSolicitud;
  });
}

/** Edita una solicitud en Borrador o Correccion. Lo que no llega en el cuerpo no se toca. */
export async function actualizarSolicitud(idSolicitud: number, cambios: CambiosSolicitud, usuario: string): Promise<void> {
  if (!hayCambios(cambios)) throw solicitudInvalida("No se envio ningun campo para modificar.");

  await enTransaccion(async (ejecutar) => {
    const { codigoEstado } = await bloquear(ejecutar, idSolicitud);
    exigirEditable(codigoEstado, idSolicitud);

    const columnas = Object.keys(cambios.cabecera);
    if (columnas.length > 0) {
      await ejecutar(`
        UPDATE Giras.tblSolicitudes
           SET ${columnas.map((c) => `${c} = @${c}`).join(", ")}
         WHERE idSolicitud = @idSolicitud
      `, { ...cambios.cabecera, idSolicitud: [sql.Int, idSolicitud] });
    }
    await escribirHijos(ejecutar, idSolicitud, cambios, usuario);
  });
}

/** Borrador o Correccion → Pendiente (el reenvio tras una correccion es el mismo gesto). */
export async function enviarSolicitud(idSolicitud: number): Promise<void> {
  await enTransaccion((ejecutar) => enviarEnTransaccion(ejecutar, idSolicitud));
}

/**
 * Solo un Borrador se elimina. Una solicitud enviada es parte del expediente
 * (dictamenes, bitacora) y se cierra con un dictamen, no se borra.
 */
export async function eliminarSolicitud(idSolicitud: number): Promise<void> {
  await enTransaccion(async (ejecutar) => {
    const { codigoEstado } = await bloquear(ejecutar, idSolicitud);
    if (codigoEstado !== "Borrador") {
      throw conflicto(`Solo se pueden eliminar solicitudes en Borrador; la ${idSolicitud} esta en ${codigoEstado}.`);
    }

    const p = { id: [sql.Int, idSolicitud] as Parametro };
    for (const tabla of [
      "tblSolicitudDocumentos", "tblCostosDetalle", "tblDocentesAcompanantes", "tblSolicitudTransportes",
      "tblSolicitudFinanciamientos", "tblSolicitudFinalidades", "tblSolicitudFacultades",
      "tblSolicitudCategorias", "tblSolicitudesLog",
    ]) {
      await ejecutar(`DELETE FROM Giras.${tabla} WHERE idSolicitud = @id`, { id: p.id });
    }
    await ejecutar(`DELETE FROM Giras.tblSolicitudes WHERE idSolicitud = @id`, { id: p.id });
  });
}

/* -------------------------------- Dictamen ------------------------------- */

export const DECISIONES_SOLICITUD = ["Aprobada", "Denegada", "Correccion"] as const;
export type DecisionSolicitud = (typeof DECISIONES_SOLICITUD)[number];

export interface DictamenSolicitud {
  idJefeAprobacion: number;
  decision: DecisionSolicitud;
  justificacion: string | null;
  idTipoCancelacion: number | null;
}

/**
 * Pendiente → Aprobada | Denegada | Correccion. En una sola transaccion:
 * inserta el dictamen, mueve el estado de la solicitud y, si se aprueba,
 * crea la gira (ukGira_Solicitud: una por solicitud).
 *
 * Supuestos que la base no fija y que hay que confirmar con el equipo:
 *  - Solo se dictamina lo que esta Pendiente.
 *  - La fila de dictamen lleva GIRA_DICTAMEN (Aprobado/Denegado); para
 *    Correccion, que ese contexto no tiene, lleva el estado Correccion de la
 *    solicitud.
 *  - La gira nace en "Pendiente de transporte" si la solicitud usa transporte
 *    de la universidad y en "Inscripcion abierta" si no.
 */
export async function dictaminarSolicitud(idSolicitud: number, d: DictamenSolicitud, usuario: string): Promise<void> {
  const estadoNuevo = await idEstado(CONTEXTO.solicitud, d.decision);
  const estadoDictamen =
    d.decision === "Correccion"
      ? estadoNuevo
      : await idEstado(CONTEXTO.dictamen, d.decision === "Aprobada" ? "Aprobado" : "Denegado");

  await enTransaccion(async (ejecutar) => {
    const { codigoEstado, usaTransporteUniversidad } = await bloquear(ejecutar, idSolicitud);
    if (codigoEstado !== "Pendiente") {
      throw conflicto(`Solo se dictamina una solicitud Pendiente; la ${idSolicitud} esta en ${codigoEstado}.`);
    }

    // El dictamen apunta a la version de la solicitud que se reviso: la ultima de la bitacora.
    const version = await ejecutar<{ numeroVersion: number | null }>(`
      SELECT MAX(numeroVersion) AS numeroVersion FROM Giras.tblSolicitudesLog WHERE idSolicitud = @id
    `, { id: [sql.Int, idSolicitud] });

    await ejecutar(`
      INSERT INTO Giras.tblSolicitudDictamenes
          (idSolicitud, idJefeAprobacion, idEstado, idTipoCancelacion, justificacionDictamen, numeroVersion, usuarioRegistro)
      VALUES (@id, @jefe, @estadoDictamen, @tipoCancelacion, @justificacion, @version, @usuario)
    `, {
      id: [sql.Int, idSolicitud],
      jefe: [sql.Int, d.idJefeAprobacion],
      estadoDictamen: [sql.Int, estadoDictamen],
      tipoCancelacion: [sql.TinyInt, d.idTipoCancelacion],
      justificacion: [sql.NVarChar(1000), d.justificacion],
      version: [sql.Int, version[0]?.numeroVersion ?? null],
      usuario: usuarioParam(usuario),
    });

    await ejecutar(`UPDATE Giras.tblSolicitudes SET idEstado = @estado WHERE idSolicitud = @id`, {
      estado: [sql.Int, estadoNuevo],
      id: [sql.Int, idSolicitud],
    });

    if (d.decision === "Aprobada") {
      const codigoGira = usaTransporteUniversidad ? "Pendiente de transporte" : "Inscripcion abierta";
      await ejecutar(`
        INSERT INTO Giras.tblGiras
            (idSolicitud, idJefeAprobacion, idEstado, fechaSalidaConfirmada, fechaRetornoConfirmada, usuarioRegistro)
        SELECT idSolicitud, @jefe, @estadoGira, fechaSalidaPropuesta, fechaRetornoPropuesta, @usuario
          FROM Giras.tblSolicitudes WHERE idSolicitud = @id
      `, {
        jefe: [sql.Int, d.idJefeAprobacion],
        estadoGira: [sql.Int, await idEstado(CONTEXTO.gira, codigoGira)],
        usuario: usuarioParam(usuario),
        id: [sql.Int, idSolicitud],
      });
    }
  });
}
