import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { handler } from "../../src/funciones/procad/index";
import { alConsultar, llamadas } from "../dobles/db";
import { invocar } from "../evento";
import { cuantasCon, errorDeTrigger, llamadaCon, responderPor } from "./ayuda";

const SOLICITUD = { idSolicitud: 7, idPersona: 3, codigoEstado: "PENDIENTE" };

beforeEach(() => alConsultar(() => []));

describe("GET /solicitudes", () => {
  test("pasa los filtros como parametros, no como texto", async () => {
    const { codigo } = await invocar(
      handler, "GET", "/v1/procad/solicitudes?campus=2&tipoGrupo=Deportivo&estado=pendiente&periodo=5&q=ana",
    );

    assert.equal(codigo, 200);
    const { texto, parametros } = llamadaCon(/FROM Procad\.tblSolicitudes s/);
    assert.deepEqual(parametros, {
      campus: 2, tipoGrupo: "deportivo", estado: "PENDIENTE", periodo: 5, texto: "%ana%",
    });
    assert.match(texto, /g\.idCampus = @campus/);
    assert.doesNotMatch(texto, /ana/);
  });

  test("sin filtros no filtra nada", async () => {
    await invocar(handler, "GET", "/v1/procad/solicitudes");
    const { texto, parametros } = llamadaCon(/FROM Procad\.tblSolicitudes s/);
    assert.deepEqual(parametros, {});
    // El unico WHERE es el de la subconsulta de adjuntos.
    assert.equal(texto.match(/WHERE/g)?.length, 1);
  });

  test("un estado que no existe es 400", async () => {
    const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/solicitudes?estado=RECHAZADO");
    assert.equal(codigo, 400);
    assert.match(cuerpo.error, /NO_CUMPLE_REQUISITO/);
  });

  test("un tipo de grupo que no existe es 400", async () => {
    const { codigo } = await invocar(handler, "GET", "/v1/procad/solicitudes?tipoGrupo=musical");
    assert.equal(codigo, 400);
  });
});

describe("GET /solicitudes/{id}", () => {
  test("404 si no existe", async () => {
    const { codigo } = await invocar(handler, "GET", "/v1/procad/solicitudes/99");
    assert.equal(codigo, 404);
  });

  test("devuelve la ficha con detalle, adjuntos e historial", async () => {
    responderPor([
      [/FROM Procad\.tblDetallesSolicitudes/, [{ idDetalleSolicitud: 1, nivelExperiencia: "Avanzado" }]],
      [/FROM Procad\.tblAdjuntosSolicitudes/, [{ idAdjunto: 4, tipoAdjunto: "pdf" }]],
      [/FROM Procad\.tblLogsEstadosSolicitudes/, [{ estadoNuevo: "PENDIENTE" }]],
      [/FROM Procad\.tblSolicitudes s/, [SOLICITUD]],
    ]);

    const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/solicitudes/7");

    assert.equal(codigo, 200);
    assert.equal(cuerpo.idSolicitud, 7);
    assert.equal(cuerpo.detalle.nivelExperiencia, "Avanzado");
    assert.equal(cuerpo.adjuntos.length, 1);
    assert.equal(cuerpo.historial[0].estadoNuevo, "PENDIENTE");
  });

  test("un id no numerico es 400", async () => {
    const { codigo } = await invocar(handler, "GET", "/v1/procad/solicitudes/abc");
    assert.equal(codigo, 400);
  });
});

