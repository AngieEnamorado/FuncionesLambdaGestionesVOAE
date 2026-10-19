import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { registro, responder } from "./dobles/db";
import { cuantasCon, invocar, responderPor } from "./ayuda";

const RUTA = "/v1/voluntariado/actividades/34/asistencia";
const ACTIVIDAD = { idActividad: 34, idGrupoOrganizador: 23, idPeriodo: 130, codigoEstado: "APROBADA", nombreGrupo: "G" };
const ESTADOS: Record<string, { idEstado: number; codigoEstado: string }[]> = {
  VOL_PARTICIPACION: [{ idEstado: 20, codigoEstado: "ASISTIO" }, { idEstado: 21, codigoEstado: "NO_ASISTIO" }],
  VOL_ACTIVIDAD: [{ idEstado: 9, codigoEstado: "APROBADA" }, { idEstado: 10, codigoEstado: "EJECUTADA" }],
};

/** Una linea de asistencia de Karla con esas horas. */
const lista = (estado: string, horas?: unknown) => ({ participaciones: [{ idPersona: 4499, estado, horas }] });
const escrituras = () => cuantasCon(/INSERT INTO Voluntariado\.tblParticipaciones|UPDATE Voluntariado\.tblParticipaciones/);

beforeEach(() =>
  responderPor([
    [/FROM Voluntariado\.tblActividades a/, [ACTIVIDAD]],
    [/FROM Catalogo\.tblEstados/, (c) => ESTADOS[String(c.valores["contexto"])] ?? []],
  ]),
);

describe("POST /actividades/{id}/asistencia: horas", () => {
  for (const [caso, horas] of [
    ["mas de 12 horas", 34],
    ["12.5 horas", 12.5],
    ["horas negativas", -2],
    ["horas con texto", "cuatro"],
  ] as const) {
    test(`${caso} es 400 y no escribe`, async () => {
      const { codigo, cuerpo } = await invocar("POST", RUTA, lista("ASISTIO", horas));
      assert.equal(codigo, 400);
      assert.match(cuerpo.error, /horas/);
      assert.equal(escrituras(), 0);
    });
  }

  test("asistio con 0 horas es 400", async () => {
    const { codigo } = await invocar("POST", RUTA, lista("ASISTIO", 0));
    assert.equal(codigo, 400);
    assert.equal(escrituras(), 0);
  });

  test("12 horas exactas se aceptan y se guardan tal cual", async () => {
    const { codigo } = await invocar("POST", RUTA, lista("ASISTIO", 12));
    assert.equal(codigo, 200);
    const insercion = registro.find((c) => /INSERT INTO Voluntariado\.tblParticipaciones/.test(c.texto));
    assert.equal(insercion?.valores["horas"], 12);
  });

  test("no asistio sin horas pasa con horas en null", async () => {
    const { codigo } = await invocar("POST", RUTA, lista("NO_ASISTIO"));
    assert.equal(codigo, 200);
    const insercion = registro.find((c) => /INSERT INTO Voluntariado\.tblParticipaciones/.test(c.texto));
    assert.equal(insercion?.valores["horas"], null);
  });

  test("una actividad que no existe es 404", async () => {
    responder(() => []);
    const { codigo } = await invocar("POST", RUTA, lista("ASISTIO", 4));
    assert.equal(codigo, 404);
  });
});
