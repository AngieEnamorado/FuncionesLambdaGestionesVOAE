/**
 * Tablas tipo de Giras (CRUD generico).
 *
 * Todas las tablas tipo del esquema Giras comparten la misma forma: una PK
 * numerica, un nombre y unas pocas columnas mas. En vez de escribir quince
 * copias del mismo CRUD, cada una se declara en REGISTRO y las cinco
 * operaciones se generan a partir de esa declaracion. Los nombres de tabla y
 * de columna salen de esta lista y nunca de la entrada del usuario, asi que
 * armar el SQL con ellos no abre inyeccion; los VALORES siempre van como
 * parametros tipados.
 *
 * Cada registro se devuelve con las columnas tal como estan en la base mas
 * dos alias uniformes que la pantalla de Configuracion necesita para pintar
 * cualquier catalogo con la misma tabla: `id` (la PK) y `activo` (la columna
 * de estado, o true fijo cuando la tabla no tiene una).
 */
import { consultar, consultarUna, sql, type Parametro } from "../../compartido/db";
import { enCache, invalidarCache } from "../../compartido/catalogos";
import { ErrorHttp, conflicto, noEncontrado, solicitudInvalida } from "../../compartido/errores";
import {
  booleanoOpcional,
  enteroRequerido,
  textoOpcional,
  textoRequerido,
} from "../../compartido/validacion";

type TipoCampo = "texto" | "entero" | "bit";

interface Campo {
  nombre: string;
  tipo: TipoCampo;
  /** Largo maximo de la columna (solo texto). */
  largo?: number;
  requerido?: boolean;
  /** Solo se escribe al crear; despues es inmutable. */
  soloAlta?: boolean;
  /** Valores admitidos (solo texto); se normaliza a mayusculas. */
  permitidos?: string[];
  /** Minimo admitido (solo entero). Por defecto 1. */
  minimo?: number;
}

interface Definicion {
  tabla: string;
  pk: string;
  pkTipo: "tinyint" | "int";
  campos: Campo[];
  /** Columna BIT que hace de "activo". Sin ella la tabla no puede desactivar registros. */
  estado?: string;
  orden: string;
  /** Columna = expresion SQL fija: filtra las lecturas y se escribe al crear (una vista de otra tabla). */
  fijos?: Record<string, string>;
  /** false cuando borrar el registro rompe al codigo que lo lee. */
  permiteEliminar?: boolean;
}

const nombre = (largo: number): Campo => ({ nombre: "nombre", tipo: "texto", largo, requerido: true });
const descripcion = (largo: number): Campo => ({ nombre: "descripcion", tipo: "texto", largo });