describe("POST /solicitudes/{id}/resolucion", () => {
  const pendiente = () =>
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]],
      [/FROM Procad\.tblSolicitudes s/, [SOLICITUD]],
    ]);

  test("aprueba, y deja el cambio en el log con el estado anterior", async () => {
    pendiente();
    const { codigo } = await invocar(handler, "POST", "/v1/procad/solicitudes/7/resolucion", {
      decision: "aprobado", idPersona: 12,
    });

    assert.equal(codigo, 200);
    const update = llamadaCon(/UPDATE Procad\.tblSolicitudes/);
    assert.equal(update.parametros["decision"], "APROBADO");
    assert.match(update.texto, /contextoEstado = N'PROCAD_SOLICITUD'/);
    const log = llamadaCon(/INSERT INTO Procad\.tblLogsEstadosSolicitudes/);
    assert.equal(log.parametros["idEstadoAnterior"], 17);
    assert.equal(log.parametros["idPersona"], 12);
  });

  test("EXPULSADO no es una decision: solo lo pone la expulsion", async () => {
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/solicitudes/7/resolucion", {
      decision: "EXPULSADO", idPersona: 12,
    });
    assert.equal(codigo, 400);
    assert.match(cuerpo.error, /decision/);
  });

  test("observar sin decir que corregir es 400 (RF-12)", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/solicitudes/7/resolucion", {
      decision: "OBSERVADO", idPersona: 12,
    });
    assert.equal(codigo, 400);
    assert.equal(llamadas.length, 0);
  });

  test("sin quien resuelve es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/solicitudes/7/resolucion", { decision: "APROBADO" });
    assert.equal(codigo, 400);
  });

  test("una solicitud que ya no esta PENDIENTE es 409 y no se toca", async () => {
    responderPor([[/WITH \(UPDLOCK\)/, [{ idEstado: 18, codigoEstado: "APROBADO", esCondicionado: false }]]]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/solicitudes/7/resolucion", {
      decision: "NO_CUMPLE_REQUISITO", idPersona: 12,
    });

    assert.equal(codigo, 409);
    assert.match(cuerpo.error, /APROBADO/);
    assert.equal(cuantasCon(/UPDATE/), 0);
  });

  test("si un trigger rechaza la aprobacion, su mensaje llega como 409", async () => {
    const mensaje = "El estudiante debe tener la matricula verificada para ser aprobado en el grupo.";
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]],
      [/UPDATE Procad\.tblSolicitudes/, () => { throw errorDeTrigger(mensaje); }],
    ]);

    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/solicitudes/7/resolucion", {
      decision: "APROBADO", idPersona: 12,
    });

    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });

  test("404 si la solicitud no existe", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/solicitudes/7/resolucion", {
      decision: "APROBADO", idPersona: 12,
    });
    assert.equal(codigo, 404);
  });
});

describe("Condicionados", () => {
  test("GET filtra propuestos sin autorizar", async () => {
    await invocar(handler, "GET", "/v1/procad/condicionados?estado=propuesto");
    const { texto } = llamadaCon(/idPersonaProponeCondicionado IS NOT NULL/);
    assert.match(texto, /s\.esCondicionado = 0/);
  });

  test("POST propone: guarda quien propone sin marcar esCondicionado", async () => {
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]],
      [/FROM Procad\.tblSolicitudes s/, [SOLICITUD]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/condicionados", {
      idSolicitud: 7, idPersonaPropone: 20,
    });

    assert.equal(codigo, 201);
    const update = llamadaCon(/UPDATE Procad\.tblSolicitudes/);
    assert.match(update.texto, /idPersonaProponeCondicionado = @propone/);
    assert.doesNotMatch(update.texto, /esCondicionado = 1/);
  });

  test("autorizar marca esCondicionado y deja que el trigger valide las dos firmas", async () => {
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]],
      [/FROM Procad\.tblSolicitudes s/, [SOLICITUD]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/condicionados/7/autorizacion", {
      idPersonaAutoriza: 30,
    });

    assert.equal(codigo, 200);
    const update = llamadaCon(/UPDATE Procad\.tblSolicitudes/);
    assert.match(update.texto, /esCondicionado = 1/);
    assert.equal(update.parametros["autoriza"], 30);
  });

  test("autorizar dos veces es 409", async () => {
    responderPor([[/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: true }]]]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/condicionados/7/autorizacion", {
      idPersonaAutoriza: 30,
    });
    assert.equal(codigo, 409);
  });
});

