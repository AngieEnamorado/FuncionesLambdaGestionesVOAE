/**
 * Punto de entrada de voae-procad.
 *
 * Detras de la ruta greedy ANY /v1/procad/{proxy+} en API Gateway. El
 * handler solo delega en el router: lo caro (pool, secreto, cache) se resuelve
 * al cargar el modulo, antes de que Lambda llame aqui, y sobrevive a la
 * invocacion.
 */
import type { EventoApiGateway, RespuestaHttp } from "../../compartido/router";
import { router } from "./rutas";

export const handler = async (evento: EventoApiGateway): Promise<RespuestaHttp> =>
  router.manejar(evento);
