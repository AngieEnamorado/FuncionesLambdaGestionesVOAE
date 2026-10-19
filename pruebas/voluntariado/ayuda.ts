/**
 * Ayudas de las pruebas de voae-voluntariado: invocar el handler como lo haria
 * API Gateway y contestar consultas segun el SQL que llega.
 */
import { handler } from "../../src/funciones/voluntariado/index";
import { registro, responder, type Consulta } from "./dobles/db";

/** Llama al handler con un evento HTTP API (payload 2.0) y parsea la respuesta. */
export async function invocar(
  metodo: string,
  ruta: string,
  cuerpo?: unknown,
): Promise<{ codigo: number; cuerpo: any }> {
  const [camino = "/", query = ""] = ruta.split("?");
  const consulta = Object.fromEntries(new URLSearchParams(query));
  const respuesta = await handler({
    version: "2.0",
    rawPath: camino,
    requestContext: { http: { method: metodo, path: camino } },
    queryStringParameters: Object.keys(consulta).length > 0 ? consulta : undefined,
    headers: { "content-type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { codigo: respuesta.statusCode, cuerpo: respuesta.body ? JSON.parse(respuesta.body) : undefined };
}

type Respuesta = unknown[] | ((consulta: Consulta) => unknown[]);

/** Contesta con la primera regla cuyo patron aparece en el SQL; lo demas, vacio. */
export function responderPor(reglas: [patron: RegExp, respuesta: Respuesta][]): void {
  responder((consulta) => {
    for (const [patron, respuesta] of reglas) {
      if (patron.test(consulta.texto)) return typeof respuesta === "function" ? respuesta(consulta) : respuesta;
    }
    return [];
  });
}

/** La consulta cuyo SQL contiene el patron; falla si no hubo ninguna. */
export function consultaCon(patron: RegExp): Consulta {
  const encontrada = registro.find((c) => patron.test(c.texto));
  if (!encontrada) {
    const hubo = registro.map((c) => `  ${c.texto.trim().split("\n")[0]?.slice(0, 90)}`).join("\n");
    throw new Error(`Ninguna consulta coincide con ${patron}. Hubo:\n${hubo}`);
  }
  return encontrada;
}

export const cuantasCon = (patron: RegExp) => registro.filter((c) => patron.test(c.texto)).length;
