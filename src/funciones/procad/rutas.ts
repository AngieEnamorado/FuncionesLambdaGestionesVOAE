/**
 * Rutas de voae-procad.
 *
 * Responsabilidad: programa de cultura, arte y deporte (esquema Procad) —
 * solicitudes de ingreso, agrupaciones, actividades, visorias, expulsiones y
 * configuracion de periodos.
 *
 * Las reglas de negocio viven en los triggers de Procad y en sus dos
 * procedimientos (spGenerarActividadesSerie, spActivarNuevoPeriodo). Aqui se
 * valida la forma de la entrada, se llama a la base y se deja que ella decida.
 *
 * Quien es quien: mientras no exista capa de sesion, las personas que actuan
 * (quien resuelve, quien valida, quien propone...) llegan como ids explicitos
 * en el cuerpo. No se confia en ellos para autorizar: los triggers comprueban
 * que esa persona tenga el rol que la operacion exige.
 *
 * Los cuerpos y las respuestas usan los nombres de columna de la base. Los
 * estados se pasan por codigoEstado (PENDIENTE, APROBADO...). Los datos
 * transversales (campus, estados, periodos, personas) no se repiten aqui: los
 * sirve voae-catalogo.
 */
import { crearRouter, creado, type Peticion } from "../../compartido/router";
import { consultarUna } from "../../compartido/db";
import { solicitudInvalida } from "../../compartido/errores";
import {
  booleanoOpcional,
  enteroOpcional,
  enteroRequerido,
  textoOpcional,
  textoRequerido,
} from "../../compartido/validacion";
import * as actividades from "./actividades";
import * as catalogos from "./catalogos";
import {
  decisionDe,
  estadoOpcional,
  fechaOpcional,
  fechaRequerida,
  horaOpcional,
  listaDeIds,
  listaDeObjetos,
} from "./entrada";
import * as grupos from "./grupos";
import * as listas from "./listas";
import * as solicitudes from "./solicitudes";
import * as visorias from "./visorias";

export const router = crearRouter("/v1/procad");

/* ------------------------------ Utilidades ------------------------------ */

const idDeRuta = (peticion: Peticion, nombre = "id") => enteroRequerido(peticion.parametros[nombre], nombre);

/** `?todos=true` incluye inactivos, igual que en voae-catalogo y voae-giras. */
const incluirInactivos = (consulta: Record<string, string>) =>
  booleanoOpcional(consulta["todos"], "todos") ?? false;

function tipoGrupoOpcional(valor: unknown): string | null {
  const texto = textoOpcional(valor, "tipoGrupo", 20)?.toLowerCase() ?? null;
  if (texto !== null && !(grupos.TIPOS_GRUPO as readonly string[]).includes(texto)) {
    throw solicitudInvalida(`tipoGrupo debe ser uno de: ${grupos.TIPOS_GRUPO.join(", ")}.`);
  }
  return texto;
}

/* ------------------------------ Catalogos ------------------------------- */

router.get("/catalogos", async ({ consulta }) => catalogos.listarCatalogos(incluirInactivos(consulta)));

/* ------------------------------ Solicitudes ------------------------------ */

router.get("/solicitudes", async ({ consulta }) =>
  solicitudes.listarSolicitudes({
    campus: enteroOpcional(consulta["campus"], "campus"),
    tipoGrupo: tipoGrupoOpcional(consulta["tipoGrupo"]),
    grupo: enteroOpcional(consulta["grupo"], "grupo"),
    estado: estadoOpcional(consulta["estado"], solicitudes.ESTADOS_SOLICITUD),
    periodo: enteroOpcional(consulta["periodo"], "periodo"),
    texto: textoOpcional(consulta["q"], "q", 100),
  }),
);

router.get("/solicitudes/{id}", async (peticion) => solicitudes.obtenerSolicitud(idDeRuta(peticion)));

