/**
 * Rutas de voae-catalogo.
 *
 * Responsabilidad: datos de referencia transversales y resolucion de
 * identidad/perfiles. Es la funcion de la que dependen las otras tres y la
 * duenia del cache de catalogos.
 *
 * Todo aqui es lectura salvo el marcado de notificacion leida.
 */
import { crearRouter } from "../../compartido/router";
import { noEncontrado } from "../../compartido/errores";
import {
  booleanoOpcional,
  enteroOpcional,
  enteroRequerido,
  textoOpcional,
  textoRequerido,
} from "../../compartido/validacion";
import * as consultas from "./consultas";

const LIMITE_NOTIFICACIONES_POR_DEFECTO = 50;
const LIMITE_NOTIFICACIONES_MAXIMO = 200;

export const router = crearRouter("/v1/catalogo");

/* ------------------------- Tablas de referencia ------------------------- */

router.get("/campus", async ({ consulta }) => {
  const incluirInactivos = booleanoOpcional(consulta["todos"], "todos") ?? false;
  return consultas.listarCampus(incluirInactivos);
});

/**
 * Sin `contexto` devuelve los 61 estados de los 3 sistemas mezclados, que no
 * le sirve a nadie. Se permite igual porque alguna pantalla de mantenimiento
 * querra el catalogo completo, pero el uso normal filtra.
 */
router.get("/estados", async ({ consulta }) => {
  const contexto = textoOpcional(consulta["contexto"], "contexto", 40);
  return consultas.listarEstados(contexto ? contexto.toUpperCase() : null);
});

router.get("/estados/contextos", async () => consultas.listarContextosDeEstado());

router.get("/periodos", async () => consultas.listarPeriodos());

router.get("/periodos/activo", async () => {
  const periodo = await consultas.obtenerPeriodoActivo();
  if (!periodo) throw noEncontrado("No hay ningun periodo academico activo.");
  return periodo;
});

router.get("/roles", async ({ consulta }) => {
  const sistema = textoOpcional(consulta["sistema"], "sistema", 15);
  return consultas.listarRoles(sistema ? sistema.toUpperCase() : null);
});

router.get("/perfiles", async () => consultas.listarPerfiles());

router.get("/programas", async () => consultas.listarProgramas());

/* ------------------------------ Identidad ------------------------------ */

router.get("/personas/{idPersona}", async ({ parametros }) => {
  const idPersona = enteroRequerido(parametros["idPersona"], "idPersona");
  const persona = await consultas.obtenerPersona(idPersona);
  if (!persona) throw noEncontrado(`No existe la persona ${idPersona}.`);
  return persona;
});

router.get("/personas/{idPersona}/perfiles", async ({ parametros }) => {
  const idPersona = enteroRequerido(parametros["idPersona"], "idPersona");
  const persona = await consultas.obtenerPersona(idPersona);
  if (!persona) throw noEncontrado(`No existe la persona ${idPersona}.`);
  return consultas.listarPerfilesDePersona(idPersona);
});

router.get("/estudiantes/{numeroCuenta}", async ({ parametros }) => {
  const numeroCuenta = textoRequerido(parametros["numeroCuenta"], "numeroCuenta", 15);
  const estudiante = await consultas.obtenerEstudiante(numeroCuenta);
  if (!estudiante) throw noEncontrado(`No existe el estudiante ${numeroCuenta}.`);
  return estudiante;
});

router.get("/empleados/{numeroEmpleado}", async ({ parametros }) => {
  const numeroEmpleado = textoRequerido(parametros["numeroEmpleado"], "numeroEmpleado", 20);
  const empleado = await consultas.obtenerEmpleado(numeroEmpleado);
  if (!empleado) throw noEncontrado(`No existe el empleado ${numeroEmpleado}.`);
  return empleado;
});

/* --------------------------- Notificaciones ---------------------------- */

router.get("/notificaciones", async ({ consulta }) => {
  const idPersona = enteroRequerido(consulta["persona"], "persona");
  const soloNoLeidas = booleanoOpcional(consulta["noLeidas"], "noLeidas") ?? false;
  const limitePedido =
    enteroOpcional(consulta["limite"], "limite") ?? LIMITE_NOTIFICACIONES_POR_DEFECTO;

  return consultas.listarNotificaciones(
    idPersona,
    soloNoLeidas,
    Math.min(limitePedido, LIMITE_NOTIFICACIONES_MAXIMO),
  );
});

router.post("/notificaciones/{idNotificacion}/lectura", async ({ parametros }) => {
  const idNotificacion = enteroRequerido(parametros["idNotificacion"], "idNotificacion");
  const notificacion = await consultas.marcarNotificacionLeida(idNotificacion);
  if (!notificacion) throw noEncontrado(`No existe la notificacion ${idNotificacion}.`);
  return notificacion;
});

/* ------------------------------ Diagnostico ---------------------------- */

router.get("/salud", async () => {
  const inicioTotal = Date.now();
  const base = await consultas.medirBaseDeDatos();
  return {
    funcion: "voae-catalogo",
    ...base,
    msTotal: Date.now() - inicioTotal,
    // Si esta invocacion estreno el contenedor, el tiempo incluye conexion
    // TDS a Azure y lectura del secreto; si no, es solo el round trip.
    contenedorFrio: contenedorFrio(),
  };
});

let primeraInvocacion = true;
function contenedorFrio(): boolean {
  const frio = primeraInvocacion;
  primeraInvocacion = false;
  return frio;
}