const REGISTRO: Record<string, Definicion> = {
  transporte: {
    tabla: "Giras.tblTiposTransporte", pk: "idTipoTransporte", pkTipo: "tinyint",
    campos: [nombre(80), descripcion(200)], orden: "nombre",
  },
  facultades: {
    tabla: "Giras.tblFacultades", pk: "idFacultad", pkTipo: "int",
    campos: [nombre(150)], estado: "estadoFacultad", orden: "nombre",
  },
  // "Carreras" del frontend = categorias cuyo tipo es Carrera.
  carreras: {
    tabla: "Giras.tblCategorias", pk: "idCategoria", pkTipo: "int",
    campos: [nombre(150)], estado: "estadoCategoria", orden: "nombre",
    fijos: {
      idTipoCategoria: "(SELECT idTipoCategoria FROM Giras.tblTiposCategoria WHERE nombre = N'Carrera')",
    },
  },
  categorias: {
    tabla: "Giras.tblCategorias", pk: "idCategoria", pkTipo: "int",
    campos: [nombre(150), { nombre: "idTipoCategoria", tipo: "entero", requerido: true }],
    estado: "estadoCategoria", orden: "nombre",
  },
  financiamiento: {
    tabla: "Giras.tblTiposFinanciamientos", pk: "idTipoFinanciamiento", pkTipo: "tinyint",
    campos: [nombre(80), descripcion(200)], orden: "nombre",
  },
  finalidades: {
    tabla: "Giras.tblTiposFinalidades", pk: "idTipoFinalidad", pkTipo: "tinyint",
    campos: [nombre(80), descripcion(200)], orden: "nombre",
  },
  alcance: {
    tabla: "Giras.tblTiposAlcance", pk: "idTipoAlcance", pkTipo: "tinyint",
    campos: [nombre(50), descripcion(200)], orden: "idTipoAlcance",
  },
  cancelacion: {
    tabla: "Giras.tblTiposCancelacion", pk: "idTipoCancelacion", pkTipo: "tinyint",
    campos: [
      nombre(80), descripcion(200),
      { nombre: "aplicaA", tipo: "texto", largo: 10, permitidos: ["SOLICITUD", "GIRA", "AMBAS"] },
    ],
    estado: "estadoTipoCancelacion", orden: "nombre",
  },
  inscripcion: {
    tabla: "Giras.tblTiposInscripcion", pk: "idTipoInscripcion", pkTipo: "tinyint",
    campos: [nombre(80), descripcion(200), { nombre: "requiereMotivo", tipo: "bit" }],
    estado: "estadoTipoInscripcion", orden: "idTipoInscripcion",
  },
  modificaciones: {
    tabla: "Giras.tblTiposModificaciones", pk: "idTipoModificacion", pkTipo: "tinyint",
    campos: [nombre(50), descripcion(200)], orden: "idTipoModificacion",
  },
  sangre: {
    tabla: "Giras.tblTiposSangre", pk: "idTipoSangre", pkTipo: "tinyint",
    campos: [nombre(5)], orden: "idTipoSangre",
  },
  informe: {
    tabla: "Giras.tblTiposInforme", pk: "idTipoInforme", pkTipo: "tinyint",
    campos: [nombre(50)], orden: "idTipoInforme",
  },
  "tipos-categoria": {
    tabla: "Giras.tblTiposCategoria", pk: "idTipoCategoria", pkTipo: "tinyint",
    campos: [nombre(50), descripcion(200)], orden: "nombre",
  },
  "tipos-unidad": {
    tabla: "Giras.tblTiposUnidad", pk: "idTipoUnidad", pkTipo: "tinyint",
    campos: [nombre(50), descripcion(200)], orden: "idTipoUnidad",
  },
  // Parametros: el codigo los lee por nombre (los triggers leen maxDocentesPorGira),
  // asi que el nombre no cambia y el registro no se borra: se desactiva o se ajusta.
  parametros: {
    tabla: "Giras.tblParametros", pk: "idParametro", pkTipo: "int",
    campos: [
      { nombre: "nombre", tipo: "texto", largo: 60, requerido: true, soloAlta: true },
      { nombre: "valorParametro", tipo: "entero", requerido: true, minimo: 0 },
      descripcion(200),
    ],
    estado: "estadoParametro", orden: "nombre", permiteEliminar: false,
  },
};

export const CATALOGOS_DISPONIBLES = Object.keys(REGISTRO);

function definicion(slug: string): Definicion {
  const def = REGISTRO[slug];
  if (!def) {
    throw noEncontrado(
      `No existe el catalogo ${slug}. Disponibles: ${CATALOGOS_DISPONIBLES.join(", ")}.`,
    );
  }
  return def;
}

const tipoSql = (campo: Campo): Parametro[0] => {
  if (campo.tipo === "texto") return sql.NVarChar(campo.largo ?? 200);
  return campo.tipo === "entero" ? sql.Int : sql.Bit;
};

/* ------------------------------ Lectura --------------------------------- */

function columnas(def: Definicion): string {
  const propias = [def.pk, ...def.campos.map((c) => c.nombre)];
  if (def.estado) propias.push(def.estado);
  return [
    ...propias,
    `${def.pk} AS id`,
    def.estado ? `${def.estado} AS activo` : "CAST(1 AS BIT) AS activo",
  ].join(", ");
}

function filtrosFijos(def: Definicion): string {
  return Object.entries(def.fijos ?? {})
    .map(([columna, expresion]) => ` AND ${columna} = ${expresion}`)
    .join("");
}