router.post("/solicitudes/{id}/resolucion", async (peticion) => {
  const { cuerpo } = peticion;
  return solicitudes.resolverSolicitud(
    idDeRuta(peticion),
    {
      decision: decisionDe(cuerpo["decision"], solicitudes.DECISIONES_SOLICITUD),
      idPersona: enteroRequerido(cuerpo["idPersona"], "idPersona"),
      observacion: textoOpcional(cuerpo["observacion"], "observacion", 300),
    },
    peticion.usuarioRegistro,
  );
});

router.put("/solicitudes/{id}/equipo", async (peticion) => {
  const esEquipo = booleanoOpcional(peticion.cuerpo["esEquipo"], "esEquipo");
  if (esEquipo === null) throw solicitudInvalida("El campo esEquipo es obligatorio: true o false.");
  return solicitudes.marcarEquipo(idDeRuta(peticion), esEquipo);
});

/* ----------------------------- Condicionados ----------------------------- */

router.get("/condicionados", async ({ consulta }) =>
  solicitudes.listarCondicionados({
    estado: estadoOpcional(consulta["estado"], solicitudes.ESTADOS_CONDICIONADO),
    grupo: enteroOpcional(consulta["grupo"], "grupo"),
    campus: enteroOpcional(consulta["campus"], "campus"),
    periodo: enteroOpcional(consulta["periodo"], "periodo"),
  }),
);

/** Paso 1: el director interno del grupo propone la excepcion. */
router.post("/condicionados", async ({ cuerpo }) =>
  creado(await solicitudes.proponerCondicionado(
    enteroRequerido(cuerpo["idSolicitud"], "idSolicitud"),
    enteroRequerido(cuerpo["idPersonaPropone"], "idPersonaPropone"),
  )),
);

/** Paso 2: el administrador la autoriza. El id es el de la solicitud. */
router.post("/condicionados/{id}/autorizacion", async (peticion) =>
  solicitudes.autorizarCondicionado(
    idDeRuta(peticion),
    enteroRequerido(peticion.cuerpo["idPersonaAutoriza"], "idPersonaAutoriza"),
  ),
);

/* ------------------------------ Expulsiones ------------------------------ */

router.get("/expulsiones", async ({ consulta }) =>
  solicitudes.listarExpulsiones({
    estado: estadoOpcional(consulta["estado"], solicitudes.ESTADOS_EXPULSION),
    grupo: enteroOpcional(consulta["grupo"], "grupo"),
    campus: enteroOpcional(consulta["campus"], "campus"),
  }),
);

router.get("/expulsiones/{id}", async (peticion) => solicitudes.obtenerExpulsion(idDeRuta(peticion)));

router.post("/expulsiones", async ({ cuerpo, usuarioRegistro }) =>
  creado(await solicitudes.solicitarExpulsion({
    idSolicitud: enteroRequerido(cuerpo["idSolicitud"], "idSolicitud"),
    idPersonaSolicita: enteroRequerido(cuerpo["idPersonaSolicita"], "idPersonaSolicita"),
    idMotivoExpulsion: enteroRequerido(cuerpo["idMotivoExpulsion"], "idMotivoExpulsion"),
    detalleMotivo: textoOpcional(cuerpo["detalleMotivo"], "detalleMotivo", 300),
  }, usuarioRegistro)),
);

router.post("/expulsiones/{id}/resolucion", async (peticion) => {
  const { cuerpo } = peticion;
  return solicitudes.resolverExpulsion(
    idDeRuta(peticion),
    {
      decision: decisionDe(cuerpo["decision"], solicitudes.DECISIONES_EXPULSION),
      idPersonaResuelve: enteroRequerido(cuerpo["idPersonaResuelve"], "idPersonaResuelve"),
      observacion: textoOpcional(cuerpo["observacion"], "observacion", 300),
    },
    peticion.usuarioRegistro,
  );
});

/* ------------------------ Matriculas excepcionales ------------------------ */

