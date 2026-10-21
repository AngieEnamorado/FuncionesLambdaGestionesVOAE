import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { invalidarCache } from "../../src/compartido/catalogos";
import { handler } from "../../src/funciones/procad/index";
import { alConsultar, llamadas } from "../dobles/db";
import { invocar } from "../evento";
import { cuantasCon, llamadaCon, responderPor } from "./ayuda";

const CATALOGOS = [
  "tiposGrupo", "deportes", "posiciones", "disciplinas", "instrumentos",
  "tiposActividad", "motivosExpulsion", "lugaresVisoria", "aulas",
];

/** Responde a cada consulta con una fila que dice de que tabla salio. */
const unaFilaPorTabla = () =>
  alConsultar(({ texto }) => [{ tabla: /FROM\s+(\S+)/.exec(texto)?.[1] }]);

beforeEach(() => {
  invalidarCache();
  unaFilaPorTabla();
});

test("GET /catalogos devuelve los nueve catalogos, cada uno de su tabla", async () => {
  const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/catalogos");

  assert.equal(codigo, 200);
  assert.deepEqual(Object.keys(cuerpo).sort(), [...CATALOGOS].sort());
  assert.deepEqual(cuerpo.deportes, [{ tabla: "Procad.tblDeportes" }]);
  assert.deepEqual(cuerpo.aulas, [{ tabla: "Procad.tblAulas" }]);
});

test("por defecto filtra activos en las tablas con columna de estado, y solo en esas", async () => {
  await invocar(handler, "GET", "/v1/procad/catalogos");

  const sqlDe = (tabla: string) => llamadas.find((l) => l.texto.includes(`FROM ${tabla}`))!.texto;
  assert.match(sqlDe("Procad.tblDeportes"), /WHERE estadoDeporte = 1/);
  assert.match(sqlDe("Procad.tblLugaresVisoria"), /WHERE estadoLugar = 1/);
  // Sin columna de estado no hay nada que filtrar: todas sus filas estan vigentes.
  assert.doesNotMatch(sqlDe("Procad.tblMotivosExpulsion"), /WHERE/);
  assert.match(sqlDe("Procad.tblMotivosExpulsion"), /CAST\(1 AS BIT\) AS activo/);
});

test("la segunda lectura sale del cache y no toca la base", async () => {
  await invocar(handler, "GET", "/v1/procad/catalogos");
  assert.equal(llamadas.length, CATALOGOS.length);

  const { codigo } = await invocar(handler, "GET", "/v1/procad/catalogos");
  assert.equal(codigo, 200);
  assert.equal(llamadas.length, CATALOGOS.length);
});

test("?todos=true incluye inactivos y siempre va a la base", async () => {
  await invocar(handler, "GET", "/v1/procad/catalogos?todos=true");
  await invocar(handler, "GET", "/v1/procad/catalogos?todos=true");

  assert.equal(llamadas.length, CATALOGOS.length * 2);
  assert.ok(llamadas.every((l) => !/WHERE/.test(l.texto)));
});

test("?todos con un valor no booleano es 400", async () => {
  const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/catalogos?todos=quizas");

  assert.equal(codigo, 400);
  assert.match(cuerpo.error, /todos/);
  assert.equal(llamadas.length, 0);
});

test("con la base pausada responde 503, no 500", async () => {
  alConsultar(() => {
    throw Object.assign(new Error("Failed to connect"), { code: "ETIMEOUT" });
  });

  const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/catalogos");

  assert.equal(codigo, 503);
  assert.match(cuerpo.error, /no esta disponible/);
});

test("un fallo al cargar no queda cacheado", async () => {
  alConsultar(() => {
    throw Object.assign(new Error("Failed to connect"), { code: "ETIMEOUT" });
  });
  await invocar(handler, "GET", "/v1/procad/catalogos");

  unaFilaPorTabla();
  const { codigo } = await invocar(handler, "GET", "/v1/procad/catalogos");
  assert.equal(codigo, 200);
});

test("POST /catalogos es 405: es de solo lectura", async () => {
  const { codigo } = await invocar(handler, "POST", "/v1/procad/catalogos", {});
  assert.equal(codigo, 405);
});

describe("Usuarios del panel", () => {
  test("GET lista a las personas con roles de PROCAD, sin INTEGRANTE", async () => {
    const { codigo } = await invocar(handler, "GET", "/v1/procad/usuarios");
    assert.equal(codigo, 200);
    const { texto } = llamadaCon(/FROM Catalogo\.tblPersonaPerfilRol ppr/);
    assert.match(texto, /r\.nombreRol <> N'INTEGRANTE'/);
  });

  test("PUT desactiva sus roles de PROCAD", async () => {
    responderPor([[/FROM Catalogo\.tblPersonaPerfilRol ppr\s+INNER JOIN Catalogo\.tblRoles r\s+ON r\.idRol = ppr\.idRol\s+INNER JOIN/, [
      { idPersona: 9, nombrePersona: "Ana", activo: true },
    ]]]);
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/usuarios/9", { activo: false });
    assert.equal(codigo, 200);
    const update = llamadaCon(/UPDATE ppr/);
    assert.deepEqual(update.parametros, { persona: 9, activo: false });
  });

  test("PUT de alguien sin roles de PROCAD es 404 y no actualiza", async () => {
    responderPor([]);
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/usuarios/9", { activo: false });
    assert.equal(codigo, 404);
    assert.equal(cuantasCon(/UPDATE ppr/), 0);
  });
});
