/**
 * Lectura de entrada especifica de Giras, compartida por solicitudes e
 * inscripciones. Igual que compartido/validacion.ts, aqui solo se valida la
 * FORMA (que la fecha sea una fecha, que la lista sea una lista); las reglas
 * de negocio viven en los triggers.
 */
import type { Parametro } from "../../compartido/db";
import { solicitudInvalida } from "../../compartido/errores";
import { enteroRequerido, textoOpcional, textoRequerido } from "../../compartido/validacion";

/** El ejecutor que entrega enTransaccion: como `consultar`, atado a la transaccion. */
export type Ejecutor = <F = Record<string, unknown>>(
  consulta: string,
  parametros?: Record<string, Parametro>,
) => Promise<F[]>;

/** Entero >= 0 (enteroRequerido exige >= 1, y un conteo o un monto puede ser 0). */
export function enteroNoNegativo(valor: unknown, nombre: string): number {
  const numero = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  if (typeof numero !== "number" || !Number.isInteger(numero)) {
    throw solicitudInvalida(`El parametro ${nombre} debe ser un numero entero.`);
  }
  if (numero < 0) throw solicitudInvalida(`El parametro ${nombre} no puede ser negativo.`);
  return numero;
}

/** Monto con hasta dos decimales, >= 0, para columnas DECIMAL(12,2). */
export function montoRequerido(valor: unknown, nombre: string): number {
  const numero = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  if (typeof numero !== "number" || !Number.isFinite(numero)) {
    throw solicitudInvalida(`El parametro ${nombre} debe ser un numero.`);
  }
  if (numero < 0) throw solicitudInvalida(`El parametro ${nombre} no puede ser negativo.`);
  if (numero > 9_999_999_999.99) throw solicitudInvalida(`El parametro ${nombre} excede el maximo permitido.`);
  return Math.round(numero * 100) / 100;
}

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

export interface DocumentoEntrada {
  tipoDocumento: string;
  nombre: string | null;
  linkDocumento: string;
}

/**
 * Documento de respaldo. La base guarda el enlace, nunca el archivo. Mismas
 * columnas en tblSolicitudDocumentos y tblInscripcionDocumentos.
 */
export const leerDocumento = (fila: Record<string, unknown>, etiqueta: string): DocumentoEntrada => ({
  tipoDocumento: textoRequerido(fila["tipoDocumento"], `${etiqueta}.tipoDocumento`, 40),
  nombre: textoOpcional(fila["nombre"], `${etiqueta}.nombre`, 200),
  linkDocumento: textoRequerido(fila["linkDocumento"], `${etiqueta}.linkDocumento`, 400),
});
