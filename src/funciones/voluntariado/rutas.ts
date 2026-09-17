/**
 * Rutas de voae-voluntariado.
 *
 * Dos audiencias sobre el mismo esquema: el panel administrativo de la VOAE y
 * el portal del estudiante. Son pantallas distintas en el frontend pero los
 * mismos datos, asi que comparten funcion.
 *
 * Quien resuelve que: la VOAE dictamina las solicitudes de grupo nuevo y
 * aprueba actividades; el coordinador del grupo resuelve las solicitudes de
 * union a su grupo.
 */
import { crearRouter, creado, type Peticion } from "../../compartido/router";
import { noEncontrado, solicitudInvalida } from "../../compartido/errores";
import {
  booleanoOpcional,
  enteroOpcional,
  enteroRequerido,
  textoOpcional,
  textoRequerido,
} from "../../compartido/validacion";
import * as consultas from "./consultas";

export const router = crearRouter("/v1/voluntariado");

const UMBRAL_DIPLOMA_POR_DEFECTO = 80;

/** Traduce ?estado=APROBADA a su idEstado dentro del contexto que toque. */
async function idEstadoDeConsulta(
  peticion: Peticion,
  contexto: string,
): Promise<number | null> {
  const codigo = textoOpcional(peticion.consulta["estado"], "estado", 40);
  return codigo === null ? null : consultas.idEstado(contexto, codigo.toUpperCase());
}

function codigoRequerido(peticion: Peticion, permitidos: string[]): string {
  const codigo = textoRequerido(peticion.cuerpo["estado"], "estado", 40).toUpperCase();
  if (!permitidos.includes(codigo)) {
    throw solicitudInvalida(`estado debe ser uno de: ${permitidos.join(", ")}.`);
  }
  return codigo;
}

function lista(valor: unknown, nombre: string): unknown[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor)) throw solicitudInvalida(`${nombre} debe ser una lista.`);
  return valor;
}

async function exigirGrupo(idGrupo: number): Promise<void> {
  if (!(await consultas.existeGrupo(idGrupo))) {
    throw noEncontrado(`No existe el grupo ${idGrupo}.`);
  }
}

/* ------------------------------ Catalogos ------------------------------- */

router.get("/catalogos", async () => consultas.listarCatalogos());

/* -------------------------------- Grupos -------------------------------- */

router.get("/grupos", async ({ consulta }) =>
  consultas.listarGrupos(
    enteroOpcional(consulta["campus"], "campus"),
    enteroOpcional(consulta["red"], "red"),
  ));

router.get("/grupos/{idGrupo}", async ({ parametros }) => {
  const idGrupo = enteroRequerido(parametros["idGrupo"], "idGrupo");
  const grupo = await consultas.obtenerGrupo(idGrupo);
  if (!grupo) throw noEncontrado(`No existe el grupo ${idGrupo}.`);
  return grupo;
});

router.get("/grupos/{idGrupo}/miembros", async ({ parametros, consulta }) => {
  const idGrupo = enteroRequerido(parametros["idGrupo"], "idGrupo");
  await exigirGrupo(idGrupo);
  const soloActivos = booleanoOpcional(consulta["activos"], "activos") ?? true;
  return consultas.listarMiembros(idGrupo, soloActivos);
});

router.get("/grupos/{idGrupo}/campus", async ({ parametros }) => {
  const idGrupo = enteroRequerido(parametros["idGrupo"], "idGrupo");
  await exigirGrupo(idGrupo);
  return consultas.listarCampusDeGrupo(idGrupo);
});

/* ------------------- Solicitudes de grupos nuevos ----------------------- */

router.get("/solicitudes-grupos", async (peticion) =>
  consultas.listarSolicitudesGrupos(
    await idEstadoDeConsulta(peticion, "VOL_SOLICITUD_GRUPO"),
    enteroOpcional(peticion.consulta["campus"], "campus"),
  ));

router.get("/solicitudes-grupos/{id}", async ({ parametros }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const solicitud = await consultas.obtenerSolicitudGrupo(id);
  if (!solicitud) throw noEncontrado(`No existe la solicitud ${id}.`);
  return solicitud;
});

