/**
 * Punto de entrada de voae-reporteria.
 *
 * Detras de la ruta greedy ANY /v1/reporteria/{proxy+} en API Gateway. El
 * handler solo delega en el router; pool y secreto se resuelven al cargar el
 * modulo y sobreviven entre invocaciones.
 */
import type { EventoApiGateway, RespuestaHttp } from "../../compartido/router";
import { router } from "./rutas";

export const handler = async (evento: EventoApiGateway): Promise<RespuestaHttp> =>
  router.manejar(evento);
