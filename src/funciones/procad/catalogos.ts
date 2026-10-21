/**
 * Catalogos propios de Procad, en una sola respuesta.
 *
 * Son tablas diminutas y casi estaticas (deportes, disciplinas, instrumentos,
 * posiciones...) que pide todo formulario del modulo. Ninguna tiene triggers:
 * no hay regla de negocio que respetar al leerlas, solo el filtro de activos.
 *
 * Cada catalogo se declara en REGISTRO. Los nombres de tabla y de columna
 * salen de esa lista y nunca de la entrada del usuario, asi que armar el SQL
 * con ellos no abre inyeccion.
 *
 * Cada fila se devuelve con las columnas tal como estan en la base mas dos
 * alias uniformes: `id` (la PK) y `activo` (la columna de estado, o true fijo
 * cuando la tabla no tiene una), para que el frontend pinte cualquier
 * catalogo con el mismo componente.
 */
import { consultar } from "../../compartido/db";
import { enCache } from "../../compartido/catalogos";

interface Definicion {
  tabla: string;
  pk: string;
  /** Columnas ademas de la PK y el estado: el nombre y las FKs que la pantalla necesita para filtrar. */
  columnas: string[];
  /** Columna BIT que hace de "activo". Sin ella todas las filas estan vigentes. */
  estado?: string;
  orden: string;
}

const REGISTRO = {
  tiposGrupo: {
    tabla: "Procad.tblTiposGrupo", pk: "idTipoGrupo",
    columnas: ["nombreTipoGrupo"], orden: "idTipoGrupo",
  },
  deportes: {
    tabla: "Procad.tblDeportes", pk: "idDeporte",
    columnas: ["nombreDeporte"], estado: "estadoDeporte", orden: "nombreDeporte",
  },
  // Una posicion pertenece a un deporte: el formulario las filtra por idDeporte.
  posiciones: {
    tabla: "Procad.tblPosiciones", pk: "idPosicion",
    columnas: ["nombrePosicion", "idDeporte"], estado: "estadoPosicion", orden: "idDeporte, nombrePosicion",
  },
  disciplinas: {
    tabla: "Procad.tblDisciplinasArtisticas", pk: "idDisciplina",
    columnas: ["nombreDisciplina"], estado: "estadoDisciplina", orden: "nombreDisciplina",
  },
  instrumentos: {
    tabla: "Procad.tblInstrumentos", pk: "idInstrumento",
    columnas: ["nombreInstrumento"], estado: "estadoInstrumento", orden: "nombreInstrumento",
  },
  // Los tipos de actividad son distintos para grupos deportivos y artisticos.
  tiposActividad: {
    tabla: "Procad.tblTiposActividades", pk: "idTipoActividad",
    columnas: ["nombreTipoActividad", "idTipoGrupo"], estado: "estadoTipoActividad",
    orden: "idTipoGrupo, nombreTipoActividad",
  },
  motivosExpulsion: {
    tabla: "Procad.tblMotivosExpulsion", pk: "idMotivoExpulsion",
    columnas: ["nombreMotivoExpulsion"], orden: "idMotivoExpulsion",
  },
  // idTipoGrupo NULL = el lugar sirve para visorias de ambos tipos de grupo.
  lugaresVisoria: {
    tabla: "Procad.tblLugaresVisoria", pk: "idLugarVisoria",
    columnas: ["nombreLugar", "idTipoGrupo", "idCampus"], estado: "estadoLugar",
    orden: "idCampus, nombreLugar",
  },
  aulas: {
    tabla: "Procad.tblAulas", pk: "idAula",
    columnas: ["nombreAula", "idLugarVisoria"], estado: "estadoAula",
    orden: "idLugarVisoria, nombreAula",
  },
} satisfies Record<string, Definicion>;

export type NombreCatalogo = keyof typeof REGISTRO;
export const CATALOGOS_DISPONIBLES = Object.keys(REGISTRO) as NombreCatalogo[];

function cargar(def: Definicion, soloActivos: boolean) {
  const columnas = [
    def.pk,
    ...def.columnas,
    ...(def.estado ? [def.estado] : []),
    `${def.pk} AS id`,
    def.estado ? `${def.estado} AS activo` : "CAST(1 AS BIT) AS activo",
  ];
  return consultar(`
    SELECT ${columnas.join(", ")}
      FROM ${def.tabla}
     ${soloActivos && def.estado ? `WHERE ${def.estado} = 1` : ""}
     ORDER BY ${def.orden}
  `);
}

async function cargarTodos(soloActivos: boolean) {
  const pares = await Promise.all(
    CATALOGOS_DISPONIBLES.map(
      async (nombre) => [nombre, await cargar(REGISTRO[nombre], soloActivos)] as const,
    ),
  );
  return Object.fromEntries(pares) as Record<NombreCatalogo, Record<string, unknown>[]>;
}

/**
 * Cache corto, igual que en Giras: el cache es por contenedor, y un catalogo
 * editado tarda hasta el TTL en verse en todos.
 */
const TTL_CATALOGOS_MS = 60_000;

/**
 * Todos los catalogos. Solo activos, cacheados, para poblar formularios; con
 * `incluirInactivos` es la vista de mantenimiento y va siempre a la base.
 */
export function listarCatalogos(incluirInactivos: boolean) {
  if (incluirInactivos) return cargarTodos(false);
  return enCache("procad:catalogos:todos", () => cargarTodos(true), TTL_CATALOGOS_MS);
}
