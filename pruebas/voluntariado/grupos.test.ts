import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { invocar, responderPor } from "./ayuda";

describe("GET /grupos", () => {
  test("cada grupo trae su logo firmado; sin logo o de prototipo, null", async () => {
    responderPor([
      [/FROM Voluntariado\.tblGrupos g/, [
        { idGrupo: 1, nombreGrupo: "Con logo", logoUrl: "voluntariado/grupos/1/logo.png" },
        { idGrupo: 2, nombreGrupo: "Sin logo", logoUrl: null },
        { idGrupo: 3, nombreGrupo: "Prototipo", logoUrl: "prototipo/grupos/3/logo.png" },
      ]],
    ]);
    const { codigo, cuerpo } = await invocar("GET", "/v1/voluntariado/grupos");

    assert.equal(codigo, 200);
    assert.deepEqual(
      cuerpo.map((g: { idGrupo: number; urlLogo: string | null }) => [g.idGrupo, g.urlLogo]),
      [[1, "https://s3.simulado/voluntariado/grupos/1/logo.png?firmada"], [2, null], [3, null]],
    );
  });
});
