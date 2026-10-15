/**
 * Lectura de entrada y piezas SQL compartidas por los modulos de Procad.
 *
 * Igual que compartido/validacion.ts, aqui solo se valida la FORMA (que la
 * fecha sea una fecha, que la lista sea una lista). Las reglas de negocio
 * viven en los triggers de Procad.
 *
 * Los lectores de fecha, hora y listas son los mismos de giras/entrada.ts.
 * Se copian en vez de importarlos para que procad no arrastre codigo de giras
 * en su bundle; si una tercera funcion los necesita, conviene moverlos a
 * compartido/validacion.ts.
 */
import { sql, type Parametro } from "../../compartido/db";
import { solicitudInvalida } from "../../compartido/errores";
import { enteroRequerido, textoRequerido } from "../../compartido/validacion";

/** El ejecutor que entrega enTransaccion: como `consultar`, atado a la transaccion. */
export type Ejecutor = <F = Record<string, unknown>>(
  consulta: string,
  parametros?: Record<string, Parametro>,
) => Promise<F[]>;

export const usuarioParam = (usuario: string): Parametro => [sql.NVarChar(90), usuario];

/* -------------------------------- Estados -------------------------------- */

/** Contextos de Catalogo.tblEstados que usa Procad. */
export const CONTEXTO = {
  solicitud: "PROCAD_SOLICITUD",
  actividad: "PROCAD_ACTIVIDAD",
  expulsion: "PROCAD_EXPULSION",
  lista: "PROCAD_LISTA",
} as const;

/**
 * Subconsulta que resuelve un idEstado por contexto y codigo, para no fijar
 * ids en el codigo: los ids dependen del orden de los seeds. El contexto sale
 * de CONTEXTO (nunca del usuario); el codigo va como parametro.
 */
export const idEstado = (contexto: string, parametroCodigo: string) =>
  `(SELECT idEstado FROM Catalogo.tblEstados WHERE contextoEstado = N'${contexto}' AND codigoEstado = @${parametroCodigo})`;

/** Una decision del cuerpo, comparada sin importar mayusculas con la lista canonica. */
export function decisionDe<T extends string>(valor: unknown, permitidas: readonly T[]): T {
  const texto = textoRequerido(valor, "decision", 40).toUpperCase();
  const decision = permitidas.find((p) => p === texto);
  if (!decision) throw solicitudInvalida(`decision debe ser una de: ${permitidas.join(", ")}.`);
  return decision;
}

/** Codigo de estado opcional para filtros, validado contra la lista del contexto. */
export function estadoOpcional<T extends string>(valor: unknown, permitidos: readonly T[]): T | null {
  if (valor === undefined || valor === null || valor === "") return null;
  const texto = String(valor).trim().toUpperCase();
  const estado = permitidos.find((p) => p === texto);
  if (!estado) throw solicitudInvalida(`estado debe ser uno de: ${permitidos.join(", ")}.`);
  return estado;
}

/* ------------------------------ Fechas y horas ---------------------------- */

/** "YYYY-MM-DD" o null. Rechaza fechas que no existen (2026-02-30). */
export function fechaOpcional(valor: unknown, nombre: string): string | null {
  if (valor === undefined || valor === null || valor === "") return null;
  const texto = typeof valor === "string" ? valor.trim() : "";
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (partes) {
    const [, a, m, d] = partes.map(Number) as [number, number, number, number];
    const fecha = new Date(Date.UTC(a, m - 1, d));
    if (fecha.getUTCFullYear() === a && fecha.getUTCMonth() === m - 1 && fecha.getUTCDate() === d) {
      return texto;
    }
  }
  throw solicitudInvalida(`El parametro ${nombre} debe ser una fecha valida con formato AAAA-MM-DD.`);
}

export function fechaRequerida(valor: unknown, nombre: string): string {
  const fecha = fechaOpcional(valor, nombre);
  if (fecha === null) throw solicitudInvalida(`El parametro ${nombre} es obligatorio.`);
  return fecha;
}

/** "HH:MM" o "HH:MM:SS" o null. */
export function horaOpcional(valor: unknown, nombre: string): string | null {
  if (valor === undefined || valor === null || valor === "") return null;
  const texto = typeof valor === "string" ? valor.trim() : "";
  const partes = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(texto);
  if (partes && Number(partes[1]) < 24 && Number(partes[2]) < 60 && Number(partes[3] ?? 0) < 60) {
    return texto;
  }
  throw solicitudInvalida(`El parametro ${nombre} debe ser una hora valida con formato HH:MM.`);
}

/* --------------------------------- Listas -------------------------------- */

/** Lista de ids enteros sin repetidos. Ausente o null equivale a lista vacia. */
export function listaDeIds(valor: unknown, nombre: string): number[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor)) throw solicitudInvalida(`${nombre} debe ser una lista.`);
  return [...new Set(valor.map((id, indice) => enteroRequerido(id, `${nombre}[${indice}]`)))];
}

/** Lista de objetos; cada elemento se lee con `leer`, que recibe su nombre para los mensajes. */
export function listaDeObjetos<T>(
  valor: unknown,
  nombre: string,
  leer: (fila: Record<string, unknown>, etiqueta: string) => T,
): T[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor)) throw solicitudInvalida(`${nombre} debe ser una lista.`);
  return valor.map((fila, indice) => {
    if (fila === null || typeof fila !== "object" || Array.isArray(fila)) {
      throw solicitudInvalida(`${nombre}[${indice}] debe ser un objeto.`);
    }
    return leer(fila as Record<string, unknown>, `${nombre}[${indice}]`);
  });
}

/* ------------------------------- Filtros SQL ------------------------------ */

/**
 * Acumula condiciones WHERE con sus parametros. Las columnas las escribe el
 * codigo; los valores entran siempre como parametros tipados.
 */
export class Filtros {
  private readonly condiciones: string[] = [];
  readonly parametros: Record<string, Parametro> = {};

  /** Agrega `condicion` solo si el valor vino (no null). */
  si(valor: unknown, nombre: string, tipo: Parametro[0], condicion: string): this {
    if (valor === null || valor === undefined) return this;
    this.parametros[nombre] = [tipo, valor];
    this.condiciones.push(condicion);
    return this;
  }

  /** Condicion fija, sin parametro. */
  siempre(condicion: string): this {
    this.condiciones.push(condicion);
    return this;
  }

  get where(): string {
    return this.condiciones.length > 0 ? `WHERE ${this.condiciones.join(" AND ")}` : "";
  }
}