router.post("/solicitudes-grupos", async ({ cuerpo, usuarioRegistro }) => {
  const juntaDirectiva = lista(cuerpo["juntaDirectiva"], "juntaDirectiva").map((fila, indice) => {
    const cargo = fila as Record<string, unknown>;
    return {
      numeroCuenta: textoRequerido(cargo["numeroCuenta"], `juntaDirectiva[${indice}].numeroCuenta`, 15),
      idCargo: enteroRequerido(cargo["idCargo"], `juntaDirectiva[${indice}].idCargo`),
    };
  });

  const actividadesProyectadas = lista(cuerpo["actividadesProyectadas"], "actividadesProyectadas")
    .map((fila, indice) => {
      const actividad = fila as Record<string, unknown>;
      return {
        nombreActividad: textoRequerido(actividad["nombreActividad"], `actividadesProyectadas[${indice}].nombreActividad`, 200),
        objetivoActividad: textoOpcional(actividad["objetivoActividad"], `actividadesProyectadas[${indice}].objetivoActividad`, 4000),
        fechaTentativa: textoOpcional(actividad["fechaTentativa"], `actividadesProyectadas[${indice}].fechaTentativa`, 10),
      };
    });

  const idSolicitud = await consultas.crearSolicitudGrupo({
    idPersonaSolicitante: enteroRequerido(cuerpo["idPersonaSolicitante"], "idPersonaSolicitante"),
    idCampus: enteroRequerido(cuerpo["idCampus"], "idCampus"),
    nombreGrupo: textoRequerido(cuerpo["nombreGrupo"], "nombreGrupo", 150),
    fechaCreacionGrupo: textoOpcional(cuerpo["fechaCreacionGrupo"], "fechaCreacionGrupo", 10),
    colaboraOtrasUnidades: booleanoOpcional(cuerpo["colaboraOtrasUnidades"], "colaboraOtrasUnidades") ?? false,
    detalleColaboracion: textoOpcional(cuerpo["detalleColaboracion"], "detalleColaboracion", 4000),
    resenaHistorica: textoOpcional(cuerpo["resenaHistorica"], "resenaHistorica", 4000),
    propositoGrupo: textoOpcional(cuerpo["propositoGrupo"], "propositoGrupo", 4000),
    misionGrupo: textoOpcional(cuerpo["misionGrupo"], "misionGrupo", 4000),
    visionGrupo: textoOpcional(cuerpo["visionGrupo"], "visionGrupo", 4000),
    edadSolicitante: enteroOpcional(cuerpo["edadSolicitante"], "edadSolicitante"),
    dniSolicitante: textoOpcional(cuerpo["dniSolicitante"], "dniSolicitante", 20),
    celularSolicitante: textoOpcional(cuerpo["celularSolicitante"], "celularSolicitante", 30),
    direccionSolicitante: textoOpcional(cuerpo["direccionSolicitante"], "direccionSolicitante", 300),
    fundadores: lista(cuerpo["fundadores"], "fundadores").map((cuenta, indice) =>
      textoRequerido(cuenta, `fundadores[${indice}]`, 15)),
    juntaDirectiva,
    actividadesProyectadas,
  }, usuarioRegistro);

  return creado(await consultas.obtenerSolicitudGrupo(idSolicitud));
});

router.post("/solicitudes-grupos/{id}/resolucion", async ({ parametros, cuerpo, usuarioRegistro }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const estado = codigoRequerido({ cuerpo } as Peticion, ["APROBADA", "RECHAZADA", "DEVUELTA"]);
  const motivo = textoOpcional(cuerpo["motivo"], "motivo", 4000);

  if (estado !== "APROBADA" && motivo === null) {
    throw solicitudInvalida("Rechazar o devolver una solicitud exige un motivo.");
  }
  return consultas.resolverSolicitudGrupo(id, estado, motivo, usuarioRegistro);
});

router.post("/solicitudes-grupos/{id}/adjuntos", async ({ parametros, cuerpo, usuarioRegistro }) => {
  const id = enteroRequerido(parametros["id"], "id");
  // La base guarda la llave del objeto en S3, nunca el binario.
  const adjunto = await consultas.agregarAdjuntoSolicitud(
    id,
    enteroRequerido(cuerpo["idRequisitoAdjunto"], "idRequisitoAdjunto"),
    textoRequerido(cuerpo["archivoUrl"], "archivoUrl", 300),
    usuarioRegistro,
  );
  return creado(adjunto);
});

/* ------------------------- Solicitudes de union ------------------------- */

router.get("/grupos/{idGrupo}/solicitudes-union", async (peticion) => {
  const idGrupo = enteroRequerido(peticion.parametros["idGrupo"], "idGrupo");
  await exigirGrupo(idGrupo);
  return consultas.listarSolicitudesUnion(
    idGrupo,
    await idEstadoDeConsulta(peticion, "VOL_SOLICITUD_UNION"),
  );
});

