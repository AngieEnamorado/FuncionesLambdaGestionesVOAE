/**
 * Validacion de entrada.
 *
 * Aqui se valida la forma: que el id sea entero, que el campo obligatorio
 * venga. La regla de negocio no, esa vive en los triggers. Si una validacion
 * de aqui empieza a parecerse a una regla de dominio, esta en el lugar
 * equivocado.
 */
import { solicitudInvalida } from "./errores";

export function enteroRequerido(valor: unknown, nombre: string): number {
  const texto = typeof valor === "string" ? valor.trim() : valor;
  const numero = Number(texto);

  if (texto === "" || texto === null || texto === undefined || !Number.isInteger(numero)) {
    throw solicitudInvalida(`El parametro ${nombre} debe ser un numero entero.`);
  }
  if (numero < 1) {
    throw solicitudInvalida(`El parametro ${nombre} debe ser mayor que cero.`);
  }
  return numero;
}

export function enteroOpcional(valor: unknown, nombre: string): number | null {
  if (valor === undefined || valor === null || valor === "") return null;
  return enteroRequerido(valor, nombre);
}

export function textoRequerido(valor: unknown, nombre: string, largoMaximo: number): string {
  if (typeof valor !== "string" || valor.trim() === "") {
    throw solicitudInvalida(`El parametro ${nombre} es obligatorio.`);
  }
  const texto = valor.trim();
  if (texto.length > largoMaximo) {
    throw solicitudInvalida(
      `El parametro ${nombre} excede el largo maximo de ${largoMaximo} caracteres.`,
    );
  }
  return texto;
}

export function textoOpcional(
  valor: unknown,
  nombre: string,
  largoMaximo: number,
): string | null {
  if (valor === undefined || valor === null || valor === "") return null;
  return textoRequerido(valor, nombre, largoMaximo);
}

export function booleanoOpcional(valor: unknown, nombre: string): boolean | null {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor === "boolean") return valor;
  if (valor === "true" || valor === "1" || valor === 1) return true;
  if (valor === "false" || valor === "0" || valor === 0) return false;
  throw solicitudInvalida(`El parametro ${nombre} debe ser true o false.`);
}
