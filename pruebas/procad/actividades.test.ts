import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { handler } from "../../src/funciones/procad/index";
import { alConsultar, llamadas } from "../dobles/db";
import { invocar } from "../evento";
import { cuantasCon, errorDeTrigger, llamadaCon, responderPor } from "./ayuda";

const ACTIVIDAD = { idActividad: 11, codigoEstado: "PENDIENTE_VALIDACION" };

beforeEach(() => alConsultar(() => []));

describe("GET /actividades", () => {
  test("filtra por grupo, estado y rango de fechas", async () => {
    const { codigo } = await invocar(
      handler, "GET", "/v1/procad/actividades?grupo=4&estado=pendiente_validacion&desde=2026-01-01&hasta=2026-06-30",
    );
    assert.equal(codigo, 200);
    assert.deepEqual(llamadaCon(/FROM Procad\.tblActividades a/).parametros, {
      grupo: 4, estado: "PENDIENTE_VALIDACION", desde: "2026-01-01", hasta: "2026-06-30",
    });
  });

  test("una fecha invalida es 400", async () => {
    const { codigo } = await invocar(handler, "GET", "/v1/procad/actividades?desde=2026-02-30");
    assert.equal(codigo, 400);
  });
});

describe("POST /actividades", () => {
  test("nace PENDIENTE_VALIDACION", async () => {
    responderPor([
      [/INSERT INTO Procad\.tblActividades/, [{ id: 11 }]],
      [/FROM Procad\.tblActividades a/, [ACTIVIDAD]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/actividades", {
      idGrupo: 4, idPeriodo: 3, fechaActividad: "2026-10-01", idTipoActividad: 5,
    });
    assert.equal(codigo, 201);
    assert.equal(cuerpo.idActividad, 11);
    assert.equal(llamadaCon(/INSERT INTO Procad\.tblActividades/).parametros["pendiente"], "PENDIENTE_VALIDACION");
  });

  test("un tipo de actividad no habilitado para el grupo lo rechaza el trigger", async () => {
    const mensaje = "Ese tipo de actividad no esta habilitado para este grupo especifico.";
    responderPor([[/INSERT INTO/, () => { throw errorDeTrigger(mensaje); }]]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/actividades", {
      idGrupo: 4, idPeriodo: 3, fechaActividad: "2026-10-01", idTipoActividad: 5,
    });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });
});

describe("POST /actividades/{id}/validacion", () => {
  test("valida una pendiente", async () => {
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ codigoEstado: "PENDIENTE_VALIDACION" }]],
      [/FROM Procad\.tblActividades a/, [ACTIVIDAD]],
    ]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/actividades/11/validacion", {
      decision: "validada", idPersonaValidadora: 30,
    });
    assert.equal(codigo, 200);
    const update = llamadaCon(/UPDATE Procad\.tblActividades/);
    assert.equal(update.parametros["decision"], "VALIDADA");
    assert.match(update.texto, /fechaValidacion = SYSDATETIME\(\)/);
  });

  test("rechazar sin observacion es 400 (RF-27)", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/actividades/11/validacion", {
      decision: "RECHAZADA", idPersonaValidadora: 30,
    });
    assert.equal(codigo, 400);
    assert.equal(llamadas.length, 0);
  });

  test("una ya validada es 409", async () => {
    responderPor([[/WITH \(UPDLOCK\)/, [{ codigoEstado: "VALIDADA" }]]]);
    const { codigo } = await invocar(handler, "POST", "/v1/procad/actividades/11/validacion", {
      decision: "RECHAZADA", idPersonaValidadora: 30, observacion: "Duplicada",
    });
    assert.equal(codigo, 409);
  });

  test("si quien valida no es admin, el trigger responde 409", async () => {
    const mensaje = "La persona validadora debe tener el rol PROCAD ADMINISTRADOR_PROCAD.";
    responderPor([
      [/WITH \(UPDLOCK\)/, [{ codigoEstado: "PENDIENTE_VALIDACION" }]],
      [/UPDATE/, () => { throw errorDeTrigger(mensaje); }],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/actividades/11/validacion", {
      decision: "VALIDADA", idPersonaValidadora: 30,
    });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });
});