router.get("/matriculas-excepcionales", async ({ consulta }) =>
  solicitudes.listarMatriculasExcepcionales({
    periodo: enteroOpcional(consulta["periodo"], "periodo"),
    soloActivas: !incluirInactivos(consulta),
  }),
);

router.post("/matriculas-excepcionales", async ({ cuerpo, usuarioRegistro }) =>
  creado(await solicitudes.crearMatriculaExcepcional({
    idPersona: enteroRequerido(cuerpo["idPersona"], "idPersona"),
    idPeriodo: enteroRequerido(cuerpo["idPeriodo"], "idPeriodo"),
    motivoExcepcion: textoRequerido(cuerpo["motivoExcepcion"], "motivoExcepcion", 300),
    idPersonaAutoriza: enteroRequerido(cuerpo["idPersonaAutoriza"], "idPersonaAutoriza"),
  }, usuarioRegistro)),
);

/* --------------------------------- Grupos -------------------------------- */

router.get("/grupos", async ({ consulta }) =>
  grupos.listarGrupos({
    campus: enteroOpcional(consulta["campus"], "campus"),
    tipoGrupo: tipoGrupoOpcional(consulta["tipoGrupo"]),
    esSeleccion: booleanoOpcional(consulta["seleccion"], "seleccion"),
    incluirInactivos: incluirInactivos(consulta),
    periodo: enteroOpcional(consulta["periodo"], "periodo"),
  }),
);

router.get("/grupos/{id}", async (peticion) => grupos.obtenerGrupo(idDeRuta(peticion)));

/**
 * Lee los campos del grupo que vinieron en el cuerpo. En el alta son
 * obligatorios nombre, tipo y campus; en la edicion todo es opcional y el
 * tipo no se cambia, porque arrastra disciplinas y tipos de actividad.
 */
function leerGrupo(cuerpo: Record<string, unknown>, esAlta: boolean): grupos.DatosGrupo {
  const datos: grupos.DatosGrupo = {};
  const vino = (campo: string) => campo in cuerpo;

  if (esAlta || vino("nombreGrupo")) datos.nombreGrupo = textoRequerido(cuerpo["nombreGrupo"], "nombreGrupo", 150);
  if (esAlta) datos.idTipoGrupo = enteroRequerido(cuerpo["idTipoGrupo"], "idTipoGrupo");
  else if (vino("idTipoGrupo")) {
    throw solicitudInvalida("El tipo de un grupo no se cambia una vez creado: arrastra sus disciplinas y tipos de actividad.");
  }
  if (esAlta || vino("idCampus")) datos.idCampus = enteroRequerido(cuerpo["idCampus"], "idCampus");
  if (vino("idDeporte")) datos.idDeporte = enteroOpcional(cuerpo["idDeporte"], "idDeporte");

  if (vino("categoriaSexo")) {
    const categoria = textoRequerido(cuerpo["categoriaSexo"], "categoriaSexo", 20).toLowerCase();
    if (!(grupos.CATEGORIAS_SEXO as readonly string[]).includes(categoria)) {
      throw solicitudInvalida(`categoriaSexo debe ser una de: ${grupos.CATEGORIAS_SEXO.join(", ")}.`);
    }
    datos.categoriaSexo = categoria;
  }

  for (const [campo, destino] of [["esSeleccion", "esSeleccion"], ["activo", "activo"]] as const) {
    if (!vino(campo)) continue;
    const valor = booleanoOpcional(cuerpo[campo], campo);
    if (valor === null) throw solicitudInvalida(`El campo ${campo} debe ser true o false.`);
    datos[destino] = valor;
  }

  if (vino("disciplinas")) datos.disciplinas = listaDeIds(cuerpo["disciplinas"], "disciplinas");
  if (vino("tiposActividad")) datos.tiposActividad = listaDeIds(cuerpo["tiposActividad"], "tiposActividad");
  return datos;
}

router.post("/grupos", async ({ cuerpo, usuarioRegistro }) =>
  creado(await grupos.crearGrupo(leerGrupo(cuerpo, true), usuarioRegistro)),
);

