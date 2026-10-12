/**
 * Rutas de voae-reporteria.
 *
 * Agregaciones y registros para los paneles de estadisticas de los tres
 * sistemas. Es la unica funcion que lee de varios esquemas, y solo lee: no
 * hay un solo INSERT ni UPDATE aqui.
 *
 * Va aparte de las funciones de dominio por su perfil de recursos: mas
 * memoria y mas tiempo, para que un reporte pesado no compita con el trafico
 * interactivo.
 *
 * PROCAD todavia no tiene ruta: su panel corre sobre datos de prueba y la
 * unidad que debe devolver la API se define con quien lleva ese modulo.
 */
import { consultarUna } from "../../compartido/db";
import { crearRouter } from "../../compartido/router";
import { listarRegistrosGiras } from "./giras";
import { listarEstadisticas, obtenerTablero } from "./voluntariado";

export const router = crearRouter("/v1/reporteria");

/* ----------------------------- Voluntariado ----------------------------- */

router.get("/voluntariado/tablero", async () => obtenerTablero());

router.get("/voluntariado/estadisticas", async () => listarEstadisticas());

/* -------------------------------- Giras --------------------------------- */

router.get("/giras/registros", async () => listarRegistrosGiras());

/* ------------------------------ Diagnostico ----------------------------- */

router.get("/salud", async () => {
  const inicio = Date.now();
  const fila = await consultarUna<{ ahora: Date }>(`SELECT SYSDATETIME() AS ahora`);
  return {
    funcion: "voae-reporteria",
    ok: fila !== null,
    msConsulta: Date.now() - inicio,
    ahoraEnBase: fila?.ahora ?? null,
    contenedorFrio: contenedorFrio(),
  };
});

let primeraInvocacion = true;
function contenedorFrio(): boolean {
  const frio = primeraInvocacion;
  primeraInvocacion = false;
  return frio;
}
