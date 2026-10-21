import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cuantasCon, invocar, responderPor } from "./ayuda";

const RUTA = "/v1/voluntariado/informes/2";
const INFORME = /FROM Voluntariado\.tblInformesTrimestrales i[\s\S]*WHERE i\.idInformeTrimestral = @id/;
const borrados = () => cuantasCon(/DELETE FROM Voluntariado\.tblInformesTrimestralesActividades/);

describe("PUT /informes/{id} (actividades del informe)", () => {
  for (const estado of ["EN_CAPTURA", "OBSERVADO"]) {
    test(`con el informe ${estado} fija las actividades`, async () => {
      responderPor([[INFORME, [{ idInformeTrimestral: 2, codigoEstado: estado }]]]);
      const { codigo, cuerpo } = await invocar("PUT", RUTA, { actividades: [3, 5] });
      assert.equal(codigo, 200);
      assert.deepEqual(cuerpo, { idInformeTrimestral: 2, actividades: 2 });
      assert.equal(borrados(), 1);
    });
  }

  for (const estado of ["ENVIADO", "ACEPTADO"]) {
    test(`con el informe ${estado} es 409 y no toca su contenido`, async () => {
      responderPor([[INFORME, [{ idInformeTrimestral: 2, codigoEstado: estado }]]]);
      const { codigo, cuerpo } = await invocar("PUT", RUTA, { actividades: [3] });
      assert.equal(codigo, 409);
      assert.match(cuerpo.error, /ya no cambia sus actividades/);
      assert.equal(borrados(), 0);
    });
  }
});
