/**
 * Rutas de voae-giras.
 *
 * Responsabilidad: ciclo de vida de las giras academicas que ve el frontend:
 * solicitudes, inscripciones y las tablas tipo que las alimentan
 * (Configuracion), mas la lectura de giras y de los usuarios que ocupan un rol.
 *
 * Quien es quien: en Giras el actor no es una persona sino un usuario-unidad
 * (idJefeMision, idJefeAprobacion, idViajero... son ids de
 * Giras.tblUsuarioUnidad). Mientras no exista capa de sesion, esos ids llegan
 * explicitos en el cuerpo o en la query, y no se confia en ellos para
 * autorizar: el rol que la pantalla muestra es del frontend.
 *
 * Los cuerpos y las respuestas usan los nombres de columna de la base
 * (destinoGira, fechaSalidaPropuesta, total...). Donde el mock del frontend
 * usa otros (destino, fecha, monto...) el cliente de API los traduce.
 *
 * Estados: se pasan y se devuelven por codigoEstado tal como esta sembrado en
 * Catalogo.tblEstados ("Pendiente", "Correccion"...), sin cambiar mayusculas.
 * Los filtros `anio` y `periodo` (1, 2 o 3 = numeroPac) salen del periodo que
 * contiene la fecha de salida: las solicitudes no guardan periodo.
 */
import { crearRouter, creado, sinContenido, type Peticion } from "../../compartido/router";
import { noEncontrado, solicitudInvalida } from "../../compartido/errores";
import {
  booleanoOpcional,
  enteroOpcional,
  enteroRequerido,
  textoOpcional,
  textoRequerido,
} from "../../compartido/validacion";
import * as catalogos from "./catalogos";
import * as consultas from "./consultas";
import * as inscripciones from "./inscripciones";
import * as solicitudes from "./solicitudes";

export const router = crearRouter("/v1/giras");

/* ------------------------------ Utilidades ------------------------------ */

const idDeRuta = (peticion: Peticion, nombre = "id") => enteroRequerido(peticion.parametros[nombre], nombre);

/** Una decision del cuerpo, comparada sin importar mayusculas con la lista canonica. */
function decisionDe<T extends string>(valor: unknown, permitidas: readonly T[]): T {
  const texto = textoRequerido(valor, "decision", 40).toLowerCase();
  const decision = permitidas.find((p) => p.toLowerCase() === texto);
  if (!decision) throw solicitudInvalida(`decision debe ser una de: ${permitidas.join(", ")}.`);
  return decision;
}

async function solicitudOFalla(id: number) {
  const solicitud = await solicitudes.obtenerSolicitud(id);
  if (!solicitud) throw noEncontrado(`No existe la solicitud ${id}.`);
  return solicitud;
}

async function inscripcionOFalla(id: number) {
  const inscripcion = await inscripciones.obtenerInscripcion(id);
  if (!inscripcion) throw noEncontrado(`No existe la inscripcion ${id}.`);
  return inscripcion;
}

/* -------------------------- Estados y usuarios --------------------------- */

const CONTEXTO_POR_SLUG: Record<string, string> = {
  solicitud: consultas.CONTEXTO.solicitud,
  gira: consultas.CONTEXTO.gira,
  inscripcion: consultas.CONTEXTO.inscripcion,
  dictamen: consultas.CONTEXTO.dictamen,
};

router.get("/estados/{contexto}", async ({ parametros }) => {
  const slug = (parametros["contexto"] ?? "").toLowerCase();
  const contexto = CONTEXTO_POR_SLUG[slug];
  if (!contexto) {
    throw noEncontrado(`No existe el contexto ${slug}. Disponibles: ${Object.keys(CONTEXTO_POR_SLUG).join(", ")}.`);
  }
  return consultas.listarEstados(contexto);
});

/** Para poblar selectores: jefes de aprobacion, docentes acompanantes, viajeros. */
router.get("/usuarios", async ({ consulta }) => {
  const rol = textoOpcional(consulta["rol"], "rol", 30)?.toLowerCase() ?? null;
  if (rol !== null && !consultas.ROLES_DISPONIBLES.includes(rol)) {
    throw solicitudInvalida(`rol debe ser uno de: ${consultas.ROLES_DISPONIBLES.join(", ")}.`);
  }
  return consultas.listarUsuariosUnidad({
    rol,
    docentes: booleanoOpcional(consulta["docentes"], "docentes") ?? false,
    idCampus: enteroOpcional(consulta["campus"], "campus"),
    busqueda: textoOpcional(consulta["q"], "q", 100),
  });
});

/* --------------------- Tablas tipo (Configuracion) ----------------------- */

router.get("/catalogos", async () => catalogos.listarTodosLosCatalogos());

router.get("/catalogos/{catalogo}", async ({ parametros, consulta }) =>
  catalogos.listarCatalogo(
    parametros["catalogo"] ?? "",
    booleanoOpcional(consulta["todos"], "todos") ?? false,
  ));