router.post("/grupos/{idGrupo}/solicitudes-union", async ({ parametros, cuerpo, usuarioRegistro }) => {
  const idGrupo = enteroRequerido(parametros["idGrupo"], "idGrupo");
  await exigirGrupo(idGrupo);
  return creado(await consultas.crearSolicitudUnion(
    idGrupo,
    enteroRequerido(cuerpo["idPersona"], "idPersona"),
    textoOpcional(cuerpo["mensaje"], "mensaje", 500),
    usuarioRegistro,
  ));
});

router.post("/solicitudes-union/{id}/resolucion", async ({ parametros, cuerpo, usuarioRegistro }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const estado = codigoRequerido({ cuerpo } as Peticion, ["APROBADA", "RECHAZADA"]);
  return consultas.resolverSolicitudUnion(
    id,
    estado,
    enteroOpcional(cuerpo["idPersonaResuelve"], "idPersonaResuelve"),
    textoOpcional(cuerpo["motivo"], "motivo", 4000),
    usuarioRegistro,
  );
});

/* ------------------------------ Actividades ----------------------------- */

router.get("/actividades", async (peticion) =>
  consultas.listarActividades({
    idGrupo: enteroOpcional(peticion.consulta["grupo"], "grupo"),
    idTrimestre: enteroOpcional(peticion.consulta["trimestre"], "trimestre"),
    idPeriodo: enteroOpcional(peticion.consulta["periodo"], "periodo"),
    idEstado: await idEstadoDeConsulta(peticion, "VOL_ACTIVIDAD"),
  }));

router.get("/actividades/{id}", async ({ parametros }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const actividad = await consultas.obtenerActividad(id);
  if (!actividad) throw noEncontrado(`No existe la actividad ${id}.`);
  return actividad;
});

router.post("/actividades", async ({ cuerpo, usuarioRegistro }) => {
  const idActividad = await consultas.crearActividad({
    idGrupoOrganizador: enteroRequerido(cuerpo["idGrupoOrganizador"], "idGrupoOrganizador"),
    idPeriodo: enteroRequerido(cuerpo["idPeriodo"], "idPeriodo"),
    idTrimestre: enteroRequerido(cuerpo["idTrimestre"], "idTrimestre"),
    nombreActividad: textoRequerido(cuerpo["nombreActividad"], "nombreActividad", 200),
    objetivoActividad: textoRequerido(cuerpo["objetivoActividad"], "objetivoActividad", 4000),
    fechaActividad: textoOpcional(cuerpo["fechaActividad"], "fechaActividad", 10),
    lugarActividad: textoOpcional(cuerpo["lugarActividad"], "lugarActividad", 200),
    coorganizadores: lista(cuerpo["coorganizadores"], "coorganizadores").map((id, indice) =>
      enteroRequerido(id, `coorganizadores[${indice}]`)),
  }, usuarioRegistro);

  return creado(await consultas.obtenerActividad(idActividad));
});

router.post("/actividades/{id}/aprobacion", async ({ parametros, cuerpo }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const estado = codigoRequerido({ cuerpo } as Peticion,
    ["APROBADA", "RECHAZADA", "EJECUTADA", "CANCELADA"]);
  const actividad = await consultas.resolverActividad(id, estado);
  if (!actividad) throw noEncontrado(`No existe la actividad ${id}.`);
  return actividad;
});

router.put("/actividades/{id}/resultados", async ({ parametros, cuerpo }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const actividad = await consultas.guardarResultados(
    id,
    textoRequerido(cuerpo["resultados"], "resultados", 8000),
  );
  if (!actividad) throw noEncontrado(`No existe la actividad ${id}.`);
  return actividad;
});

router.post("/actividades/{id}/fotos", async ({ parametros, cuerpo, usuarioRegistro }) => {
  const id = enteroRequerido(parametros["id"], "id");
  return creado(await consultas.agregarFoto(
    id,
    textoRequerido(cuerpo["archivoUrl"], "archivoUrl", 300),
    textoOpcional(cuerpo["descripcion"], "descripcion", 200),
    enteroOpcional(cuerpo["idRequisitoAdjunto"], "idRequisitoAdjunto"),
    usuarioRegistro,
  ));
});

/* ----------------------------- Participaciones -------------------------- */

router.get("/actividades/{id}/participaciones", async ({ parametros }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const actividad = await consultas.obtenerActividad(id);
  if (!actividad) throw noEncontrado(`No existe la actividad ${id}.`);
  return consultas.listarParticipaciones(id);
});

/**
 * Pasar lista. De aqui salen las horas confirmadas de cada estudiante, que
 * son las que despues deciden su diploma.
 */
