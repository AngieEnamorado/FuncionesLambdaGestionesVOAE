import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { handler } from "../../src/funciones/procad/index";
import { alConsultar, llamadas } from "../dobles/db";
import { invocar } from "../evento";
import { cuantasCon, errorDeTrigger, llamadaCon, responderPor } from "./ayuda";

const CUENTA = "20201000001";
const registro = (indicePeriodo: number | null) => ({
  numeroCuenta: CUENTA, primerNombre: "Ana", segundoNombre: null, primerApellido: "Lopez", segundoApellido: null,
  correoInstitucional: "ana@unah.hn", idCampus: 1, centro: "CIUDAD UNIVERSITARIA", carrera: "DERECHO",
  genero: "FEMENINO", indicePeriodo, indiceGlobal: 75, matriculado: true,
});
/** La ficha que devuelve obtenerSolicitud al final de crear y corregir. */
const FICHA = [/s\.idPersonaProponeCondicionado, s\.idPersonaAutorizaCondicionado/, [{ idSolicitud: 90, numeroCuenta: CUENTA }]] as const;

const FORMULARIO = {
  numeroCuenta: CUENTA,
  contactoEmergenciaNombre: "Maria Lopez",
  contactoEmergenciaTelefono: "9999-0000",
  aceptoReglamento: true,
};

beforeEach(() => alConsultar(() => []));

describe("GET /estudiantes/{cuenta}", () => {
  test("una cuenta que Registro no conoce es 404", async () => {
    const { codigo } = await invocar(handler, "GET", `/v1/procad/estudiantes/${CUENTA}`);
    assert.equal(codigo, 404);
  });

  test("con indice del periodo de 70 o mas cumple el minimo, aunque nunca haya pedido entrar", async () => {
    responderPor([[/Registro\.spObtenerEstudiantes/, [registro(82)]]]);
    const { codigo, cuerpo } = await invocar(handler, "GET", `/v1/procad/estudiantes/${CUENTA}`);
    assert.equal(codigo, 200);
    assert.equal(cuerpo.cumpleIndiceMinimo, true);
    assert.equal(cuerpo.indiceMinimo, 70);
    assert.equal(cuerpo.idPersona, null);
    assert.deepEqual(cuerpo.solicitudes, []);
    assert.equal(cuerpo.nombrePersona, "Ana");
  });

  test("sin indice del periodo no cumple", async () => {
    responderPor([[/Registro\.spObtenerEstudiantes/, [registro(null)]]]);
    const { cuerpo } = await invocar(handler, "GET", `/v1/procad/estudiantes/${CUENTA}`);
    assert.equal(cuerpo.cumpleIndiceMinimo, false);
  });
});

describe("POST /solicitudes", () => {
  test("sin aceptar el reglamento es 400 y no toca la base", async () => {
    const { codigo } = await invocar(handler, "POST", "/v1/procad/solicitudes", {
      ...FORMULARIO, aceptoReglamento: false, idGrupo: 13, idPeriodo: 6,
    });
    assert.equal(codigo, 400);
    assert.equal(llamadas.length, 0);
  });

  test("el indice lo calcula el servidor y la experiencia va como adjunto de texto", async () => {
    responderPor([
      [/Registro\.spObtenerEstudiantes/, [registro(65)]],
      [/EXEC Procad\.spCrearSolicitud/, [{ idSolicitud: 90 }]],
      FICHA,
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/solicitudes", {
      ...FORMULARIO, idGrupo: 13, idPeriodo: 6, cumpleIndiceMinimo: true, experiencia: "Tres anios en la liga",
      nivelExperiencia: "intermedio",
    });
    assert.equal(codigo, 201);
    assert.equal(cuerpo.idSolicitud, 90);
    const exec = llamadaCon(/EXEC Procad\.spCrearSolicitud/);
    // Lo que el navegador diga del indice no cuenta: 65 < 70.
    assert.equal(exec.parametros["cumple"], false);
    assert.equal(exec.parametros["nivel"], "Intermedio");
    assert.equal(llamadaCon(/INSERT INTO Procad\.tblAdjuntosSolicitudes/).parametros["texto"], "Tres anios en la liga");
  });

  test("el rechazo del procedimiento (otro campus, categoria...) llega con su motivo", async () => {
    const mensaje = "El estudiante debe solicitar un grupo de su propio campus.";
    responderPor([
      [/Registro\.spObtenerEstudiantes/, [registro(82)]],
      [/EXEC Procad\.spCrearSolicitud/, () => { throw errorDeTrigger(mensaje); }],
    ]);
    const { codigo, cuerpo } = await invocar(handler, "POST", "/v1/procad/solicitudes", { ...FORMULARIO, idGrupo: 13, idPeriodo: 6 });
    assert.equal(codigo, 409);
    assert.equal(cuerpo.error, mensaje);
    assert.equal(cuantasCon(/tblAdjuntosSolicitudes/), 0);
  });
});

describe("PUT /solicitudes/{id}/correccion", () => {
  test("solo se corrige una OBSERVADO", async () => {
    responderPor([
      [/Registro\.spObtenerEstudiantes/, [registro(82)]],
      [/WITH \(UPDLOCK\)/, [{ idEstado: 17, codigoEstado: "PENDIENTE", esCondicionado: false }]],
      [/de\.numeroCuenta = @cuenta/, [{ idPersona: 5 }]],
    ]);
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/solicitudes/90/correccion", FORMULARIO);
    assert.equal(codigo, 409);
    assert.equal(cuantasCon(/UPDATE Procad\.tblDetallesSolicitudes/), 0);
  });

  test("la de otra cuenta es 404", async () => {
    responderPor([
      [/Registro\.spObtenerEstudiantes/, [registro(82)]],
      [/WITH \(UPDLOCK\)/, [{ idEstado: 20, codigoEstado: "OBSERVADO", esCondicionado: false }]],
    ]);
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/solicitudes/90/correccion", FORMULARIO);
    assert.equal(codigo, 404);
  });

  test("vuelve a PENDIENTE, recalcula el indice y deja el cambio en el log", async () => {
    responderPor([
      [/Registro\.spObtenerEstudiantes/, [registro(82)]],
      [/WITH \(UPDLOCK\)/, [{ idEstado: 20, codigoEstado: "OBSERVADO", esCondicionado: false }]],
      [/de\.numeroCuenta = @cuenta/, [{ idPersona: 5 }]],
      FICHA,
    ]);
    const { codigo } = await invocar(handler, "PUT", "/v1/procad/solicitudes/90/correccion", { ...FORMULARIO, experiencia: "Corregida" });
    assert.equal(codigo, 200);
    const cambio = llamadaCon(/UPDATE Procad\.tblDetallesSolicitudes/);
    assert.equal(cambio.parametros["pendiente"], "PENDIENTE");
    assert.equal(cambio.parametros["cumple"], true);
    assert.equal(cambio.parametros["texto"], "Corregida");
    assert.equal(llamadaCon(/INSERT INTO Procad\.tblLogsEstadosSolicitudes/).parametros["idPersona"], 5);
  });
});