describe("Expulsiones", () => {
  test("solo se pide la expulsion de un integrante APROBADO", async () => {
    responderPor([[/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]]]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/expulsiones", {
      idSolicitud: 7, idPersonaSolicita: 20, idMotivoExpulsion: 2,
    });
    assert.equal(codigo, 409);
    assert.equal(cuantasCon(/INSERT/), 0);
  });

  test("POST crea la expulsion PENDIENTE", async () => {
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ idEstado: 18, codigoEstado: "APROBADO", esCondicionado: false }]],
      [/INSERT INTO Procad\.tblSolicitudesExpulsion/, [{ id: 5 }]],
      [/FROM Procad\.tblSolicitudesExpulsion x/, [{ idSolicitudExpulsion: 5, codigoEstado: "PENDIENTE" }]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/expulsiones", {
      idSolicitud: 7, idPersonaSolicita: 20, idMotivoExpulsion: 2, detalleMotivo: "Faltas",
    });

    assert.equal(codigo, 201);
    assert.equal(cuerpo.idSolicitudExpulsion, 5);
    assert.equal(llamadaCon(/INSERT INTO Procad\.tblSolicitudesExpulsion/).parametros["pendiente"], "PENDIENTE");
  });

  test("aprobarla deja en el log el paso de la solicitud a EXPULSADO", async () => {
    responderPor([
      [/FROM Procad\.tblSolicitudesExpulsion x WITH \(UPDLOCK\)/, [{ idSolicitud: 7, idEstadoSolicitud: 18 }]],
      // El trigger ya cambio la solicitud: despues del UPDATE esta en EXPULSADO (21).
      [/SELECT idEstado FROM Procad\.tblSolicitudes WHERE/, [{ idEstado: 21 }]],
      [/FROM Procad\.tblSolicitudesExpulsion x/, [{ idSolicitudExpulsion: 5, codigoEstado: "APROBADA" }]],
    ]);

    const { codigo } = await invocar(handler, "POST", "/v1/procad/expulsiones/5/resolucion", {
      decision: "aprobada", idPersonaResuelve: 30,
    });

    assert.equal(codigo, 200);
    const log = llamadaCon(/INSERT INTO Procad\.tblLogsEstadosSolicitudes/);
    assert.equal(log.parametros["idEstadoAnterior"], 18);
    assert.match(String(log.parametros["observacion"]), /Expulsion 5 aprobada/);
  });

  test("rechazarla no toca el log: la solicitud no cambio", async () => {
    responderPor([
      [/FROM Procad\.tblSolicitudesExpulsion x WITH \(UPDLOCK\)/, [{ idSolicitud: 7, idEstadoSolicitud: 18 }]],
      [/SELECT idEstado FROM Procad\.tblSolicitudes WHERE/, [{ idEstado: 18 }]],
      [/FROM Procad\.tblSolicitudesExpulsion x/, [{ idSolicitudExpulsion: 5, codigoEstado: "RECHAZADA" }]],
    ]);
    await invocar(handler, "POST", "/v1/procad/expulsiones/5/resolucion", {
      decision: "RECHAZADA", idPersonaResuelve: 30,
    });
    assert.equal(cuantasCon(/tblLogsEstadosSolicitudes/), 0);
  });

  test("resolver una ya resuelta: el trigger responde y sale 409", async () => {
    const mensaje = "Una solicitud de expulsion ya resuelta no se puede modificar.";
    responderPor([
      [/FROM Procad\.tblSolicitudesExpulsion x WITH \(UPDLOCK\)/, [{ idSolicitud: 7, idEstadoSolicitud: 21 }]],
      [/UPDATE Procad\.tblSolicitudesExpulsion/, () => { throw errorDeTrigger(mensaje); }],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/expulsiones/5/resolucion", {
      decision: "RECHAZADA", idPersonaResuelve: 30,
    });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });
});

describe("Matriculas excepcionales", () => {
  test("GET por defecto solo activas", async () => {
    await invocar(handler, "GET", "/v1/procad/matriculas-excepcionales?periodo=4");
    const { texto, parametros } = llamadaCon(/FROM Procad\.tblMatriculasExcepcionales/);
    assert.match(texto, /me\.estadoExcepcion = 1/);
    assert.equal(parametros["periodo"], 4);
  });

  test("POST sin motivo es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/matriculas-excepcionales", {
      idPersona: 3, idPeriodo: 4, idPersonaAutoriza: 30,
    });
    assert.equal(codigo, 400);
  });

  test("POST la crea", async () => {
    responderPor([
      [/INSERT INTO/, [{ id: 9 }]],
      [/FROM Procad\.tblMatriculasExcepcionales/, [{ idMatriculaExcepcional: 9 }]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/matriculas-excepcionales", {
      idPersona: 3, idPeriodo: 4, idPersonaAutoriza: 30, motivoExcepcion: "Apoyo en evento VOAE",
    });
    assert.equal(codigo, 201);
    assert.equal(cuerpo.idMatriculaExcepcional, 9);
  });
});

describe("PUT /solicitudes/{id}/equipo", () => {
  test("marca a un integrante APROBADO como parte del equipo", async () => {
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ idEstado: 18, codigoEstado: "APROBADO", esCondicionado: false }]],
      [/FROM Procad\.tblSolicitudes s/, [SOLICITUD]],
    ]);
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/solicitudes/7/equipo", { esEquipo: true });

    assert.equal(codigo, 200);
    assert.equal(llamadaCon(/SET esEquipo = @esEquipo/).parametros["esEquipo"], true);
  });

  test("una solicitud que no esta APROBADO es 409", async () => {
    responderPor([[/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]]]);
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/solicitudes/7/equipo", { esEquipo: true });
    assert.equal(codigo, 409);
    assert.equal(cuantasCon(/UPDATE/), 0);
  });

  test("sin esEquipo es 400", async () => {
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/solicitudes/7/equipo", {});
    assert.equal(codigo, 400);
  });
});