router.post("/actividades/{id}/asistencia", async ({ parametros, cuerpo, usuarioRegistro }) => {
  const idActividad = enteroRequerido(parametros["id"], "id");
  const actividad = await consultas.obtenerActividad(idActividad);
  if (!actividad) throw noEncontrado(`No existe la actividad ${idActividad}.`);

  const filas = lista(cuerpo["participaciones"], "participaciones");
  if (filas.length === 0) {
    throw solicitudInvalida("participaciones no puede venir vacio.");
  }

  const lineas = filas.map((fila, indice) => {
    const linea = fila as Record<string, unknown>;
    const codigoEstado = textoRequerido(linea["estado"], `participaciones[${indice}].estado`, 40).toUpperCase();
    const horas = linea["horas"];
    return {
      idPersona: enteroRequerido(linea["idPersona"], `participaciones[${indice}].idPersona`),
      idGrupo: enteroOpcional(linea["idGrupo"], `participaciones[${indice}].idGrupo`)
        ?? actividad.idGrupoOrganizador,
      codigoEstado,
      tipoParticipante: textoOpcional(linea["tipoParticipante"], `participaciones[${indice}].tipoParticipante`, 25)
        ?? "ESTUDIANTE_PARTICIPANTE",
      // Las horas no se validan aqui: un trigger exige que toda participacion
      // ASISTIO las traiga, y su mensaje es el que debe llegar al usuario.
      horasParticipacion: horas === undefined || horas === null || horas === "" ? null : Number(horas),
    };
  });

  return consultas.registrarAsistencia(
    idActividad,
    actividad.idPeriodo,
    lineas,
    enteroOpcional(cuerpo["idPersonaConfirma"], "idPersonaConfirma"),
    usuarioRegistro,
  );
});

/* --------------------------- Informes trimestrales ---------------------- */

router.get("/informes", async (peticion) =>
  consultas.listarInformes(
    enteroOpcional(peticion.consulta["grupo"], "grupo"),
    enteroOpcional(peticion.consulta["trimestre"], "trimestre"),
    await idEstadoDeConsulta(peticion, "VOL_INFORME"),
  ));

router.get("/informes/{id}", async ({ parametros }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const informe = await consultas.obtenerInforme(id);
  if (!informe) throw noEncontrado(`No existe el informe ${id}.`);
  return informe;
});

router.post("/informes", async ({ cuerpo, usuarioRegistro }) =>
  creado(await consultas.crearInforme(
    enteroRequerido(cuerpo["idGrupo"], "idGrupo"),
    enteroRequerido(cuerpo["idTrimestre"], "idTrimestre"),
    usuarioRegistro,
  )));

router.put("/informes/{id}", async ({ parametros, cuerpo, usuarioRegistro }) => {
  const id = enteroRequerido(parametros["id"], "id");
  if (!(await consultas.obtenerInforme(id))) throw noEncontrado(`No existe el informe ${id}.`);

  return consultas.fijarActividadesDeInforme(
    id,
    lista(cuerpo["actividades"], "actividades").map((idActividad, indice) =>
      enteroRequerido(idActividad, `actividades[${indice}]`)),
    usuarioRegistro,
  );
});

router.post("/informes/{id}/envio", async ({ parametros }) =>
  consultas.cambiarEstadoInforme(
    enteroRequerido(parametros["id"], "id"),
    "ENVIADO",
    ["EN_CAPTURA", "OBSERVADO"],
    null,
    true,
  ));

router.post("/informes/{id}/dictamen", async ({ parametros, cuerpo }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const estado = codigoRequerido({ cuerpo } as Peticion, ["ACEPTADO", "OBSERVADO"]);
  const observaciones = textoOpcional(cuerpo["observaciones"], "observaciones", 4000);

  if (estado === "OBSERVADO" && observaciones === null) {
    throw solicitudInvalida("Observar un informe exige decir que se observa.");
  }
  return consultas.cambiarEstadoInforme(id, estado, ["ENVIADO"], observaciones, false);
});

/* ---------------------------- Informe economico ------------------------- */

router.get("/actividades/{id}/economico", async ({ parametros }) => {
  const id = enteroRequerido(parametros["id"], "id");
  const informe = await consultas.obtenerInformeEconomico(id);
  if (!informe) throw noEncontrado(`La actividad ${id} no tiene informe economico.`);
  return informe;
});

