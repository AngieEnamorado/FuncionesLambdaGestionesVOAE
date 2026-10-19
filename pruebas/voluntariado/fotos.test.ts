import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { consultaCon, cuantasCon, invocar, responderPor } from "./ayuda";

const QUITAR = "/v1/voluntariado/actividades/34/fotos/40";
const AGREGAR = "/v1/voluntariado/actividades/34/fotos";
const LLAVE = "voluntariado/actividades/34/abc-foto.jpg";
const FOTO = /FROM Voluntariado\.tblFotosActividades\s/;
const INFORME = /FROM Voluntariado\.tblInformesTrimestralesActividades/;
const borrados = () => cuantasCon(/DELETE FROM Voluntariado\.tblFotosActividades/);
const insertadas = () => cuantasCon(/INSERT INTO Voluntariado\.tblFotosActividades/);

describe("DELETE /actividades/{id}/fotos/{idFoto}", () => {
  test("quita la foto de esa actividad", async () => {
    responderPor([[FOTO, [{ idFotoActividad: 40 }]]]);
    const { codigo, cuerpo } = await invocar("DELETE", QUITAR);

    assert.equal(codigo, 200);
    assert.deepEqual(cuerpo, { idActividad: 34, idFotoActividad: 40, quitada: true });
    // El DELETE amarra la foto a la actividad: no se borra la foto de otra.
    assert.deepEqual(consultaCon(/DELETE FROM Voluntariado\.tblFotosActividades/).valores, { idFoto: 40, idActividad: 34 });
  });

  test("una foto que no es de esa actividad es 404 y no borra", async () => {
    responderPor([]);
    const { codigo } = await invocar("DELETE", QUITAR);
    assert.equal(codigo, 404);
    assert.equal(borrados(), 0);
  });

  test("con el informe en revision es 409 y no borra", async () => {
    responderPor([[FOTO, [{ idFotoActividad: 40 }]], [INFORME, [{ codigoEstado: "ENVIADO" }]]]);
    const { codigo, cuerpo } = await invocar("DELETE", QUITAR);
    assert.equal(codigo, 409);
    assert.match(cuerpo.error, /revision/);
    assert.equal(borrados(), 0);
  });

  test("con el informe aceptado es 409 y no borra", async () => {
    responderPor([[FOTO, [{ idFotoActividad: 40 }]], [INFORME, [{ codigoEstado: "ACEPTADO" }]]]);
    const { codigo, cuerpo } = await invocar("DELETE", QUITAR);
    assert.equal(codigo, 409);
    assert.match(cuerpo.error, /aceptado/);
    assert.equal(borrados(), 0);
  });
});

describe("POST /actividades/{id}/fotos", () => {
  test("agrega la foto si el informe sigue abierto", async () => {
    responderPor([[/INSERT INTO Voluntariado\.tblFotosActividades/, [{ idFotoActividad: 41, archivoUrl: LLAVE }]]]);
    const { codigo } = await invocar("POST", AGREGAR, { archivoUrl: LLAVE });
    assert.equal(codigo, 201);
    assert.equal(insertadas(), 1);
  });

  test("con el informe aceptado es 409 y no agrega", async () => {
    responderPor([[INFORME, [{ codigoEstado: "ACEPTADO" }]]]);
    const { codigo } = await invocar("POST", AGREGAR, { archivoUrl: LLAVE });
    assert.equal(codigo, 409);
    assert.equal(insertadas(), 0);
  });

  test("una llave de otra actividad es 400", async () => {
    responderPor([]);
    const { codigo } = await invocar("POST", AGREGAR, { archivoUrl: "voluntariado/actividades/99/abc-foto.jpg" });
    assert.equal(codigo, 400);
    assert.equal(insertadas(), 0);
  });
});