function cargar(def: Definicion, soloActivos: boolean) {
  return consultar(`
    SELECT ${columnas(def)}
      FROM ${def.tabla}
     WHERE 1 = 1${soloActivos && def.estado ? ` AND ${def.estado} = 1` : ""}${filtrosFijos(def)}
     ORDER BY ${def.orden}
  `);
}

/**
 * Las listas para formularios (solo activos) van por cache corto: son las que
 * pide toda pantalla. Las de mantenimiento (con inactivos) NO se cachean: el
 * cache es por contenedor, y quien acaba de editar un registro tiene que
 * verlo en la siguiente lectura aunque caiga en otro contenedor.
 */
const TTL_CATALOGOS_MS = 60_000;

export function listarCatalogo(slug: string, incluirInactivos: boolean) {
  const def = definicion(slug);
  if (incluirInactivos) return cargar(def, false);
  return enCache(`giras:catalogo:${slug}`, () => cargar(def, true), TTL_CATALOGOS_MS);
}

/** Todos los catalogos activos en una sola respuesta, para poblar los formularios. */
export function listarTodosLosCatalogos() {
  return enCache("giras:catalogos:todos", async () => {
    const pares = await Promise.all(
      CATALOGOS_DISPONIBLES.map(async (slug) => [slug, await cargar(definicion(slug), true)] as const),
    );
    return Object.fromEntries(pares);
  }, TTL_CATALOGOS_MS);
}

function validarId(def: Definicion, valor: unknown): number {
  const id = enteroRequerido(valor, "id");
  // Un TINYINT no admite mas de 255: fuera de rango es "no existe", no un error de tipo.
  if (def.pkTipo === "tinyint" && id > 255) throw noEncontrado(`No existe el registro ${id}.`);
  return id;
}

const tipoPk = (def: Definicion) => (def.pkTipo === "tinyint" ? sql.TinyInt : sql.Int);

export async function obtenerRegistro(slug: string, idCrudo: unknown) {
  const def = definicion(slug);
  const id = validarId(def, idCrudo);
  const fila = await consultarUna(`
    SELECT ${columnas(def)} FROM ${def.tabla}
     WHERE ${def.pk} = @id${filtrosFijos(def)}
  `, { id: [tipoPk(def), id] });
  if (!fila) throw noEncontrado(`No existe el registro ${id} en el catalogo ${slug}.`);
  return fila;
}

/* ------------------------------ Escritura ------------------------------- */

interface Valores {
  columnas: string[];
  parametros: Record<string, Parametro>;
}

/** Forma de la entrada. Que el nombre no se repita lo dice la UNIQUE de la base (409). */
function leerCuerpo(def: Definicion, cuerpo: Record<string, unknown>, esAlta: boolean): Valores {
  const valores: Valores = { columnas: [], parametros: {} };

  for (const campo of def.campos) {
    if (!(campo.nombre in cuerpo)) {
      if (esAlta && campo.requerido) throw solicitudInvalida(`El campo ${campo.nombre} es obligatorio.`);
      continue;
    }
    if (!esAlta && campo.soloAlta) {
      throw solicitudInvalida(`El campo ${campo.nombre} no se puede modificar una vez creado el registro.`);
    }

    const crudo = cuerpo[campo.nombre];
    let valor: unknown;

    if (campo.tipo === "texto") {
      valor = campo.requerido
        ? textoRequerido(crudo, campo.nombre, campo.largo ?? 200)
        : textoOpcional(crudo, campo.nombre, campo.largo ?? 200);
      if (campo.permitidos && valor !== null) {
        valor = (valor as string).toUpperCase();
        if (!campo.permitidos.includes(valor as string)) {
          throw solicitudInvalida(`${campo.nombre} debe ser uno de: ${campo.permitidos.join(", ")}.`);
        }
      }
    } else if (campo.tipo === "entero") {
      valor = enteroDesde(crudo, campo);
    } else {
      valor = booleanoOpcional(crudo, campo.nombre);
      if (valor === null) throw solicitudInvalida(`El campo ${campo.nombre} debe ser true o false.`);
    }

    valores.columnas.push(campo.nombre);
    valores.parametros[campo.nombre] = [tipoSql(campo), valor];
  }

  if ("activo" in cuerpo) {
    if (!def.estado) {
      throw solicitudInvalida("Este catalogo no admite desactivar registros: su tabla no tiene columna de estado.");
    }
    const activo = booleanoOpcional(cuerpo["activo"], "activo");
    if (activo === null) throw solicitudInvalida("El campo activo debe ser true o false.");
    valores.columnas.push(def.estado);
    valores.parametros[def.estado] = [sql.Bit, activo];
  }

  return valores;
}