router.put("/actividades/{id}/economico", async ({ parametros, cuerpo, usuarioRegistro }) => {
  const idActividad = enteroRequerido(parametros["id"], "id");
  if (!(await consultas.obtenerActividad(idActividad))) {
    throw noEncontrado(`No existe la actividad ${idActividad}.`);
  }

  const movimientos = lista(cuerpo["movimientos"], "movimientos").map((fila, indice) => {
    const movimiento = fila as Record<string, unknown>;
    const tipo = textoRequerido(movimiento["tipoMovimiento"], `movimientos[${indice}].tipoMovimiento`, 10).toUpperCase();
    if (tipo !== "INGRESO" && tipo !== "EGRESO") {
      throw solicitudInvalida(`movimientos[${indice}].tipoMovimiento debe ser INGRESO o EGRESO.`);
    }
    const monto = Number(movimiento["montoMovimiento"]);
    if (!Number.isFinite(monto)) {
      throw solicitudInvalida(`movimientos[${indice}].montoMovimiento debe ser un numero.`);
    }
    return {
      idGrupo: enteroRequerido(movimiento["idGrupo"], `movimientos[${indice}].idGrupo`),
      tipoMovimiento: tipo,
      fechaMovimiento: textoOpcional(movimiento["fechaMovimiento"], `movimientos[${indice}].fechaMovimiento`, 10),
      descripcionMovimiento: textoRequerido(movimiento["descripcionMovimiento"], `movimientos[${indice}].descripcionMovimiento`, 300),
      responsableMovimiento: textoOpcional(movimiento["responsableMovimiento"], `movimientos[${indice}].responsableMovimiento`, 150),
      referenciaMovimiento: textoOpcional(movimiento["referenciaMovimiento"], `movimientos[${indice}].referenciaMovimiento`, 60),
      tipoComprobante: textoOpcional(movimiento["tipoComprobante"], `movimientos[${indice}].tipoComprobante`, 30),
      cantidadMovimiento: movimiento["cantidadMovimiento"] == null ? null : Number(movimiento["cantidadMovimiento"]),
      valorUnitario: movimiento["valorUnitario"] == null ? null : Number(movimiento["valorUnitario"]),
      montoMovimiento: monto,
      comprobanteUrl: textoOpcional(movimiento["comprobanteUrl"], `movimientos[${indice}].comprobanteUrl`, 300),
    };
  });

  const saldos: Record<number, number> = {};
  for (const [idGrupo, saldo] of Object.entries(
    (cuerpo["saldosAnteriores"] ?? {}) as Record<string, unknown>,
  )) {
    saldos[Number(idGrupo)] = Number(saldo);
  }

  return consultas.guardarInformeEconomico(
    idActividad,
    textoOpcional(cuerpo["observaciones"], "observaciones", 4000),
    saldos,
    movimientos,
    usuarioRegistro,
  );
});

/* -------------------------------- Diplomas ------------------------------ */

router.get("/diplomas/elegibles", async ({ consulta }) => {
  const idGrupo = enteroRequerido(consulta["grupo"], "grupo");
  await exigirGrupo(idGrupo);
  const umbral = enteroOpcional(consulta["umbral"], "umbral") ?? UMBRAL_DIPLOMA_POR_DEFECTO;
  if (umbral > 100) throw solicitudInvalida("umbral no puede pasar de 100.");

  return consultas.listarElegiblesDiploma(
    idGrupo,
    enteroOpcional(consulta["trimestre"], "trimestre"),
    umbral,
  );
});

router.get("/diplomas", async ({ consulta }) => {
  const idGrupo = enteroRequerido(consulta["grupo"], "grupo");
  await exigirGrupo(idGrupo);
  return consultas.listarDiplomas(idGrupo);
});

router.post("/diplomas", async ({ cuerpo, usuarioRegistro }) => {
  const porcentaje = Number(cuerpo["porcentajeParticipacion"]);
  if (!Number.isFinite(porcentaje) || porcentaje < 0 || porcentaje > 100) {
    throw solicitudInvalida("porcentajeParticipacion debe estar entre 0 y 100.");
  }

  return creado(await consultas.emitirDiploma({
    idGrupo: enteroRequerido(cuerpo["idGrupo"], "idGrupo"),
    idPersona: enteroRequerido(cuerpo["idPersona"], "idPersona"),
    ventanaDiploma: textoRequerido(cuerpo["ventanaDiploma"], "ventanaDiploma", 20),
    actividadesGrupo: enteroRequerido(cuerpo["actividadesGrupo"], "actividadesGrupo"),
    actividadesAsistidas: enteroRequerido(cuerpo["actividadesAsistidas"], "actividadesAsistidas"),
    porcentajeParticipacion: porcentaje,
    archivoUrl: textoOpcional(cuerpo["archivoUrl"], "archivoUrl", 300),
  }, usuarioRegistro));
});

/* ------------------------------ Diagnostico ----------------------------- */

router.get("/salud", async () => {
  const inicio = Date.now();
  const base = await consultas.medirBaseDeDatos();
  return {
    funcion: "voae-voluntariado",
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
