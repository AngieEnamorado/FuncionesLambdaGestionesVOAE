/**
 * Arma un evento de HTTP API (payload 2.0) como el que manda API Gateway, y
 * devuelve la respuesta con el cuerpo ya parseado.
 */
import type { EventoApiGateway, RespuestaHttp } from "../src/compartido/router";

type Handler = (evento: EventoApiGateway) => Promise<RespuestaHttp>;

export async function invocar(
  handler: Handler,
  metodo: string,
  rutaConQuery: string,
  cuerpo?: unknown,
): Promise<{ codigo: number; cuerpo: any }> {
  const [ruta = "/", query = ""] = rutaConQuery.split("?");
  const parametros = Object.fromEntries(new URLSearchParams(query));

  const respuesta = await handler({
    version: "2.0",
    rawPath: ruta,
    requestContext: { http: { method: metodo, path: ruta } },
    queryStringParameters: Object.keys(parametros).length > 0 ? parametros : undefined,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    headers: { "content-type": "application/json" },
  });

  return {
    codigo: respuesta.statusCode,
    cuerpo: respuesta.body === "" ? undefined : JSON.parse(respuesta.body),
  };
}
