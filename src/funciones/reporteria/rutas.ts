/**
 * Rutas de voae-reporteria.
 *
 * Agregaciones para los paneles de estadisticas. Por ahora solo sirve a
 * Voluntariado; Giras y PROCAD se agregan cuando lo acuerden quienes llevan
 * esos modulos. Solo lee: no hay un solo INSERT ni UPDATE aqui.
 *
 * Va aparte de las funciones de dominio por su perfil de recursos: mas
 * memoria y mas tiempo, para que un reporte pesado no compita con el trafico
 * interactivo.
 */
import { consultarUna } from "../../compartido/db";
import { crearRouter } from "../../compartido/router";
import { listarEstadisticas, obtenerTablero } from "./voluntariado";

export const router = crearRouter("/v1/reporteria");

/* ----------------------------- Voluntariado ----------------------------- */

router.get("/voluntariado/tablero", async () => obtenerTablero());

router.get("/voluntariado/estadisticas", async () => listarEstadisticas());

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
