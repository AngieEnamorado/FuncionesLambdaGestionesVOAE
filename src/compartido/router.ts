/**
 * Router minimo sobre metodo + ruta.
 *
 * Cada funcion esta detras de una sola ruta greedy (`/v1/{dominio}/{proxy+}`)
 * y rutea adentro, asi que agregar un endpoint es editar un archivo y no
 * tocar infraestructura.
 *
 * Sin dependencias a proposito: lo que se bundlea se paga en arranque frio, y
 * con lo que ya cuesta la conexion a Azure no hay presupuesto para gastarlo
 * en un framework que aqui solo haria `split("/")`.
 */
import { ErrorHttp, traducirErrorSql } from "./errores";

/** Evento de API Gateway, en sus dos formatos (REST v1 y HTTP API v2). */
export interface EventoApiGateway {
  version?: string;
  rawPath?: string;
  path?: string;
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    http?: { method?: string; path?: string };
    path?: string;
    stage?: string;
    authorizer?: {
      jwt?: { claims?: Record<string, string> };
      claims?: Record<string, string>;
    };
  };
}

export interface RespuestaHttp {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface Peticion {
  metodo: string;
  ruta: string;
  /** Parametros tomados de la ruta, p. ej. {idPersona} → "12". */
  parametros: Record<string, string>;
  /** Parametros de query string. */
  consulta: Record<string, string>;
  cuerpo: Record<string, unknown>;
  /**
   * Quien hace la peticion. Mientras no exista capa de sesion llega como
   * entrada explicita, por cabecera o parametro, y no se confia en el para
   * autorizar nada: solo alimenta las columnas de auditoria usuarioRegistro.
   * Por aqui entraran los claims reales sin reestructurar los handlers.
   */
  usuarioRegistro: string;
  evento: EventoApiGateway;
}

export type Manejador = (peticion: Peticion) => Promise<unknown> | unknown;

/** Respuesta con codigo explicito, para cuando 200 no es lo correcto. */
export class Respuesta {
  constructor(
    readonly codigo: number,
    readonly cuerpo: unknown,
  ) {}
}

export const creado = (cuerpo: unknown) => new Respuesta(201, cuerpo);
export const sinContenido = () => new Respuesta(204, undefined);

interface Ruta {
  metodo: string;
  segmentos: string[];
  manejador: Manejador;
}

const USUARIO_POR_DEFECTO = "voae-frontend";

const CABECERAS_BASE: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  // En produccion el frontend y la API van detras de la misma distribucion de
  // CloudFront, son same-origin y CORS no aplica. Estas cabeceras son para el
  // dev server de Vite mientras tanto; al montar CloudFront se quitan.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Voae-Usuario",
};

function respuestaJson(codigo: number, cuerpo: unknown): RespuestaHttp {
  return {
    statusCode: codigo,
    headers: CABECERAS_BASE,
    body: cuerpo === undefined ? "" : JSON.stringify(cuerpo),
  };
}

function troceaRuta(ruta: string): string[] {
  return ruta.split("/").filter((segmento) => segmento !== "");
}

export class Router {
  private readonly rutas: Ruta[] = [];

  /** @param prefijo Parte de la ruta que pertenece a API Gateway, p. ej. "/v1/catalogo". */
  constructor(private readonly prefijo: string) {}

  agregar(metodo: string, patron: string, manejador: Manejador): this {
    this.rutas.push({
      metodo: metodo.toUpperCase(),
      segmentos: troceaRuta(patron),
      manejador,
    });
    return this;
  }

  get = (patron: string, manejador: Manejador) => this.agregar("GET", patron, manejador);
  post = (patron: string, manejador: Manejador) => this.agregar("POST", patron, manejador);
  put = (patron: string, manejador: Manejador) => this.agregar("PUT", patron, manejador);
  delete = (patron: string, manejador: Manejador) => this.agregar("DELETE", patron, manejador);

  /** Quita el prefijo del dominio (y el del stage, si API Gateway lo antepone). */
  private rutaRelativa(rutaCompleta: string): string {
    const posicion = rutaCompleta.indexOf(this.prefijo);
    return posicion === -1
      ? rutaCompleta
      : rutaCompleta.slice(posicion + this.prefijo.length);
  }

  private emparejar(
    metodo: string,
    segmentos: string[],
  ): { ruta: Ruta; parametros: Record<string, string> } | "ruta-desconocida" | "metodo-no-permitido" {
    let huboCoincidenciaDeRuta = false;

    for (const ruta of this.rutas) {
      if (ruta.segmentos.length !== segmentos.length) continue;

      const parametros: Record<string, string> = {};
      const coincide = ruta.segmentos.every((patron, indice) => {
        const segmento = segmentos[indice] as string;
        if (patron.startsWith("{") && patron.endsWith("}")) {
          parametros[patron.slice(1, -1)] = decodeURIComponent(segmento);
          return true;
        }
        return patron.toLowerCase() === segmento.toLowerCase();
      });

      if (!coincide) continue;
      huboCoincidenciaDeRuta = true;
      if (ruta.metodo === metodo) return { ruta, parametros };
    }

    return huboCoincidenciaDeRuta ? "metodo-no-permitido" : "ruta-desconocida";
  }

