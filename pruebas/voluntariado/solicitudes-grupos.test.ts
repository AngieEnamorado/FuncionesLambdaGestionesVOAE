import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { handler } from "../../src/funciones/voluntariado/index";
import { alConsultar, llamadas } from "../dobles/db";
import { invocar } from "../evento";
import { cuantasCon, llamadaCon, responderPor } from "../procad/ayuda";

const RUTA = "/v1/voluntariado/solicitudes-grupos/7/resolucion";
const SOLICITUD = {
  idSolicitudGrupoNuevo: 7, nombreGrupo: "Grupo nuevo", idCampus: 1, idGrupoCreado: null,
  resenaHistorica: "Resena", propositoGrupo: "Proposito", fechaCreacionGrupo: null, codigoEstado: "PENDIENTE",
};
const CARGO_COORDINADOR = 2;
const CARGO_PRESIDENTE = 3;
const CARGO_MIEMBRO = 1;

/** Responde como la base a una solicitud con esa junta y esos fundadores. */
function base(junta: unknown[], fundadores: unknown[]) {
  responderPor([
    [/FROM Catalogo\.tblEstados/, [{ idEstado: 51, codigoEstado: "APROBADA" }, { idEstado: 52, codigoEstado: "RECHAZADA" }]],
    [/INSERT INTO Voluntariado\.tblGrupos\s/, [{ idGrupo: 40 }]],
    [/FROM Voluntariado\.tblSolicitudesJuntasDirectivas/, junta],
    [/FROM Voluntariado\.tblSolicitudesMiembrosFundadores/, fundadores],
    [/FROM Voluntariado\.tblSolicitudesGruposNuevos s/, [SOLICITUD]],
  ]);
}

const insercionesDeMiembros = () =>
  llamadas
    .filter((l) => /INSERT INTO Voluntariado\.tblMiembrosGrupos/.test(l.texto))
    .map((l) => ({ idPersona: l.parametros["idPersona"], idCargo: l.parametros["idCargo"] }));

beforeEach(() => alConsultar(() => []));

describe("POST /solicitudes-grupos/{id}/resolucion", () => {
  test("al aprobar, el grupo nace con el logo adjunto a la solicitud", async () => {
    base([], []);
    const { codigo } = await invocar(handler, "POST", RUTA, { estado: "APROBADA", redesTematicas: [7] });

    assert.equal(codigo, 200);
    const { texto, parametros } = llamadaCon(/INSERT INTO Voluntariado\.tblGrupos\s/);
    assert.match(texto, /logoUrl/);
    assert.match(texto, /tblAdjuntosSolicitudes/);
    assert.match(texto, /tipoRequisito = N'LOGO'/);
    assert.equal(parametros["id"], 7);
  });

  test("los fundadores que no estan en la junta entran como miembros sin cargo", async () => {
    base(
      [{ numeroCuenta: "100", idCargo: CARGO_COORDINADOR, idPersona: 1 }],
      [{ numeroCuenta: "200", idPersona: 2 }, { numeroCuenta: "300", idPersona: 3 }],
    );
    const { codigo, cuerpo } = await invocar(handler, "POST", RUTA, { estado: "APROBADA", redesTematicas: [7] });

    assert.equal(codigo, 200);
    assert.deepEqual(insercionesDeMiembros(), [
      { idPersona: 1, idCargo: CARGO_COORDINADOR },
      { idPersona: 2, idCargo: CARGO_MIEMBRO },
      { idPersona: 3, idCargo: CARGO_MIEMBRO },
    ]);
    assert.deepEqual(cuerpo.cuentasSinPersona, []);
  });

  test("un fundador que tambien esta en la junta entra una sola vez, con su cargo", async () => {
    base(
      [
        { numeroCuenta: "100", idCargo: CARGO_COORDINADOR, idPersona: 1 },
        { numeroCuenta: "200", idCargo: CARGO_PRESIDENTE, idPersona: 2 },
      ],
      [{ numeroCuenta: "200", idPersona: 2 }],
    );
    await invocar(handler, "POST", RUTA, { estado: "APROBADA", redesTematicas: [7] });

    assert.deepEqual(insercionesDeMiembros(), [
      { idPersona: 1, idCargo: CARGO_COORDINADOR },
      { idPersona: 2, idCargo: CARGO_PRESIDENTE },
    ]);
  });

  test("una cuenta sin persona se reporta una sola vez y no se inventa", async () => {
    base(
      [{ numeroCuenta: "999", idCargo: CARGO_PRESIDENTE, idPersona: null }],
      [{ numeroCuenta: "999", idPersona: null }, { numeroCuenta: "888", idPersona: null }],
    );
    const { cuerpo } = await invocar(handler, "POST", RUTA, { estado: "APROBADA", redesTematicas: [7] });

    assert.deepEqual(cuerpo.cuentasSinPersona, ["999", "888"]);
    assert.equal(insercionesDeMiembros().length, 0);
  });

  test("al rechazar no se crea grupo ni miembros", async () => {
    base([{ numeroCuenta: "100", idCargo: CARGO_COORDINADOR, idPersona: 1 }], [{ numeroCuenta: "200", idPersona: 2 }]);
    const { codigo } = await invocar(handler, "POST", RUTA, { estado: "RECHAZADA", motivo: "No cumple", redesTematicas: [] });

    assert.equal(codigo, 200);
    assert.equal(cuantasCon(/INSERT INTO Voluntariado\.tblGrupos\s/), 0);
    assert.equal(cuantasCon(/FROM Voluntariado\.tblSolicitudesMiembrosFundadores/), 0);
    assert.equal(insercionesDeMiembros().length, 0);
  });
});
