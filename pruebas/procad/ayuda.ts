/**
 * Ayudas para las pruebas de voae-procad: responder segun el SQL que llega
 * y fabricar los errores que lanza SQL Server.
 */
import { alConsultar, llamadas, type Llamada } from "../dobles/db";

type Respuesta = unknown[] | ((llamada: Llamada) => unknown[]);

/**
 * Responde con la primera regla cuyo patron aparece en el SQL (o en el nombre
 * del procedimiento). Lo que no coincide con ninguna devuelve [].
 */
export function responderPor(reglas: [patron: RegExp, respuesta: Respuesta][]): void {
  alConsultar((llamada) => {
    for (const [patron, respuesta] of reglas) {
      if (patron.test(llamada.texto)) {
        return typeof respuesta === "function" ? respuesta(llamada) : respuesta;
      }
    }
    return [];
  });
}

/** Lo que llega de un RAISERROR en un trigger: numero 50000 y el mensaje de negocio. */
export const errorDeTrigger = (mensaje: string) => Object.assign(new Error(mensaje), { number: 50000 });

/** La llamada cuyo SQL contiene el patron; falla si no hubo ninguna. */
export function llamadaCon(patron: RegExp): Llamada {
  const llamada = llamadas.find((l) => patron.test(l.texto));
  if (!llamada) {
    throw new Error(`No hubo ninguna consulta con ${patron}. Hubo:\n${llamadas.map((l) => l.texto.trim().slice(0, 80)).join("\n")}`);
  }
  return llamada;
}

export const cuantasCon = (patron: RegExp) => llamadas.filter((l) => patron.test(l.texto)).length;