router.get("/catalogos/{catalogo}/{id}", async ({ parametros }) =>
  catalogos.obtenerRegistro(parametros["catalogo"] ?? "", parametros["id"]));

router.post("/catalogos/{catalogo}", async ({ parametros, cuerpo, usuarioRegistro }) =>
  creado(await catalogos.crearRegistro(parametros["catalogo"] ?? "", cuerpo, usuarioRegistro)));

router.put("/catalogos/{catalogo}/{id}", async ({ parametros, cuerpo }) =>
  catalogos.actualizarRegistro(parametros["catalogo"] ?? "", parametros["id"], cuerpo));

router.delete("/catalogos/{catalogo}/{id}", async ({ parametros }) => {
  await catalogos.eliminarRegistro(parametros["catalogo"] ?? "", parametros["id"]);
  return sinContenido();
});

/* ------------------------------ Solicitudes ------------------------------ */

router.get("/solicitudes", async ({ consulta }) =>
  solicitudes.listarSolicitudes({
    codigoEstado: textoOpcional(consulta["estado"], "estado", 40),
    excluirBorradores: booleanoOpcional(consulta["excluirBorradores"], "excluirBorradores") ?? false,
    idCampus: enteroOpcional(consulta["campus"], "campus"),
    anio: enteroOpcional(consulta["anio"], "anio"),
    numeroPac: enteroOpcional(consulta["periodo"], "periodo"),
    idJefeMision: enteroOpcional(consulta["jefeMision"], "jefeMision"),
    idJefeAprobacion: enteroOpcional(consulta["jefeAprobacion"], "jefeAprobacion"),
    busqueda: textoOpcional(consulta["q"], "q", 100),
  }));

router.get("/solicitudes/{id}", async (peticion) => solicitudOFalla(idDeRuta(peticion)));

/**
 * Sin `enviar` queda como Borrador. Incluso un borrador exige idJefeMision,
 * idJefeAprobacion e idCampus: son NOT NULL sin default en la base, asi que un
 * borrador "casi vacio" del frontend no cabe sin elegirlos.
 */
router.post("/solicitudes", async ({ cuerpo, usuarioRegistro }) => {
  const cambios = solicitudes.leerCuerpoSolicitud(cuerpo, true);
  const enviar = booleanoOpcional(cuerpo["enviar"], "enviar") ?? false;
  const id = await solicitudes.crearSolicitud(cambios, enviar, usuarioRegistro);
  return creado(await solicitudOFalla(id));
});

router.put("/solicitudes/{id}", async (peticion) => {
  const id = idDeRuta(peticion);
  await solicitudes.actualizarSolicitud(id, solicitudes.leerCuerpoSolicitud(peticion.cuerpo, false), peticion.usuarioRegistro);
  return solicitudOFalla(id);
});

router.delete("/solicitudes/{id}", async (peticion) => {
  await solicitudes.eliminarSolicitud(idDeRuta(peticion));
  return sinContenido();
});

router.post("/solicitudes/{id}/envio", async (peticion) => {
  const id = idDeRuta(peticion);
  await solicitudes.enviarSolicitud(id);
  return solicitudOFalla(id);
});

router.post("/solicitudes/{id}/dictamen", async (peticion) => {
  const id = idDeRuta(peticion);
  const { cuerpo } = peticion;
  const decision = decisionDe(cuerpo["decision"], solicitudes.DECISIONES_SOLICITUD);
  const justificacion = textoOpcional(cuerpo["justificacion"], "justificacion", 1000);
  const idTipoCancelacion = enteroOpcional(cuerpo["idTipoCancelacion"], "idTipoCancelacion");

  if (decision !== "Aprobada" && justificacion === null) {
    throw solicitudInvalida("Denegar o devolver a correccion una solicitud exige una justificacion.");
  }
  if (idTipoCancelacion !== null && (decision !== "Denegada" || idTipoCancelacion > 255)) {
    throw solicitudInvalida("idTipoCancelacion solo aplica a una decision Denegada y debe ser un id valido.");
  }

  await solicitudes.dictaminarSolicitud(id, {
    idJefeAprobacion: enteroRequerido(cuerpo["idJefeAprobacion"], "idJefeAprobacion"),
    decision,
    justificacion,
    idTipoCancelacion,
  }, peticion.usuarioRegistro);
  return solicitudOFalla(id);
});

/* --------------------------------- Giras --------------------------------- */

router.get("/giras", async ({ consulta }) =>
  consultas.listarGiras({
    codigoEstado: textoOpcional(consulta["estado"], "estado", 40),
    idCampus: enteroOpcional(consulta["campus"], "campus"),
    idUsuario: enteroOpcional(consulta["usuario"], "usuario"),
    numeroCuenta: textoOpcional(consulta["numeroCuenta"], "numeroCuenta", 15),
  }));

