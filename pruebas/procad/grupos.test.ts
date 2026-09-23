import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { handler } from "../../src/funciones/procad/index";
import { alConsultar, llamadas } from "../dobles/db";
import { invocar } from "../evento";
import { cuantasCon, errorDeTrigger, llamadaCon, responderPor } from "./ayuda";

/** Un grupo como lo devuelve la base: las listas llegan como texto JSON de FOR JSON PATH. */
const GRUPO = {
  idGrupo: 4,
  nombreGrupo: "Coro UNAH",
  esSeleccion: false,
  disciplinas: '[{"idDisciplina":2,"nombreDisciplina":"canto"}]',
  tiposActividad: null,
};

beforeEach(() => alConsultar(() => []));

describe("GET /grupos", () => {
  test("convierte las listas FOR JSON en arreglos y solo trae activos", async () => {
    responderPor([[/FROM Procad\.tblGrupos g/, [GRUPO]]]);
    const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/grupos?campus=1&tipoGrupo=artistico");

    assert.equal(codigo, 200);
    assert.deepEqual(cuerpo[0].disciplinas, [{ idDisciplina: 2, nombreDisciplina: "canto" }]);
    assert.deepEqual(cuerpo[0].tiposActividad, []);
    assert.match(llamadaCon(/FROM Procad\.tblGrupos g/).texto, /g\.estadoGrupo = 1/);
  });

  test("?todos=true incluye inactivos", async () => {
    await invocar(handler, "GET", "/v1/procad/grupos?todos=true");
    assert.doesNotMatch(llamadaCon(/FROM Procad\.tblGrupos g/).texto, /estadoGrupo = 1/);
  });
});