describe("Condicionados por reconfirmar", () => {
  test("?estado=POR_RECONFIRMAR busca PENDIENTE sin firmas que venian condicionados", async () => {
    await invocar(handler, "GET", "/v1/procad/condicionados?estado=por_reconfirmar");
    const { texto } = llamadaCon(/OUTER APPLY/);
    assert.match(texto, /ant\.idSolicitud IS NOT NULL/);
    assert.match(texto, /sa\.idPeriodo = s\.idUltimoPeriodo AND sa\.esCondicionado = 1/);
  });

  test("sin estado trae los tres casos", async () => {
    await invocar(handler, "GET", "/v1/procad/condicionados");
    const { texto } = llamadaCon(/OUTER APPLY/);
    assert.match(texto, /s\.esCondicionado = 1 OR/);
  });
});

describe("Ajustes para el frontend", () => {
  test("GET /solicitudes trae la ficha y los adjuntos como lista", async () => {
    responderPor([[/FROM Procad\.tblSolicitudes s/, [{
      idSolicitud: 7, contactoEmergenciaNombre: "Rosa", nombrePosicion: "Base",
      adjuntos: '[{"tipoAdjunto":"texto","contenidoTexto":"5 anios en el coro"}]',
    }]]]);
    const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/solicitudes");

    assert.equal(codigo, 200);
    assert.equal(cuerpo[0].contactoEmergenciaNombre, "Rosa");
    assert.deepEqual(cuerpo[0].adjuntos, [{ tipoAdjunto: "texto", contenidoTexto: "5 anios en el coro" }]);
    assert.match(llamadaCon(/FROM Procad\.tblSolicitudes s/).texto, /LEFT JOIN Procad\.tblDetallesSolicitudes d/);
  });

  test("rechazar una propuesta la retira y deja el motivo en el historial", async () => {
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]],
      [/AS propone FROM/, [{ propone: 20 }]],
      [/FROM Procad\.tblSolicitudes s/, [SOLICITUD]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/condicionados/7/rechazo", {
      idPersona: 30, motivo: "No hay evidencia suficiente",
    });

    assert.equal(codigo, 200);
    assert.match(llamadaCon(/UPDATE Procad\.tblSolicitudes/).texto, /idPersonaProponeCondicionado = NULL/);
    const log = llamadaCon(/INSERT INTO Procad\.tblLogsEstadosSolicitudes/);
    assert.match(String(log.parametros["observacion"]), /rechazada\. No hay evidencia/);
  });

  test("rechazar sin propuesta es 409", async () => {
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]],
      [/AS propone FROM/, [{ propone: null }]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/condicionados/7/rechazo", { idPersona: 30 });
    assert.equal(codigo, 409);
  });

  test("matricula excepcional por numero de cuenta", async () => {
    responderPor([
      [/FROM Catalogo\.tblDetallesEstudiantes WHERE numeroCuenta/, [{ idPersona: 3 }]],
      [/INSERT INTO/, [{ id: 9 }]],
      [/FROM Procad\.tblMatriculasExcepcionales/, [{ idMatriculaExcepcional: 9 }]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/matriculas-excepcionales", {
      numeroCuenta: "20201000123", idPeriodo: 4, idPersonaAutoriza: 30, motivoExcepcion: "Apoyo en evento",
    });
    assert.equal(codigo, 201);
    assert.equal(llamadaCon(/INSERT INTO/).parametros["persona"], 3);
  });

  test("matricula excepcional con una cuenta que no existe es 404", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/matriculas-excepcionales", {
      numeroCuenta: "999", idPeriodo: 4, idPersonaAutoriza: 30, motivoExcepcion: "X",
    });
    assert.equal(codigo, 404);
  });

  test("matricula excepcional con idPersona y cuenta a la vez es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/matriculas-excepcionales", {
      idPersona: 3, numeroCuenta: "1", idPeriodo: 4, idPersonaAutoriza: 30, motivoExcepcion: "X",
    });
    assert.equal(codigo, 400);
  });
});