describe("Asistencia", () => {
  const marcas = {
    asistencias: [
      { idSolicitud: 1, asistio: true },
      { idSolicitud: 2, asistio: false, esExcusado: true, justificacionExcusa: "Enfermedad", idPersonaValidaExcusa: 20 },
    ],
  };

  test("POST pasa cada marca por spRegistrarAsistencia", async () => {
    responderPor([
      [/SELECT idActividad FROM Procad\.tblActividades/, [{ idActividad: 11 }]],
      [/FROM Procad\.tblActividades a/, [ACTIVIDAD]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/actividades/11/asistencia", marcas);

    assert.equal(codigo, 200);
    assert.equal(cuerpo.actividad.idActividad, 11);
    assert.equal(cuantasCon(/^Procad\.spRegistrarAsistencia$/), 2);
    const excusada = llamadas.filter((l) => l.texto === "Procad.spRegistrarAsistencia")[1]!;
    assert.equal(excusada.parametros["esExcusado"], true);
    assert.equal(excusada.parametros["idPersonaValidaExcusa"], 20);
  });

  test("si alguien nuevo en la lista no esta matriculado, no se escribe ninguna marca", async () => {
    responderPor([
      [/SELECT idActividad FROM Procad\.tblActividades/, [{ idActividad: 11 }]],
      [/NOT EXISTS \(SELECT 1 FROM Procad\.tblAsistencias/, [
        { idSolicitud: 1, numeroCuenta: "20201000001" },
        { idSolicitud: 2, numeroCuenta: "20201000002" },
      ]],
      [/Registro\.spObtenerEstudiantes/, [
        { numeroCuenta: "20201000001", matriculado: true },
        { numeroCuenta: "20201000002", matriculado: false },
      ]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/actividades/11/asistencia", marcas);
    assert.equal(codigo, 409);
    assert.match(cuerpo.error, /solicitudes 2:/);
    assert.equal(cuantasCon(/spRegistrarAsistencia/), 0);
  });

  test("sin estudiantes es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/actividades/11/asistencia", { asistencias: [] });
    assert.equal(codigo, 400);
  });

  test("un estudiante repetido es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/actividades/11/asistencia", {
      asistencias: [{ idSolicitud: 1, asistio: true }, { idSolicitud: 1, asistio: false }],
    });
    assert.equal(codigo, 400);
  });

  test("sobre una actividad no validada, el trigger rechaza todo el pase", async () => {
    const mensaje = "La inscripcion y el pase de lista solo se permiten sobre actividades VALIDADAS.";
    responderPor([
      [/SELECT idActividad FROM Procad\.tblActividades/, [{ idActividad: 11 }]],
      [/spRegistrarAsistencia/, () => { throw errorDeTrigger(mensaje); }],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/actividades/11/asistencia", marcas);
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });

  test("GET devuelve la actividad y su lista", async () => {
    responderPor([
      [/FROM Procad\.tblAsistencias x\s+INNER JOIN/, [{ idAsistencia: 1, estadoAsistencia: "PRESENTE" }]],
      [/FROM Procad\.tblActividades a/, [ACTIVIDAD]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "GET", "/v1/procad/actividades/11/asistencia");
    assert.equal(codigo, 200);
    assert.equal(cuerpo.asistencias[0].estadoAsistencia, "PRESENTE");
  });
});

describe("POST /series", () => {
  const serie = {
    idGrupo: 4, idPeriodo: 3, idTipoActividad: 1,
    fechaInicioSerie: "2026-10-01", fechaFinSerie: "2026-11-30", horaSerie: "17:00", diasSemana: [2, 4],
  };

  test("crea la serie, sus dias y llama a spGenerarActividadesSerie", async () => {
    responderPor([
      [/INSERT INTO Procad\.tblSeriesActividades\s/, [{ id: 6 }]],
      [/FROM Procad\.tblSeriesActividades sa/, [{ idSerie: 6, dias: '[{"diaSemana":2},{"diaSemana":4}]', actividadesGeneradas: 17 }]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/series", serie);

    assert.equal(codigo, 201);
    assert.deepEqual(cuerpo.dias, [2, 4]);
    assert.equal(cuerpo.actividadesGeneradas, 17);
    assert.equal(cuantasCon(/INSERT INTO Procad\.tblSeriesActividadesDias/), 2);
    assert.equal(llamadaCon(/EXEC Procad\.spGenerarActividadesSerie/).parametros["serie"], 6);
    // La recurrencia es del SP: el codigo no inserta actividades.
    assert.equal(cuantasCon(/INSERT INTO Procad\.tblActividades/), 0);
  });

  test("fin antes que inicio es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/series", { ...serie, fechaFinSerie: "2026-09-01" });
    assert.equal(codigo, 400);
  });

  test("mas de 366 dias es 400: el SP no los recorre", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/series", { ...serie, fechaFinSerie: "2027-12-01" });
    assert.equal(codigo, 400);
  });

  test("un dia de la semana fuera de 1..7 es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/series", { ...serie, diasSemana: [8] });
    assert.equal(codigo, 400);
  });

  test("sin dias es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/series", { ...serie, diasSemana: [] });
    assert.equal(codigo, 400);
  });
});

describe("POST /periodos/activar", () => {
  test("devuelve el resumen de spActivarNuevoPeriodo, con los omitidos como lista", async () => {
    alConsultar((l) => l.tipo === "procedimiento"
      ? [{
          integrantesCopiados: 40, condicionadosPorReconfirmar: 2, rolesIntegranteRetirados: 3,
          omitidos: '[{"idSolicitud":9,"motivo":"La matricula no esta verificada."}]',
        }]
      : []);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/periodos/activar", {
      idPeriodoAnterior: 2, idPeriodoNuevo: 3,
    });

    assert.equal(codigo, 200);
    assert.equal(cuerpo.integrantesCopiados, 40);
    assert.equal(cuerpo.condicionadosPorReconfirmar, 2);
    assert.equal(cuerpo.omitidos[0].motivo, "La matricula no esta verificada.");
    const sp = llamadas.find((l) => l.tipo === "procedimiento")!;
    assert.equal(sp.texto, "Procad.spActivarNuevoPeriodo");
    assert.deepEqual([sp.parametros["idPeriodoAnterior"], sp.parametros["idPeriodoNuevo"]], [2, 3]);
    // Con resumen no hace falta contar a mano.
    assert.equal(cuantasCon(/COUNT\(\*\) AS integrantes/), 0);
  });

  test("con el SP anterior (sin resumen) cuenta los integrantes del periodo nuevo", async () => {
    responderPor([[/COUNT\(\*\) AS integrantes/, [{ integrantes: 40 }]]]);
    const { cuerpo } = await invocar(handler, "POST", "/v1/procad/periodos/activar", {
      idPeriodoAnterior: 2, idPeriodoNuevo: 3,
    });
    assert.equal(cuerpo.integrantesEnPeriodoNuevo, 40);
  });

  test("un periodo nuevo que no es posterior: el SP responde y sale 409", async () => {
    const mensaje = "El periodo nuevo debe ser posterior al periodo anterior.";
    alConsultar((l) => {
      if (l.tipo === "procedimiento") throw errorDeTrigger(mensaje);
      return [];
    });
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/periodos/activar", {
      idPeriodoAnterior: 3, idPeriodoNuevo: 2,
    });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
  });

  test("el mismo periodo dos veces es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/periodos/activar", {
      idPeriodoAnterior: 3, idPeriodoNuevo: 3,
    });
    assert.equal(codigo, 400);
  });
});