/** Como enteroRequerido pero con el minimo del campo: un parametro puede valer 0. */
function enteroDesde(valor: unknown, campo: Campo): number {
  const minimo = campo.minimo ?? 1;
  const numero = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  if (typeof numero !== "number" || !Number.isInteger(numero)) {
    throw solicitudInvalida(`El campo ${campo.nombre} debe ser un numero entero.`);
  }
  if (numero < minimo) {
    throw solicitudInvalida(`El campo ${campo.nombre} debe ser mayor o igual que ${minimo}.`);
  }
  return numero;
}

/** Una alta o un cambio en una tabla invalida todas las vistas de esa misma tabla (carreras y categorias comparten la suya). */
function invalidar(def: Definicion): void {
  for (const [slug, otra] of Object.entries(REGISTRO)) {
    if (otra.tabla === def.tabla) invalidarCache(`giras:catalogo:${slug}`);
  }
  invalidarCache("giras:catalogos:todos");
}

export async function crearRegistro(slug: string, cuerpo: Record<string, unknown>, usuario: string) {
  const def = definicion(slug);
  const valores = leerCuerpo(def, cuerpo, true);

  const nombresFijos = Object.keys(def.fijos ?? {});
  const listaColumnas = [...valores.columnas, ...nombresFijos, "usuarioRegistro"];
  const listaValores = [
    ...valores.columnas.map((c) => `@${c}`),
    ...nombresFijos.map((c) => (def.fijos as Record<string, string>)[c] as string),
    "@usuarioRegistro",
  ];

  // Sin OUTPUT: SQL Server lo rechaza en tablas con triggers (tblParametros tiene uno).
  const filas = await consultar<{ id: number }>(`
    INSERT INTO ${def.tabla} (${listaColumnas.join(", ")})
    VALUES (${listaValores.join(", ")});
    SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
  `, { ...valores.parametros, usuarioRegistro: [sql.NVarChar(90), usuario] });

  invalidar(def);
  return obtenerRegistro(slug, filas[0]!.id);
}

export async function actualizarRegistro(
  slug: string,
  idCrudo: unknown,
  cuerpo: Record<string, unknown>,
) {
  const def = definicion(slug);
  await obtenerRegistro(slug, idCrudo); // 404 si no existe
  const id = validarId(def, idCrudo);

  const valores = leerCuerpo(def, cuerpo, false);
  if (valores.columnas.length === 0) {
    throw solicitudInvalida("No se envio ningun campo para modificar.");
  }

  await consultar(`
    UPDATE ${def.tabla}
       SET ${valores.columnas.map((c) => `${c} = @${c}`).join(", ")}
     WHERE ${def.pk} = @id
  `, { ...valores.parametros, id: [tipoPk(def), id] });

  invalidar(def);
  return obtenerRegistro(slug, id);
}

export async function eliminarRegistro(slug: string, idCrudo: unknown): Promise<void> {
  const def = definicion(slug);
  if (def.permiteEliminar === false) {
    throw new ErrorHttp(405, `Los registros del catalogo ${slug} no se eliminan: desactivelos.`);
  }
  await obtenerRegistro(slug, idCrudo); // 404 si no existe
  const id = validarId(def, idCrudo);

  try {
    await consultar(`DELETE FROM ${def.tabla} WHERE ${def.pk} = @id`, { id: [tipoPk(def), id] });
  } catch (error) {
    // 547: otra tabla todavia apunta a este registro.
    if ((error as { number?: number }).number === 547) {
      throw conflicto(
        def.estado
          ? "El registro esta en uso y no se puede eliminar. Desactivelo para que deje de ofrecerse."
          : "El registro esta en uso y no se puede eliminar.",
      );
    }
    throw error;
  }

  invalidar(def);
}