router.get("/giras/{id}", async (peticion) => {
  const id = idDeRuta(peticion);
  const gira = await consultas.obtenerGira(id);
  if (!gira) throw noEncontrado(`No existe la gira ${id}.`);
  return gira;
});

router.get("/giras/{id}/inscripciones", async (peticion) => {
  const id = idDeRuta(peticion);
  if (!(await consultas.existeGira(id))) throw noEncontrado(`No existe la gira ${id}.`);
  const { consulta } = peticion;
  return inscripciones.listarInscripciones({
    idGira: id,
    codigoEstado: textoOpcional(consulta["estado"], "estado", 40),
    excluirBorradores: booleanoOpcional(consulta["excluirBorradores"], "excluirBorradores") ?? true,
    idViajero: null,
    numeroCuenta: null,
    busqueda: textoOpcional(consulta["q"], "q", 100),
  });
});

/* ----------------------------- Inscripciones ----------------------------- */

router.get("/inscripciones", async ({ consulta }) =>
  inscripciones.listarInscripciones({
    idGira: enteroOpcional(consulta["gira"], "gira"),
    codigoEstado: textoOpcional(consulta["estado"], "estado", 40),
    excluirBorradores: booleanoOpcional(consulta["excluirBorradores"], "excluirBorradores") ?? false,
    idViajero: enteroOpcional(consulta["viajero"], "viajero"),
    numeroCuenta: textoOpcional(consulta["numeroCuenta"], "numeroCuenta", 15),
    busqueda: textoOpcional(consulta["q"], "q", 100),
  }));

router.get("/inscripciones/{id}", async (peticion) => inscripcionOFalla(idDeRuta(peticion)));

/**
 * El viajero se indica por `idViajero` (usuario-unidad) o por `numeroCuenta`,
 * que es como el frontend identifica al estudiante. Sin `enviar` queda en
 * Borrador.
 */
router.post("/inscripciones", async ({ cuerpo, usuarioRegistro }) => {
  const idGira = enteroRequerido(cuerpo["idGira"], "idGira");

  let idViajero = enteroOpcional(cuerpo["idViajero"], "idViajero");
  if (idViajero === null) {
    const numeroCuenta = textoRequerido(cuerpo["numeroCuenta"], "numeroCuenta", 15);
    idViajero = await consultas.idViajeroPorCuenta(numeroCuenta);
    if (idViajero === null) {
      throw noEncontrado(`No hay un viajero activo con el numero de cuenta ${numeroCuenta}.`);
    }
  }

  const id = await inscripciones.crearInscripcion(
    idGira,
    idViajero,
    inscripciones.leerCuerpoInscripcion(cuerpo),
    booleanoOpcional(cuerpo["enviar"], "enviar") ?? false,
    usuarioRegistro,
  );
  return creado(await inscripcionOFalla(id));
});

router.put("/inscripciones/{id}", async (peticion) => {
  const id = idDeRuta(peticion);
  await inscripciones.actualizarInscripcion(id, inscripciones.leerCuerpoInscripcion(peticion.cuerpo), peticion.usuarioRegistro);
  return inscripcionOFalla(id);
});

router.delete("/inscripciones/{id}", async (peticion) => {
  await inscripciones.eliminarInscripcion(idDeRuta(peticion));
  return sinContenido();
});

router.post("/inscripciones/{id}/envio", async (peticion) => {
  const id = idDeRuta(peticion);
  await inscripciones.enviarInscripcion(id);
  return inscripcionOFalla(id);
});

router.post("/inscripciones/{id}/dictamen", async (peticion) => {
  const id = idDeRuta(peticion);
  const { cuerpo } = peticion;
  const decision = decisionDe(cuerpo["decision"], inscripciones.DECISIONES_INSCRIPCION);
  const justificacion = textoOpcional(cuerpo["justificacion"], "justificacion", 1000);

  if (decision !== "Inscrito" && justificacion === null) {
    throw solicitudInvalida("Rechazar o devolver a correccion una inscripcion exige una justificacion.");
  }

  await inscripciones.dictaminarInscripcion(id, {
    idJefeMision: enteroRequerido(cuerpo["idJefeMision"], "idJefeMision"),
    decision,
    justificacion,
  }, peticion.usuarioRegistro);
  return inscripcionOFalla(id);
});

/* ------------------------------ Diagnostico ----------------------------- */

router.get("/salud", async () => {
  const inicio = Date.now();
  const base = await consultas.medirBaseDeDatos();
  return {
    funcion: "voae-giras",
    ...base,
    msTotal: Date.now() - inicio,
    contenedorFrio: contenedorFrio(),
  };
});

let primeraInvocacion = true;
function contenedorFrio(): boolean {
  const frio = primeraInvocacion;
  primeraInvocacion = false;
  return frio;
}
