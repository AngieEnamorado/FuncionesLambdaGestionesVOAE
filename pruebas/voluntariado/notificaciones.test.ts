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

// Destinatarios: un coordinador estudiante (sin correo local, lo da Registro).
const COORDINADORES_INFORME: [RegExp, unknown[]] = [/tblMiembrosGrupos m[\s\S]*tblInformesTrimestrales i/, [
  { idPersona: 80, correoPersona: null, numeroCuenta: "20201000001", numeroTrimestre: 4, anioTrimestre: 2026 },
]];
const REGISTRO: [RegExp, unknown[]] = [/FROM Catalogo\.vwEstudiantesRegistro/, [
  { numeroCuenta: "20201000001", primerNombre: "Ana", primerApellido: "Lopez", correoInstitucional: "ana.lopez@unah.hn", idGenero: "2" },
]];

describe("Avisos de Voluntariado", () => {
  test("observar un informe avisa a los coordinadores, con el correo de Registro y las observaciones", async () => {
    responderPor([ESTADOS, INFORME_ENVIADO, REGISTRO, COORDINADORES_INFORME]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/informes/7/dictamen", {
      estado: "OBSERVADO",
      observaciones: "Faltan fotos de la jornada.",
    });

    assert.equal(codigo, 200);
    // Destinatarios: los coordinadores activos del grupo del informe.
    const destinos = consultaCon(COORDINADORES_INFORME[0]);
    assert.match(destinos.texto, /m\.idCargo = 2 AND m\.estadoMiembroGrupo = 1/);
    assert.match(destinos.texto, /i\.idInformeTrimestral = @id/);
    assert.equal(destinos.valores["id"], 7);

    const aviso = consultaCon(AVISO);
    assert.equal(aviso.valores["tipo"], "INFORME_OBSERVADO");
    assert.equal(aviso.valores["idPersona"], 80);
    assert.equal(aviso.valores["correo"], "ana.lopez@unah.hn");
    assert.equal(aviso.valores["asunto"], "Tu informe del IV Trimestre 2026 fue observado");
    assert.match(String(aviso.valores["cuerpo"]), /Observaciones: Faltan fotos de la jornada\./);
  });

  test("si Registro no tiene a la persona, el correo queda el local o vacio", async () => {
    responderPor([ESTADOS, INFORME_ENVIADO, [COORDINADORES_INFORME[0], [
      { idPersona: 81, correoPersona: "empleado@unah.edu.hn", numeroCuenta: null, numeroTrimestre: 1, anioTrimestre: 2027 },
    ]]]);
    await invocar("POST", "/v1/voluntariado/informes/7/dictamen", { estado: "ACEPTADO" });
    assert.equal(consultaCon(AVISO).valores["correo"], "empleado@unah.edu.hn");
  });

  test("si el aviso falla, el dictamen igual responde bien", async () => {
    responderPor([ESTADOS, INFORME_ENVIADO, COORDINADORES_INFORME, [AVISO, () => { throw new Error("FK rota"); }]]);
    const { codigo, cuerpo } = await invocar("POST", "/v1/voluntariado/informes/7/dictamen", { estado: "ACEPTADO" });

    assert.equal(codigo, 200);
    assert.equal(cuerpo.estado, "ACEPTADO");
    assert.equal(avisos(), 1);
  });

  test("un dictamen rechazado por estado no avisa", async () => {
    responderPor([ESTADOS, [INFORME_ENVIADO[0], [{ codigoEstado: "ACEPTADO" }]], COORDINADORES_INFORME]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/informes/7/dictamen", { estado: "ACEPTADO" });
    assert.equal(codigo, 409);
    assert.equal(avisos(), 0);
  });

  test("aprobar una actividad avisa al grupo organizador", async () => {
    const DESTINOS: [RegExp, unknown[]] = [/tblMiembrosGrupos m[\s\S]*a\.idGrupoOrganizador = m\.idGrupo/, [
      { idPersona: 80, correoPersona: null, numeroCuenta: null, nombreActividad: "Jornada" },
    ]];
    responderPor([ESTADOS, DESTINOS, [/UPDATE Voluntariado\.tblActividades/, [{ idActividad: 34, idEstado: 2, aprobadaPorAdmin: true }]]]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/actividades/34/aprobacion", { estado: "APROBADA" });

    assert.equal(codigo, 200);
    const aviso = consultaCon(AVISO);
    assert.equal(aviso.valores["tipo"], "ACTIVIDAD_APROBADA");
    assert.equal(aviso.valores["asunto"], "La actividad «Jornada» fue aprobada");
  });

  test("una actividad que no existe no avisa", async () => {
    responderPor([ESTADOS]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/actividades/34/aprobacion", { estado: "APROBADA" });
    assert.equal(codigo, 404);
    assert.equal(avisos(), 0);
  });

  test("pedir unirse avisa a los coordinadores con el nombre del estudiante de Registro", async () => {
    responderPor([
      ESTADOS,
      REGISTRO,
      [/tblMiembrosGrupos m[\s\S]*INNER JOIN Voluntariado\.tblGrupos g/, [
        { idPersona: 80, correoPersona: null, numeroCuenta: null, nombreGrupo: "Brigada" },
      ]],
      [/AS nombre, de\.numeroCuenta/, [{ nombre: null, numeroCuenta: "20201000001" }]],
      [/FROM Voluntariado\.tblGrupos/, [{ existe: 1 }]],
      [/INSERT INTO Voluntariado\.tblSolicitudesUniones/, [{ idSolicitudUnion: 9, idGrupo: 3, idPersona: 50 }]],
    ]);
    const { codigo } = await invocar("POST", "/v1/voluntariado/grupos/3/solicitudes-union", { idPersona: 50 });

    assert.equal(codigo, 201);
    const aviso = consultaCon(AVISO);
    assert.equal(aviso.valores["tipo"], "UNION_SOLICITADA");
    assert.equal(aviso.valores["idPersona"], 80);
    assert.match(String(aviso.valores["cuerpo"]), /^Ana Lopez pidió unirse al grupo/);
  });

  test("emitir un diploma avisa al estudiante", async () => {
    responderPor([
      [/INSERT INTO Voluntariado\.tblDiplomas/, [{ idDiploma: 12 }]],
      [/FROM Catalogo\.tblPersonas p[\s\S]*INNER JOIN Voluntariado\.tblGrupos g ON g\.idGrupo = @idGrupo/, [
        { idPersona: 50, correoPersona: null, numeroCuenta: null, nombreGrupo: "Brigada" },
      ]],
    ]);
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
    assert.equal(aviso.valores["tipo"], "DIPLOMA_EMITIDO");
    assert.equal(aviso.valores["idPersona"], 50);
  });
});
