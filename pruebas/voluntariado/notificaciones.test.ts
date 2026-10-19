import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { consultaCon, cuantasCon, invocar, responderPor } from "./ayuda";

const AVISO = /INSERT INTO Catalogo\.tblNotificaciones/;
const avisos = () => cuantasCon(AVISO);

// Los estados se cachean por contexto: cada respuesta trae todos los codigos
// que usan estas pruebas.
const ESTADOS: [RegExp, unknown[]] = [/FROM Catalogo\.tblEstados\s+WHERE contextoEstado/, [
  { idEstado: 1, codigoEstado: "PENDIENTE" },
  { idEstado: 2, codigoEstado: "APROBADA" },
  { idEstado: 3, codigoEstado: "RECHAZADA" },
  { idEstado: 4, codigoEstado: "ACEPTADO" },
  { idEstado: 5, codigoEstado: "OBSERVADO" },
]];
const INFORME_ENVIADO: [RegExp, unknown[]] = [/SELECT e\.codigoEstado\s+FROM Voluntariado\.tblInformesTrimestrales/, [{ codigoEstado: "ENVIADO" }]];

describe("Avisos de Voluntariado", () => {
  test("observar un informe avisa a los coordinadores con las observaciones", async () => {
    responderPor([ESTADOS, INFORME_ENVIADO]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/informes/7/dictamen", {
      estado: "OBSERVADO",
      observaciones: "Faltan fotos de la jornada.",
    });

    assert.equal(codigo, 200);
    const aviso = consultaCon(AVISO);
    // Destinatarios: los coordinadores activos del grupo del informe.
    assert.match(aviso.texto, /m\.idCargo = 2 AND m\.estadoMiembroGrupo = 1/);
    assert.match(aviso.texto, /i\.idInformeTrimestral = @id/);
    assert.equal(aviso.valores["id"], 7);
    assert.equal(aviso.valores["tipo"], "INFORME_OBSERVADO");
    assert.equal(aviso.valores["observaciones"], "Faltan fotos de la jornada.");
  });

  test("si el aviso falla, el dictamen igual responde bien", async () => {
    responderPor([ESTADOS, INFORME_ENVIADO, [AVISO, () => { throw new Error("FK rota"); }]]);
    const { codigo, cuerpo } = await invocar("POST", "/v1/voluntariado/informes/7/dictamen", { estado: "ACEPTADO" });

    assert.equal(codigo, 200);
    assert.equal(cuerpo.estado, "ACEPTADO");
    assert.equal(avisos(), 1);
  });

  test("un dictamen rechazado por estado no avisa", async () => {
    responderPor([ESTADOS, [INFORME_ENVIADO[0], [{ codigoEstado: "ACEPTADO" }]]]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/informes/7/dictamen", { estado: "ACEPTADO" });
    assert.equal(codigo, 409);
    assert.equal(avisos(), 0);
  });

  test("aprobar una actividad avisa al grupo organizador", async () => {
    responderPor([ESTADOS, [/UPDATE Voluntariado\.tblActividades/, [{ idActividad: 34, idEstado: 2, aprobadaPorAdmin: true }]]]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/actividades/34/aprobacion", { estado: "APROBADA" });

    assert.equal(codigo, 200);
    const aviso = consultaCon(AVISO);
    assert.match(aviso.texto, /a\.idGrupoOrganizador = m\.idGrupo/);
    assert.equal(aviso.valores["tipo"], "ACTIVIDAD_APROBADA");
  });

  test("una actividad que no existe no avisa", async () => {
    responderPor([ESTADOS]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/actividades/34/aprobacion", { estado: "APROBADA" });
    assert.equal(codigo, 404);
    assert.equal(avisos(), 0);
  });

  test("pedir unirse avisa a los coordinadores del grupo", async () => {
    responderPor([
      ESTADOS,
      [/FROM Voluntariado\.tblGrupos/, [{ existe: 1 }]],
      [/INSERT INTO Voluntariado\.tblSolicitudesUniones/, [{ idSolicitudUnion: 9, idGrupo: 3, idPersona: 50 }]],
    ]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/grupos/3/solicitudes-union", { idPersona: 50 });

    assert.equal(codigo, 201);
    const aviso = consultaCon(AVISO);
    assert.match(aviso.texto, /UNION_SOLICITADA/);
    assert.equal(aviso.valores["idGrupo"], 3);
    assert.equal(aviso.valores["idPersona"], 50);
  });

  test("emitir un diploma avisa al estudiante", async () => {
    responderPor([[/INSERT INTO Voluntariado\.tblDiplomas/, [{ idDiploma: 12 }]]]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/diplomas", {
      idGrupo: 3,
      idPersona: 50,
      ventanaDiploma: "2026-II",
      actividadesGrupo: 4,
      actividadesAsistidas: 4,
      porcentajeParticipacion: 100,
    });

    assert.equal(codigo, 201);
    const aviso = consultaCon(AVISO);
    assert.match(aviso.texto, /DIPLOMA_EMITIDO/);
    assert.equal(aviso.valores["idPersona"], 50);
  });
});