router.put("/grupos/{id}", async (peticion) => {
  const datos = leerGrupo(peticion.cuerpo, false);
  if (Object.keys(datos).length === 0) throw solicitudInvalida("No se envio ningun campo para modificar.");
  return grupos.actualizarGrupo(idDeRuta(peticion), datos, peticion.usuarioRegistro);
});

router.get("/grupos/{id}/integrantes", async (peticion) =>
  grupos.listarIntegrantes(idDeRuta(peticion), enteroOpcional(peticion.consulta["periodo"], "periodo")),
);

/* ------------------------------ Actividades ------------------------------ */

router.get("/actividades", async ({ consulta }) =>
  actividades.listarActividades({
    grupo: enteroOpcional(consulta["grupo"], "grupo"),
    periodo: enteroOpcional(consulta["periodo"], "periodo"),
    campus: enteroOpcional(consulta["campus"], "campus"),
    estado: estadoOpcional(consulta["estado"], actividades.ESTADOS_ACTIVIDAD),
    serie: enteroOpcional(consulta["serie"], "serie"),
    desde: fechaOpcional(consulta["desde"], "desde"),
    hasta: fechaOpcional(consulta["hasta"], "hasta"),
  }),
);

router.post("/actividades", async ({ cuerpo, usuarioRegistro }) =>
  creado(await actividades.crearActividad({
    idGrupo: enteroRequerido(cuerpo["idGrupo"], "idGrupo"),
    idPeriodo: enteroRequerido(cuerpo["idPeriodo"], "idPeriodo"),
    fechaActividad: fechaRequerida(cuerpo["fechaActividad"], "fechaActividad"),
    idTipoActividad: enteroOpcional(cuerpo["idTipoActividad"], "idTipoActividad"),
    descripcionActividad: textoOpcional(cuerpo["descripcionActividad"], "descripcionActividad", 300),
  }, usuarioRegistro)),
);

router.get("/actividades/{id}", async (peticion) => actividades.obtenerActividad(idDeRuta(peticion)));

router.post("/actividades/{id}/validacion", async (peticion) => {
  const { cuerpo } = peticion;
  return actividades.validarActividad(idDeRuta(peticion), {
    decision: decisionDe(cuerpo["decision"], actividades.DECISIONES_ACTIVIDAD),
    idPersonaValidadora: enteroRequerido(cuerpo["idPersonaValidadora"], "idPersonaValidadora"),
    observacion: textoOpcional(cuerpo["observacion"], "observacion", 300),
  });
});

router.get("/actividades/{id}/asistencia", async (peticion) =>
  actividades.listarAsistencia(idDeRuta(peticion)),
);

router.post("/actividades/{id}/asistencia", async (peticion) => {
  const marcas = listaDeObjetos(peticion.cuerpo["asistencias"], "asistencias", (fila, etiqueta) => ({
    idSolicitud: enteroRequerido(fila["idSolicitud"], `${etiqueta}.idSolicitud`),
    asistio: booleanoOpcional(fila["asistio"], `${etiqueta}.asistio`),
    esExcusado: booleanoOpcional(fila["esExcusado"], `${etiqueta}.esExcusado`) ?? false,
    justificacionExcusa: textoOpcional(fila["justificacionExcusa"], `${etiqueta}.justificacionExcusa`, 300),
    idPersonaValidaExcusa: enteroOpcional(fila["idPersonaValidaExcusa"], `${etiqueta}.idPersonaValidaExcusa`),
  }));
  if (marcas.length === 0) throw solicitudInvalida("asistencias debe traer al menos un estudiante.");
  const repetida = marcas.find((m, i) => marcas.findIndex((o) => o.idSolicitud === m.idSolicitud) !== i);
  if (repetida) throw solicitudInvalida(`La solicitud ${repetida.idSolicitud} viene repetida en asistencias.`);
  return actividades.registrarAsistencia(idDeRuta(peticion), marcas, peticion.usuarioRegistro);
});

