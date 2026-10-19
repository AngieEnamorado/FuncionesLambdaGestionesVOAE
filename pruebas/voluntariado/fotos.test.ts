import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { consultaCon, cuantasCon, invocar, responderPor } from "./ayuda";

const RUTA = "/v1/voluntariado/actividades/34/fotos/40";
const borrados = () => cuantasCon(/DELETE FROM Voluntariado\.tblFotosActividades/);

describe("DELETE /actividades/{id}/fotos/{idFoto}", () => {
  test("quita la foto de esa actividad", async () => {
    responderPor([[/FROM Voluntariado\.tblFotosActividades f/, [{ idFotoActividad: 40, informeCerrado: null }]]]);
    const { codigo, cuerpo } = await invocar("DELETE", RUTA);

    assert.equal(codigo, 200);
    assert.deepEqual(cuerpo, { idActividad: 34, idFotoActividad: 40, quitada: true });
    // El DELETE amarra la foto a la actividad: no se borra la foto de otra.
    assert.deepEqual(consultaCon(/DELETE FROM Voluntariado\.tblFotosActividades/).valores, { idFoto: 40, idActividad: 34 });
  });

  test("una foto que no es de esa actividad es 404 y no borra", async () => {
    responderPor([]);
    const { codigo } = await invocar("DELETE", RUTA);
    assert.equal(codigo, 404);
    assert.equal(borrados(), 0);
  });

  test("con el informe en revision es 409 y no borra", async () => {
    responderPor([[/FROM Voluntariado\.tblFotosActividades f/, [{ idFotoActividad: 40, informeCerrado: "ENVIADO" }]]]);
    const { codigo, cuerpo } = await invocar("DELETE", RUTA);
    assert.equal(codigo, 409);
    assert.match(cuerpo.error, /revision/);
    assert.equal(borrados(), 0);
  });

  test("con el informe aceptado es 409 y no borra", async () => {
    responderPor([[/FROM Voluntariado\.tblFotosActividades f/, [{ idFotoActividad: 40, informeCerrado: "ACEPTADO" }]]]);
    const { codigo, cuerpo } = await invocar("DELETE", RUTA);
    assert.equal(codigo, 409);
    assert.match(cuerpo.error, /aceptado/);
    assert.equal(borrados(), 0);
  });
});
