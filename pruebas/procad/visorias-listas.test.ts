import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { handler } from "../../src/funciones/procad/index";
import { alConsultar } from "../dobles/db";
import { invocar } from "../evento";
import { cuantasCon, errorDeTrigger, llamadaCon, responderPor } from "./ayuda";

beforeEach(() => alConsultar(() => []));

describe("Visorias", () => {
  test("GET filtra por periodo y campus", async () => {
    await invocar(handler, "GET", "/v1/procad/visorias?periodo=3&campus=1");
    assert.deepEqual(llamadaCon(/FROM Procad\.tblVisorias v/).parametros, { periodo: 3, campus: 1 });
  });

  test("GET /{id} trae los citados", async () => {
    responderPor([
      [/WHERE s\.idVisoriaAsignada = @id/, [{ idSolicitud: 7 }]],
      [/FROM Procad\.tblVisorias v/, [{ idVisoria: 2 }]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/visorias/2");
    assert.equal(codigo, 200);
    assert.equal(cuerpo.estudiantes[0].idSolicitud, 7);
  });

  test("POST crea la visoria", async () => {
    responderPor([
      [/INSERT INTO Procad\.tblVisorias/, [{ id: 2 }]],
      [/FROM Procad\.tblVisorias v/, [{ idVisoria: 2 }]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/visorias", {
      idPeriodo: 3, idCampus: 1, fechaVisoria: "2026-10-15", horaVisoria: "08:30", idLugarVisoria: 4,
    });
    assert.equal(codigo, 201);
    assert.equal(llamadaCon(/INSERT INTO Procad\.tblVisorias/).parametros["hora"], "08:30");
  });

  test("una hora invalida es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/visorias", {
      idPeriodo: 3, idCampus: 1, fechaVisoria: "2026-10-15", horaVisoria: "25:00",
    });
    assert.equal(codigo, 400);
  });

  test("el traslape lo rechaza el trigger con 409", async () => {
    const mensaje = "Ya existe una visoria en ese lugar, fecha y hora.";
    responderPor([[/INSERT INTO/, () => { throw errorDeTrigger(mensaje); }]]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/visorias", {
      idPeriodo: 3, idCampus: 1, fechaVisoria: "2026-10-15", horaVisoria: "08:30", idLugarVisoria: 4,
    });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });

  test("POST /{id}/citados asigna la visoria a cada solicitud", async () => {
    responderPor([
      [/SELECT idVisoria FROM Procad\.tblVisorias/, [{ idVisoria: 2 }]],
      [/SELECT idSolicitud FROM Procad\.tblSolicitudes WITH/, [{ idSolicitud: 1 }]],
      [/FROM Procad\.tblVisorias v/, [{ idVisoria: 2 }]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/visorias/2/citados", { solicitudes: [7, 8] });
    assert.equal(codigo, 200);
    assert.equal(cuantasCon(/SET idVisoriaAsignada = @visoria/), 2);
  });

  test("citar una solicitud que no existe es 404 y no cita a nadie mas", async () => {
    responderPor([[/SELECT idVisoria FROM Procad\.tblVisorias/, [{ idVisoria: 2 }]]]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/visorias/2/citados", { solicitudes: [7] });
    assert.equal(codigo, 404);
    assert.equal(cuantasCon(/UPDATE/), 0);
  });
});

describe("Listas preferenciales", () => {
  test("POST genera la lista con spGenerarListaPreferencial y la devuelve con los nombres de Registro", async () => {
    responderPor([
      [/SELECT idGrupo FROM Procad\.tblGrupos/, [{ idGrupo: 4 }]],
      [/SELECT idLista FROM Procad\.tblListasPreferenciales/, [{ idLista: 3 }]],
      [/FROM Procad\.tblListasPreferenciales l/, [{ idLista: 3, codigoEstado: "GENERADA" }]],
      [/FROM Procad\.tblDetallesListasPreferenciales d/, [
        { idSolicitud: 1, numeroCuenta: "20201000002" },
        { idSolicitud: 2, numeroCuenta: "20201000001" },
      ]],
      [/Registro\.spObtenerEstudiantes/, [
        { numeroCuenta: "20201000001", primerNombre: "Ana", primerApellido: "Alvarez", carrera: "Musica" },
        { numeroCuenta: "20201000002", primerNombre: "Beto", primerApellido: "Zelaya", carrera: "Derecho" },
      ]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/listas-preferenciales", {
      idGrupo: 4, idPeriodoEvaluado: 2, idPeriodoAplicacion: 3,
    });

    assert.equal(codigo, 201, JSON.stringify(cuerpo));
    assert.equal(cuerpo.idLista, 3);
    assert.deepEqual(llamadaCon(/^Procad\.spGenerarListaPreferencial$/).parametros, {
      idGrupo: 4, idPeriodoEvaluado: 2, idPeriodoAplicacion: 3, usuarioRegistro: "voae-frontend", idLista: null,
    });
    assert.deepEqual(cuerpo.detalles.map((d: { apellidosPersona: string }) => d.apellidosPersona), ["Alvarez", "Zelaya"]);
    assert.equal(cuerpo.detalles[0].carreraEstudiante, "Musica");
  });

  test("un periodo de aplicacion anterior lo rechaza la base", async () => {
    const mensaje = "El periodo de aplicacion de la lista debe ser posterior al periodo evaluado.";
    responderPor([
      [/SELECT idGrupo FROM Procad\.tblGrupos/, [{ idGrupo: 4 }]],
      [/spGenerarListaPreferencial/, () => { throw errorDeTrigger(mensaje); }],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/listas-preferenciales", {
      idGrupo: 4, idPeriodoEvaluado: 3, idPeriodoAplicacion: 2,
    });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });

  test("POST con un grupo que no existe es 404", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/listas-preferenciales", {
      idGrupo: 4, idPeriodoEvaluado: 2, idPeriodoAplicacion: 3,
    });
    assert.equal(codigo, 404);
  });

  test("envio: una GENERADA pasa a ENVIADA", async () => {
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ codigoEstado: "GENERADA" }]],
      [/FROM Procad\.tblListasPreferenciales l/, [{ idLista: 3, codigoEstado: "ENVIADA" }]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/listas-preferenciales/3/envio");
    assert.equal(codigo, 200);
    assert.equal(llamadaCon(/UPDATE Procad\.tblListasPreferenciales/).parametros["enviada"], "ENVIADA");
  });

  test("envio de una ya enviada es 409", async () => {
    responderPor([[/WITH \(UPDLOCK\)/, [{ codigoEstado: "ENVIADA" }]]]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/listas-preferenciales/3/envio");
    assert.equal(codigo, 409);
  });

  test("GET /{id} trae los detalles", async () => {
    responderPor([
      [/FROM Procad\.tblDetallesListasPreferenciales d/, [{ idListaDetalle: 1 }, { idListaDetalle: 2 }]],
      [/FROM Procad\.tblListasPreferenciales l/, [{ idLista: 3 }]],
    ]);
    const { cuerpo } = await invocar(handler, "GET", "/v1/procad/listas-preferenciales/3");
    assert.equal(cuerpo.detalles.length, 2);
  });
});

describe("Visorias con grupo y estado (columnas del 2026-09-23)", () => {
  test("POST crea la visoria del grupo en BORRADOR", async () => {
    responderPor([
      [/INSERT INTO Procad\.tblVisorias/, [{ id: 2 }]],
      [/FROM Procad\.tblVisorias v/, [{ idVisoria: 2, estadoVisoria: "BORRADOR" }]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/visorias", {
      idPeriodo: 3, idCampus: 1, fechaVisoria: "2026-10-15", idGrupo: 4,
    });
    assert.equal(codigo, 201);
    const insert = llamadaCon(/INSERT INTO Procad\.tblVisorias/);
    assert.equal(insert.parametros["grupo"], 4);
    assert.match(insert.texto, /N'BORRADOR'/);
  });

  test("programar pasa de BORRADOR a PROGRAMADA", async () => {
    responderPor([
      [/SELECT estadoVisoria FROM Procad\.tblVisorias WITH/, [{ estadoVisoria: "BORRADOR" }]],
      [/FROM Procad\.tblVisorias v/, [{ idVisoria: 2, estadoVisoria: "PROGRAMADA" }]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/visorias/2/programar");
    assert.equal(codigo, 200);
    assert.equal(cuerpo.estadoVisoria, "PROGRAMADA");
    assert.match(llamadaCon(/UPDATE Procad\.tblVisorias/).texto, /N'PROGRAMADA'/);
  });

  test("programar una ya programada es 409", async () => {
    responderPor([[/SELECT estadoVisoria FROM/, [{ estadoVisoria: "PROGRAMADA" }]]]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/visorias/2/programar");
    assert.equal(codigo, 409);
    assert.equal(cuantasCon(/UPDATE/), 0);
  });

  test("programar una que no existe es 404", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/visorias/2/programar");
    assert.equal(codigo, 404);
  });

  test("GET filtra por estado y grupo", async () => {
    await invocar(handler, "GET", "/v1/procad/visorias?estado=borrador&grupo=4");
    assert.deepEqual(llamadaCon(/FROM Procad\.tblVisorias v/).parametros, { grupo: 4, estado: "BORRADOR" });
  });

  test("un estado de visoria que no existe es 400", async () => {
    const { codigo } = await invocar(handler, "GET", "/v1/procad/visorias?estado=CANCELADA");
    assert.equal(codigo, 400);
  });
});
