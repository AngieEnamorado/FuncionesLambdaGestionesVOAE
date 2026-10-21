import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { registro } from "./dobles/db";
import { consultaCon, cuantasCon, invocar, responderPor } from "./ayuda";

// v2 de la base: los datos personales de un estudiante viven en Registro
// (Catalogo.vwEstudiantesRegistro) y se completan sobre lo que trae la consulta.
const REGISTRO = /FROM Catalogo\.vwEstudiantesRegistro/;
const ANA = { numeroCuenta: "20201000001", primerNombre: "Ana", segundoNombre: "Maria", primerApellido: "Lopez",
  segundoApellido: "Reyes", correoInstitucional: "ana@unah.hn", idGenero: "2", idCampus: 1, carrera: "Medicina" };

describe("GET /grupos/{id}/miembros con Registro", () => {
  test("el estudiante toma nombre, sexo, correo y carrera de Registro; el empleado conserva lo local", async () => {
    responderPor([
      [REGISTRO, [ANA]],
      [/FROM Voluntariado\.tblMiembrosGrupos m/, [
        { idPersona: 2, idCargo: 1, nombrePersona: "Zoe", apellidosPersona: "Empleada", correoPersona: "zoe@unah.edu.hn",
          sexoPersona: "F", numeroCuenta: null, carreraEstudiante: null, idCampus: 3 },
        { idPersona: 1, idCargo: 1, nombrePersona: null, apellidosPersona: null, correoPersona: null,
          sexoPersona: null, numeroCuenta: "20201000001", carreraEstudiante: null, idCampus: null },
      ]],
      [/FROM Voluntariado\.tblGrupos/, [{ hay: 1 }]],
    ]);
    const { codigo, cuerpo } = await invocar("GET", "/v1/voluntariado/grupos/5/miembros");

    assert.equal(codigo, 200);
    // Se ordena despues de completar, por cargo y apellido: "Empleada" va antes que "Lopez Reyes".
    assert.deepEqual(cuerpo.map((m: { idPersona: number }) => m.idPersona), [2, 1]);
    const ana = cuerpo.find((m: { idPersona: number }) => m.idPersona === 1);
    assert.equal(ana.nombrePersona, "Ana Maria");
    assert.equal(ana.apellidosPersona, "Lopez Reyes");
    assert.equal(ana.sexoPersona, "F");
    assert.equal(ana.correoPersona, "ana@unah.hn");
    assert.equal(ana.carreraEstudiante, "Medicina");
    assert.equal(ana.idCampus, 1);
    const zoe = cuerpo.find((m: { idPersona: number }) => m.idPersona === 2);
    assert.equal(zoe.correoPersona, "zoe@unah.edu.hn");
    // Una sola consulta a Registro para toda la lista.
    assert.equal(cuantasCon(REGISTRO), 1);
    assert.deepEqual(consultaCon(REGISTRO).valores, { c0: "20201000001" });
  });

  test("si Registro no responde, la lista carga con los datos locales", async () => {
    responderPor([
      [REGISTRO, () => { throw new Error("linked server caido"); }],
      [/FROM Voluntariado\.tblMiembrosGrupos m/, [
        { idPersona: 1, idCargo: 1, nombrePersona: null, apellidosPersona: null, numeroCuenta: "20201000001" },
      ]],
      [/FROM Voluntariado\.tblGrupos/, [{ hay: 1 }]],
    ]);
    const { codigo, cuerpo } = await invocar("GET", "/v1/voluntariado/grupos/5/miembros");
    assert.equal(codigo, 200);
    assert.equal(cuerpo.length, 1);
  });
});

describe("POST /solicitudes-grupos/{id}/resolucion con Registro", () => {
  const SOLICITUD = {
    idSolicitudGrupoNuevo: 7, nombreGrupo: "Grupo nuevo", idCampus: 1, idGrupoCreado: null,
    resenaHistorica: null, propositoGrupo: "Proposito", fechaCreacionGrupo: null, codigoEstado: "PENDIENTE",
  };

  test("crea la persona de una cuenta que Registro conoce y reporta la que no", async () => {
    responderPor([
      [/FROM Catalogo\.tblEstados/, [{ idEstado: 51, codigoEstado: "APROBADA" }]],
      // Cuentas de la solicitud sin persona local (antes de la transaccion).
      [/UNION SELECT numeroCuenta FROM Voluntariado\.tblSolicitudesMiembrosFundadores/, [
        { numeroCuenta: "20201000001" }, { numeroCuenta: "20209999999" },
      ]],
      [REGISTRO, [ANA]],
      [/INSERT INTO Voluntariado\.tblGrupos\s/, [{ idGrupo: 40 }]],
      [/FROM Voluntariado\.tblSolicitudesJuntasDirectivas/, [{ numeroCuenta: "20201000001", idCargo: 2, idPersona: null }]],
      [/FROM Voluntariado\.tblSolicitudesMiembrosFundadores/, [{ numeroCuenta: "20209999999", idPersona: null }]],
      [/INSERT INTO Catalogo\.tblPersonas/, [{ idPersona: 900 }]],
      [/FROM Voluntariado\.tblSolicitudesGruposNuevos s/, [SOLICITUD]],
    ]);
    const { codigo, cuerpo } = await invocar("POST", "/v1/voluntariado/solicitudes-grupos/7/resolucion", {
      estado: "APROBADA",
      redesTematicas: [],
    });

    assert.equal(codigo, 200);
    // Registro se consulto una vez, con las dos cuentas, antes de escribir.
    assert.deepEqual(consultaCon(REGISTRO).valores, { c0: "20201000001", c1: "20209999999" });
    const posRegistro = registro.findIndex((c) => REGISTRO.test(c.texto));
    const posGrupo = registro.findIndex((c) => /INSERT INTO Voluntariado\.tblGrupos\s/.test(c.texto));
    assert.ok(posRegistro < posGrupo, "Registro se lee antes de la transaccion");

    // A la cuenta conocida se le crea persona, detalle y rol, y entra como coordinadora.
    assert.equal(cuantasCon(/INSERT INTO Catalogo\.tblPersonas/), 1);
    assert.deepEqual(consultaCon(/INSERT INTO Catalogo\.tblDetallesEstudiantes/).valores["cuenta"], "20201000001");
    assert.match(consultaCon(/INSERT INTO Catalogo\.tblPersonaPerfilRol/).texto, /Estudiante de pregrado/);
    const miembro = consultaCon(/INSERT INTO Voluntariado\.tblMiembrosGrupos/);
    assert.equal(miembro.valores["idPersona"], 900);
    assert.equal(miembro.valores["idCargo"], 2);

    // La que ni Registro conoce no se inventa.
    assert.deepEqual(cuerpo.cuentasSinPersona, ["20209999999"]);
  });
});