/* --------------------------------- Series -------------------------------- */

/** El SP recorre las fechas con recursion limitada a 366 niveles: un rango mayor lo haria fallar. */
const MAXIMO_DIAS_SERIE = 366;

router.post("/series", async ({ cuerpo, usuarioRegistro }) => {
  const inicio = fechaRequerida(cuerpo["fechaInicioSerie"], "fechaInicioSerie");
  const fin = fechaRequerida(cuerpo["fechaFinSerie"], "fechaFinSerie");
  const dias = (Date.parse(fin) - Date.parse(inicio)) / 86_400_000;
  if (dias < 0) throw solicitudInvalida("fechaFinSerie no puede ser anterior a fechaInicioSerie.");
  if (dias > MAXIMO_DIAS_SERIE) {
    throw solicitudInvalida(`Una serie no puede abarcar mas de ${MAXIMO_DIAS_SERIE} dias.`);
  }

  const diasSemana = listaDeIds(cuerpo["diasSemana"], "diasSemana");
  if (diasSemana.length === 0) throw solicitudInvalida("diasSemana debe traer al menos un dia (1 = lunes ... 7 = domingo).");
  if (diasSemana.some((d) => d > 7)) throw solicitudInvalida("diasSemana solo admite valores de 1 (lunes) a 7 (domingo).");

  return creado(await actividades.crearSerie({
    idGrupo: enteroRequerido(cuerpo["idGrupo"], "idGrupo"),
    idPeriodo: enteroRequerido(cuerpo["idPeriodo"], "idPeriodo"),
    idTipoActividad: enteroOpcional(cuerpo["idTipoActividad"], "idTipoActividad"),
    fechaInicioSerie: inicio,
    fechaFinSerie: fin,
    horaSerie: horaOpcional(cuerpo["horaSerie"], "horaSerie"),
    descripcionSerie: textoOpcional(cuerpo["descripcionSerie"], "descripcionSerie", 300),
    diasSemana,
  }, usuarioRegistro));
});

router.get("/series/{id}", async (peticion) => actividades.obtenerSerie(idDeRuta(peticion)));

/* -------------------------------- Periodos ------------------------------- */

router.post("/periodos/activar", async ({ cuerpo, usuarioRegistro }) => {
  const anterior = enteroRequerido(cuerpo["idPeriodoAnterior"], "idPeriodoAnterior");
  const nuevo = enteroRequerido(cuerpo["idPeriodoNuevo"], "idPeriodoNuevo");
  if (anterior === nuevo) throw solicitudInvalida("idPeriodoAnterior e idPeriodoNuevo deben ser distintos.");
  return actividades.activarPeriodo(anterior, nuevo, usuarioRegistro);
});

router.get("/periodos/configuracion", async ({ consulta }) =>
  grupos.listarConfiguraciones({
    periodo: enteroOpcional(consulta["periodo"], "periodo"),
    grupo: enteroOpcional(consulta["grupo"], "grupo"),
    campus: enteroOpcional(consulta["campus"], "campus"),
  }),
);

router.put("/periodos/configuracion", async ({ cuerpo, usuarioRegistro }) => {
  const porcentaje = enteroOpcional(cuerpo["porcentajeMinimoEntrenamientos"], "porcentajeMinimoEntrenamientos");
  if (porcentaje !== null && porcentaje > 100) {
    throw solicitudInvalida("porcentajeMinimoEntrenamientos debe estar entre 1 y 100.");
  }
  return grupos.guardarConfiguracion({
    idGrupo: enteroRequerido(cuerpo["idGrupo"], "idGrupo"),
    idPeriodo: enteroRequerido(cuerpo["idPeriodo"], "idPeriodo"),
    minimoActividades: enteroOpcional(cuerpo["minimoActividades"], "minimoActividades"),
    minimoActividadesPorMes: enteroOpcional(cuerpo["minimoActividadesPorMes"], "minimoActividadesPorMes"),
    porcentajeMinimoEntrenamientos: porcentaje,
  }, usuarioRegistro);
});

