import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handler } from "../../src/funciones/catalogo/index";
import { cuantasCon, responderPor } from "./ayuda";

// voae-catalogo con la v2: los datos de un estudiante salen de Registro.
async function invocarCatalogo(ruta: string) {
  const r = await handler({ version: "2.0", rawPath: ruta, requestContext: { http: { method: "GET", path: ruta } }, headers: {} });
  return { codigo: r.statusCode, cuerpo: r.body ? JSON.parse(r.body) : undefined };
}

const REGISTRO = /FROM Catalogo\.vwEstudiantesRegistro/;
const ANA = { numeroCuenta: "20250000101", primerNombre: "ANA", primerApellido: "REYES", correoInstitucional: "ana@unah.hn",
  idGenero: "2", idCampus: 1, carrera: "DERECHO", matriculado: true };

describe("GET /personas/{id} (catalogo)", () => {
  test("un estudiante toma de Registro nombre, genero, campus (con su nombre) y carrera", async () => {
    responderPor([
      [REGISTRO, [ANA]],
      [/FROM Catalogo\.tblCampus WHERE idCampus = @idCampus/, [{ nombreCampus: "CIUDAD UNIVERSITARIA" }]],
      [/FROM Catalogo\.tblPersonas p/, [{ idPersona: 7, nombrePersona: null, apellidosPersona: null, correoPersona: null,
        sexoPersona: null, idGenero: null, idCampus: null, nombreCampus: null, numeroCuenta: "20250000101" }]],
    ]);
    const { codigo, cuerpo } = await invocarCatalogo("/v1/catalogo/personas/7");
    assert.equal(codigo, 200);
    assert.deepEqual(
      [cuerpo.nombrePersona, cuerpo.apellidosPersona, cuerpo.correoPersona, cuerpo.sexoPersona, cuerpo.idGenero, cuerpo.idCampus, cuerpo.nombreCampus, cuerpo.carreraEstudiante],
      ["ANA", "REYES", "ana@unah.hn", "F", 2, 1, "CIUDAD UNIVERSITARIA", "DERECHO"],
    );
  });

  test("un empleado conserva sus datos locales y no se consulta el nombre del campus de nuevo", async () => {
    responderPor([
      [/FROM Catalogo\.tblPersonas p/, [{ idPersona: 9, nombrePersona: "Luis", apellidosPersona: "Empleado", sexoPersona: "M",
        idGenero: 1, idCampus: 3, nombreCampus: "CRAED JUTICALPA", numeroCuenta: null }]],
    ]);
    const { cuerpo } = await invocarCatalogo("/v1/catalogo/personas/9");
    assert.deepEqual([cuerpo.nombrePersona, cuerpo.idCampus, cuerpo.nombreCampus], ["Luis", 3, "CRAED JUTICALPA"]);
    assert.equal(cuantasCon(/WHERE idCampus = @idCampus/), 0);
    assert.equal(cuantasCon(REGISTRO), 0);
  });
});

describe("GET /estudiantes/{cuenta} (catalogo)", () => {
  test("una cuenta que solo esta en Registro existe, sin persona local", async () => {
    responderPor([
      [REGISTRO, [ANA]],
      [/SELECT nombreCampus FROM Catalogo\.tblCampus/, [{ nombreCampus: "CIUDAD UNIVERSITARIA" }]],
    ]);
    const { codigo, cuerpo } = await invocarCatalogo("/v1/catalogo/estudiantes/20250000101");
    assert.equal(codigo, 200);
    assert.deepEqual([cuerpo.idPersona, cuerpo.origen, cuerpo.nombrePersona, cuerpo.carreraEstudiante, cuerpo.matriculaVerificada, cuerpo.nombreCampus],
      [null, "REGISTRO", "ANA", "DERECHO", true, "CIUDAD UNIVERSITARIA"]);
  });

  test("una cuenta que no esta ni en Registro ni local es 404", async () => {
    responderPor([]);
    const { codigo } = await invocarCatalogo("/v1/catalogo/estudiantes/00000000000");
    assert.equal(codigo, 404);
  });

  test("si Registro no responde, buscar una cuenta da error (no se valida a ciegas)", async () => {
    responderPor([[REGISTRO, () => { throw new Error("linked server caido"); }]]);
    const { codigo } = await invocarCatalogo("/v1/catalogo/estudiantes/20250000101");
    assert.equal(codigo, 500);
  });
});