describe("Detalle de la actividad (columnas del 2026-09-23)", () => {
  const detallada = {
    idGrupo: 4, idPeriodo: 3, fechaActividad: "2026-10-01", idTipoActividad: 5,
    tituloActividad: "Concierto de apertura", horaActividad: "17:30", lugarActividad: "Auditorio Juan Lindo",
    horasAbonadas: 3.5, justificacionActividad: "Semana cultural", idPersonaReporta: 20,
    adjuntos: [
      { nombreArchivo: "lista.pdf", urlArchivo: "actividades/lista.pdf" },
      { nombreArchivo: "foto.jpg", urlArchivo: "actividades/foto.jpg" },
    ],
  };

  test("POST guarda el detalle y cada adjunto, y devuelve los adjuntos como lista", async () => {
    responderPor([
      [/INSERT INTO Procad\.tblActividades/, [{ id: 11 }]],
      [/FROM Procad\.tblActividades a/, [{ ...ACTIVIDAD, adjuntos: '[{"nombreArchivo":"lista.pdf"}]' }]],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/actividades", detallada);

    assert.equal(codigo, 201);
    assert.deepEqual(cuerpo.adjuntos, [{ nombreArchivo: "lista.pdf" }]);
    const insert = llamadaCon(/INSERT INTO Procad\.tblActividades/);
    assert.equal(insert.parametros["titulo"], "Concierto de apertura");
    assert.equal(insert.parametros["horas"], 3.5);
    assert.equal(insert.parametros["reporta"], 20);
    assert.equal(cuantasCon(/INSERT INTO Procad\.tblAdjuntosActividades/), 2);
  });

  test("horas con mas de un decimal es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/actividades", { ...detallada, horasAbonadas: 2.25 });
    assert.equal(codigo, 400);
  });

  test("horas negativas es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/actividades", { ...detallada, horasAbonadas: -1 });
    assert.equal(codigo, 400);
  });

  test("un adjunto sin enlace es 400", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/actividades", {
      ...detallada, adjuntos: [{ nombreArchivo: "lista.pdf" }],
    });
    assert.equal(codigo, 400);
    assert.equal(llamadas.length, 0);
  });

  test("GET /actividades trae al encargado y los adjuntos", async () => {
    responderPor([[/FROM Procad\.tblActividades a/, [{ idActividad: 1, nombreReporta: "Diego", adjuntos: null }]]]);
    const { cuerpo } = await invocar(handler, "GET", "/v1/procad/actividades");
    assert.equal(cuerpo[0].nombreReporta, "Diego");
    assert.deepEqual(cuerpo[0].adjuntos, []);
    assert.match(llamadaCon(/FROM Procad\.tblActividades a/).texto, /LEFT JOIN Catalogo\.tblPersonas pr/);
  });
});