/* -------------------------------- Visorias ------------------------------- */

router.get("/visorias", async ({ consulta }) =>
  visorias.listarVisorias({
    periodo: enteroOpcional(consulta["periodo"], "periodo"),
    campus: enteroOpcional(consulta["campus"], "campus"),
    desde: fechaOpcional(consulta["desde"], "desde"),
    hasta: fechaOpcional(consulta["hasta"], "hasta"),
  }),
);

router.get("/visorias/{id}", async (peticion) => visorias.obtenerVisoria(idDeRuta(peticion)));

router.post("/visorias", async ({ cuerpo, usuarioRegistro }) =>
  creado(await visorias.crearVisoria({
    idPeriodo: enteroRequerido(cuerpo["idPeriodo"], "idPeriodo"),
    idCampus: enteroRequerido(cuerpo["idCampus"], "idCampus"),
    fechaVisoria: fechaRequerida(cuerpo["fechaVisoria"], "fechaVisoria"),
    horaVisoria: horaOpcional(cuerpo["horaVisoria"], "horaVisoria"),
    idLugarVisoria: enteroOpcional(cuerpo["idLugarVisoria"], "idLugarVisoria"),
    idAula: enteroOpcional(cuerpo["idAula"], "idAula"),
  }, usuarioRegistro)),
);

router.post("/visorias/{id}/citados", async (peticion) => {
  const ids = listaDeIds(peticion.cuerpo["solicitudes"], "solicitudes");
  if (ids.length === 0) throw solicitudInvalida("solicitudes debe traer al menos una solicitud a citar.");
  return visorias.citarEstudiantes(idDeRuta(peticion), ids);
});

/* -------------------------- Listas preferenciales ------------------------- */

router.get("/listas-preferenciales", async ({ consulta }) =>
  listas.listarListas({
    grupo: enteroOpcional(consulta["grupo"], "grupo"),
    campus: enteroOpcional(consulta["campus"], "campus"),
    periodo: enteroOpcional(consulta["periodo"], "periodo"),
    estado: estadoOpcional(consulta["estado"], listas.ESTADOS_LISTA),
  }),
);

router.get("/listas-preferenciales/{id}", async (peticion) => listas.obtenerLista(idDeRuta(peticion)));

router.post("/listas-preferenciales", async ({ cuerpo, usuarioRegistro }) =>
  creado(await listas.generarLista({
    idGrupo: enteroRequerido(cuerpo["idGrupo"], "idGrupo"),
    idPeriodoEvaluado: enteroRequerido(cuerpo["idPeriodoEvaluado"], "idPeriodoEvaluado"),
    idPeriodoAplicacion: enteroRequerido(cuerpo["idPeriodoAplicacion"], "idPeriodoAplicacion"),
  }, usuarioRegistro)),
);

router.post("/listas-preferenciales/{id}/envio", async (peticion) => listas.enviarLista(idDeRuta(peticion)));

/* --------------------------- PROSENE y accesos ---------------------------- */

router.get("/prosene", async ({ consulta }) => grupos.listarProsene(incluirInactivos(consulta)));

router.get("/accesos", async ({ consulta }) =>
  grupos.listarAccesos({
    grupo: enteroOpcional(consulta["grupo"], "grupo"),
    campus: enteroOpcional(consulta["campus"], "campus"),
    persona: enteroOpcional(consulta["persona"], "persona"),
    incluirInactivos: incluirInactivos(consulta),
  }),
);

/* -------------------------------- Salud --------------------------------- */

router.get("/salud", async () => {
  const inicio = Date.now();
  const fila = await consultarUna<{ ahora: Date }>("SELECT SYSDATETIME() AS ahora");
  return {
    funcion: "voae-procad",
    ok: fila !== null,
    msConsulta: Date.now() - inicio,
    ahoraEnBase: fila?.ahora ?? null,
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