describe("GET /grupos/{id}", () => {
  test("trae directores y configuraciones", async () => {
    responderPor([
      [/FROM Procad\.tblAccesos/, [{ idAcceso: 1 }]],
      [/FROM Procad\.tblConfiguracionesGruposPeriodos/, [{ idConfiguracion: 3 }]],
      [/FROM Procad\.tblGrupos g/, [GRUPO]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/grupos/4");
    assert.equal(codigo, 200);
    assert.equal(cuerpo.directores.length, 1);
    assert.equal(cuerpo.configuraciones.length, 1);
  });

  test("404 si no existe", async () => {
    const { codigo } = await invocar(handler, "GET", "/v1/procad/grupos/4");
    assert.equal(codigo, 404);
  });
});

describe("POST /grupos", () => {
  const alta = {
    nombreGrupo: "Coro UNAH", idTipoGrupo: 2, idCampus: 1, categoriaSexo: "Mixto",
    disciplinas: [2, 3], tiposActividad: [5],
  };

  test("crea el grupo y sus tablas puente en una transaccion", async () => {
    responderPor([
      [/INSERT INTO Procad\.tblGrupos/, [{ id: 4 }]],
      [/FROM Procad\.tblGrupos g/, [GRUPO]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/grupos", alta);

    assert.equal(codigo, 201);
    assert.equal(llamadaCon(/INSERT INTO Procad\.tblGrupos /).parametros["categoriaSexo"], "mixto");
    assert.equal(cuantasCon(/INSERT INTO Procad\.tblGruposDisciplinas/), 2);
    assert.equal(cuantasCon(/INSERT INTO Procad\.tblGruposTiposActividades/), 1);
  });

  test("sin nombre es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/grupos", { idTipoGrupo: 1, idCampus: 1 });
    assert.equal(codigo, 400);
  });

  test("una categoria de sexo que no existe es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/grupos", { ...alta, categoriaSexo: "otro" });
    assert.equal(codigo, 400);
  });

  test("un grupo deportivo sin deporte lo rechaza el trigger con 409", async () => {
    const mensaje = "Un grupo deportivo debe indicar su deporte.";
    responderPor([[/INSERT INTO Procad\.tblGrupos/, () => { throw errorDeTrigger(mensaje); }]]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/grupos", {
      nombreGrupo: "Futbol", idTipoGrupo: 1, idCampus: 1,
    });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });
});

describe("PUT /grupos/{id}", () => {
  test("solo toca lo que vino, y reemplaza las disciplinas", async () => {
    responderPor([
      [/SELECT idGrupo FROM Procad\.tblGrupos WITH/, [{ idGrupo: 4 }]],
      [/FROM Procad\.tblGrupos g/, [GRUPO]],
    ]);
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/grupos/4", { activo: false, disciplinas: [1] });

    assert.equal(codigo, 200);
    const update = llamadaCon(/UPDATE Procad\.tblGrupos/);
    assert.match(update.texto, /SET estadoGrupo = @estadoGrupo\s+WHERE/);
    assert.equal(cuantasCon(/DELETE FROM Procad\.tblGruposDisciplinas/), 1);
    assert.equal(cuantasCon(/DELETE FROM Procad.tblGruposTiposActividades/), 0);
  });

  test("el tipo de grupo no se cambia", async () => {
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/grupos/4", { idTipoGrupo: 1 });
    assert.equal(codigo, 400);
  });

  test("un cuerpo vacio es 400", async () => {
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/grupos/4", {});
    assert.equal(codigo, 400);
  });

  test("404 si no existe", async () => {
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/grupos/4", { nombreGrupo: "X" });
    assert.equal(codigo, 404);
  });
});

describe("GET /grupos/{id}/integrantes", () => {
  test("en un grupo normal lee sus solicitudes APROBADO", async () => {
    responderPor([[/SELECT idGrupo, nombreGrupo, esSeleccion/, [{ idGrupo: 4, esSeleccion: false }]]]);
    const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/grupos/4/integrantes?periodo=3");

    assert.equal(codigo, 200);
    assert.deepEqual(cuerpo.integrantes, []);
    const { texto, parametros } = llamadaCon(/s\.idGrupo = @id/);
    assert.match(texto, /codigoEstado = N'APROBADO'/);
    assert.equal(parametros["periodo"], 3);
  });

  test("en una seleccion lee tblSeleccionIntegrantes", async () => {
    responderPor([
      [/SELECT idGrupo, nombreGrupo, esSeleccion/, [{ idGrupo: 9, esSeleccion: true }]],
      [/FROM Procad\.tblSeleccionIntegrantes si\s+INNER JOIN/, [{ idSolicitud: 1, nombreCampus: "CU" }]],
    ]);
    const { cuerpo } = await invocar(handler, "GET", "/v1/procad/grupos/9/integrantes");
    assert.equal(cuerpo.integrantes.length, 1);
    assert.match(llamadaCon(/si\.idGrupoSeleccion = @id/).texto, /tblSeleccionIntegrantes/);
  });
});

describe("Configuracion por periodo", () => {
  test("PUT inserta si no existe", async () => {
    await invocar(handler, "PUT", "/v1/procad/periodos/configuracion", {
      idGrupo: 4, idPeriodo: 3, porcentajeMinimoEntrenamientos: 70,
    });
    assert.equal(cuantasCon(/INSERT INTO Procad\.tblConfiguracionesGruposPeriodos/), 1);
  });

  test("PUT actualiza si ya existe", async () => {
    responderPor([[/WITH \(UPDLOCK, HOLDLOCK\)/, [{ idConfiguracion: 1 }]]]);
    await invocar(handler, "PUT", "/v1/procad/periodos/configuracion", {
      idGrupo: 4, idPeriodo: 3, minimoActividades: 8,
    });
    assert.equal(cuantasCon(/UPDATE Procad\.tblConfiguracionesGruposPeriodos/), 1);
    assert.equal(cuantasCon(/INSERT INTO/), 0);
  });

  test("un porcentaje mayor a 100 es 400", async () => {
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/periodos/configuracion", {
      idGrupo: 4, idPeriodo: 3, porcentajeMinimoEntrenamientos: 150,
    });
    assert.equal(codigo, 400);
    assert.equal(llamadas.length, 0);
  });

  test("la regla equivocada para el tipo de grupo la rechaza el trigger", async () => {
    const mensaje = "porcentajeMinimoEntrenamientos solo aplica a grupos deportivos.";
    responderPor([[/INSERT INTO/, () => { throw errorDeTrigger(mensaje); }]]);
    const { codigo, cuerpo } = await invocar(handler, "PUT", "/v1/procad/periodos/configuracion", {
      idGrupo: 4, idPeriodo: 3, porcentajeMinimoEntrenamientos: 70,
    });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });

  test("GET filtra por periodo", async () => {
    await invocar(handler, "GET", "/v1/procad/periodos/configuracion?periodo=3");
    assert.equal(llamadaCon(/FROM Procad\.tblConfiguracionesGruposPeriodos/).parametros["periodo"], 3);
  });
});

describe("Accesos y PROSENE", () => {
  test("GET /accesos solo vigentes por defecto", async () => {
    await invocar(handler, "GET", "/v1/procad/accesos?grupo=4");
    const { texto, parametros } = llamadaCon(/FROM Procad\.tblAccesos a/);
    assert.match(texto, /a\.estadoAcceso = 1/);
    assert.equal(parametros["grupo"], 4);
  });

  test("GET /prosene solo activos por defecto, todos con ?todos=true", async () => {
    await invocar(handler, "GET", "/v1/procad/prosene");
    assert.match(llamadaCon(/tblBeneficiariosProsene/).texto, /estadoBeneficio = 1/);

    alConsultar(() => []);
    await invocar(handler, "GET", "/v1/procad/prosene?todos=true");
    assert.doesNotMatch(llamadaCon(/tblBeneficiariosProsene/).texto, /WHERE/);
  });
});