  private normalizar(evento: EventoApiGateway): Peticion {
    const metodo = (
      evento.requestContext?.http?.method ??
      evento.httpMethod ??
      "GET"
    ).toUpperCase();

    const rutaCompleta =
      evento.rawPath ?? evento.requestContext?.http?.path ?? evento.path ?? "/";

    let cuerpo: Record<string, unknown> = {};
    if (evento.body) {
      const texto = evento.isBase64Encoded
        ? Buffer.from(evento.body, "base64").toString("utf8")
        : evento.body;
      try {
        const analizado = JSON.parse(texto);
        cuerpo = analizado && typeof analizado === "object" ? analizado : {};
      } catch {
        throw new ErrorHttp(400, "El cuerpo de la peticion no es un JSON valido.");
      }
    }

    const consulta: Record<string, string> = {};
    for (const [clave, valor] of Object.entries(evento.queryStringParameters ?? {})) {
      if (valor !== undefined) consulta[clave] = valor;
    }

    const cabeceras: Record<string, string> = {};
    for (const [clave, valor] of Object.entries(evento.headers ?? {})) {
      if (valor !== undefined) cabeceras[clave.toLowerCase()] = valor;
    }

    const usuarioRegistro =
      evento.requestContext?.authorizer?.jwt?.claims?.email ??
      evento.requestContext?.authorizer?.claims?.email ??
      cabeceras["x-voae-usuario"] ??
      consulta["usuarioRegistro"] ??
      USUARIO_POR_DEFECTO;

    return {
      metodo,
      ruta: this.rutaRelativa(rutaCompleta),
      parametros: {},
      consulta,
      cuerpo,
      usuarioRegistro: usuarioRegistro.slice(0, 90), // largo de la columna
      evento,
    };
  }

  async manejar(evento: EventoApiGateway): Promise<RespuestaHttp> {
    const inicio = Date.now();
    let peticion: Peticion | null = null;

    try {
      peticion = this.normalizar(evento);

      if (peticion.metodo === "OPTIONS") return respuestaJson(204, undefined);

      const resultado = this.emparejar(peticion.metodo, troceaRuta(peticion.ruta));

      if (resultado === "ruta-desconocida") {
        throw new ErrorHttp(404, `No existe la ruta ${peticion.metodo} ${peticion.ruta}.`);
      }
      if (resultado === "metodo-no-permitido") {
        throw new ErrorHttp(405, `El metodo ${peticion.metodo} no aplica a ${peticion.ruta}.`);
      }

      peticion.parametros = resultado.parametros;
      const cuerpo = await resultado.ruta.manejador(peticion);

      if (cuerpo instanceof Respuesta) return respuestaJson(cuerpo.codigo, cuerpo.cuerpo);
      if (cuerpo === undefined) return respuestaJson(204, undefined);
      return respuestaJson(200, cuerpo);
    } catch (error) {
      return this.manejarError(error, peticion, inicio);
    }
  }

  private manejarError(
    error: unknown,
    peticion: Peticion | null,
    inicio: number,
  ): RespuestaHttp {
    const traducido = traducirErrorSql(error);

    if (traducido) {
      // 4xx es informacion de negocio, no un fallo: se registra en una linea.
      console.warn(
        JSON.stringify({
          nivel: traducido.codigo >= 500 ? "error" : "aviso",
          ruta: `${peticion?.metodo ?? "?"} ${peticion?.ruta ?? "?"}`,
          codigo: traducido.codigo,
          mensaje: traducido.message,
          ms: Date.now() - inicio,
        }),
      );
      // Un 5xx traducido sigue siendo un fallo de infraestructura: sin el
      // error original en el log, un timeout de red y una base pausada se ven
      // exactamente igual desde CloudWatch.
      if (traducido.codigo >= 500) console.error("Causa:", error);
      return respuestaJson(traducido.codigo, {
        error: traducido.message,
        ...(traducido.detalles !== undefined ? { detalles: traducido.detalles } : {}),
      });
    }

    // Lo no reconocido es un fallo nuestro: traza completa a CloudWatch y un
    // mensaje generico al cliente, sin filtrar detalles de la base de datos.
    console.error(
      JSON.stringify({
        nivel: "error",
        ruta: `${peticion?.metodo ?? "?"} ${peticion?.ruta ?? "?"}`,
        ms: Date.now() - inicio,
      }),
      error,
    );
    return respuestaJson(500, { error: "Error interno del servidor." });
  }
}

export const crearRouter = (prefijo: string) => new Router(prefijo);
