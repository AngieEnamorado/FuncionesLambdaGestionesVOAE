/**
 * Recorrido de voae-procad contra la base REAL, sin dejar rastro.
 *
 * Llama al handler de verdad (router, validaciones, SQL, triggers, SPs y
 * vistas de Azure) siguiendo el ciclo de PROCAD, con datos inventados que se
 * crean dentro de una transaccion y se revierten al final de cada ronda (ver
 * pruebas/dobles/db-transaccion.ts). Al terminar comprueba que la base quedo
 * como estaba.
 *
 * La ronda principal recorre el camino feliz. Cada rechazo de trigger va en
 * su propia ronda, porque un trigger que rechaza revierte toda la transaccion.
 *
 * RECORRIDO_MIGRACIONES: archivos .sql (separados por ";") que se aplican
 * dentro de cada ronda antes de probar, p. ej. una migracion aun no aplicada.
 */
import { readFileSync } from "node:fs";
import { handler } from "../../src/funciones/procad/index";
import {
  conectar,
  consultar,
  consultarUna,
  desconectar,
  ejecutarScript,
  iniciarRonda,
  sql,
  terminarRonda,
} from "../dobles/db-transaccion";
import { invocar } from "../evento";

const MARCA = "recorrido-procad";
const RAIZ = "/v1/procad";
const migraciones = (process.env["RECORRIDO_MIGRACIONES"] ?? "").split(";").filter(Boolean);

/* ------------------------------- Reporte -------------------------------- */

let fallas = 0;
let pasos = 0;

function ok(condicion: boolean, mensaje: string): void {
  pasos++;
  if (!condicion) fallas++;
  console.log(`  ${condicion ? "OK   " : "FALLA"} ${mensaje}`);
}

/** Llama al handler y registra el paso: codigo esperado y, si se da, una comprobacion del cuerpo. */
async function paso(
  descripcion: string,
  metodo: string,
  ruta: string,
  cuerpo: unknown,
  codigoEsperado: number,
  comprobar?: (c: any) => boolean | string,
): Promise<any> {
  const r = await invocar(handler, metodo, `${RAIZ}${ruta}`, cuerpo);
  let detalle = "";
  let bien = r.codigo === codigoEsperado;
  if (bien && comprobar) {
    const resultado = comprobar(r.cuerpo);
    bien = resultado !== false;
    if (typeof resultado === "string") detalle = ` — ${resultado}`;
  }
  if (!bien) detalle = ` — recibio ${r.codigo}: ${JSON.stringify(r.cuerpo)?.slice(0, 220)}`;
  else if (r.codigo >= 400) detalle = ` — "${r.cuerpo?.error}"`;
  ok(bien, `${metodo} ${ruta} → ${codigoEsperado}  ${descripcion}${detalle}`);
  return r.cuerpo;
}

/* ------------------------------- Siembra -------------------------------- */

interface Base {
  p1: number;
  p2: number;
  juan: number;
  maria: number;
  carla: number;
  pedro: number;
  sofia: number;
  tomas: number;
  dir: number;
  adm: number;
  tiposActividad: number[];
  lugar: number;
}

/**
 * Personas, perfiles y periodos que la Lambda no crea (son de Catalogo o del
 * portal del estudiante). Todo con correo @ejemplo.invalid y anio 2090, para
 * que sea inconfundible y se pueda comprobar que no quedo nada.
 */
async function sembrarBase(): Promise<Base> {
  const u = `N'${MARCA}'`;
  const fila = await consultarUna<Base & { tiposActividad: string }>(`
    INSERT Catalogo.tblPeriodos (anioPeriodo, numeroPac, fechaInicioPeriodo, fechaFinPeriodo, estadoPeriodo, usuarioRegistro)
    VALUES (2090, 1, '2090-01-10', '2090-04-30', 1, ${u}), (2090, 2, '2090-05-10', '2090-08-30', 1, ${u});

    INSERT Catalogo.tblPersonas (nombrePersona, apellidosPersona, correoPersona, sexoPersona, idCampus, usuarioRegistro) VALUES
     (N'Juan',  N'Recorrido', N'juan.recorrido@ejemplo.invalid',  N'M', 1, ${u}),
     (N'Maria', N'Recorrido', N'maria.recorrido@ejemplo.invalid', N'F', 1, ${u}),
     (N'Carla', N'Recorrido', N'carla.recorrido@ejemplo.invalid', N'F', 1, ${u}),
     (N'Pedro', N'Recorrido', N'pedro.recorrido@ejemplo.invalid', N'M', 1, ${u}),
     (N'Sofia', N'Recorrido', N'sofia.recorrido@ejemplo.invalid', N'F', 1, ${u}),
     (N'Tomas', N'Recorrido', N'tomas.recorrido@ejemplo.invalid', N'M', 1, ${u}),
     (N'Diego', N'Director',  N'diego.recorrido@ejemplo.invalid', N'M', 1, ${u}),
     (N'Ana',   N'Admin',     N'ana.recorrido@ejemplo.invalid',   N'F', 1, ${u});

    DECLARE @p TABLE (clave NVARCHAR(10), idPersona INT);
    INSERT @p SELECT LEFT(correoPersona, CHARINDEX(N'.', correoPersona) - 1), idPersona
      FROM Catalogo.tblPersonas WHERE correoPersona LIKE N'%.recorrido@ejemplo.invalid';

    -- Tomas no tiene la matricula verificada.
    INSERT Catalogo.tblDetallesEstudiantes (idPersona, numeroCuenta, matriculaVerificada, usuarioRegistro)
    SELECT idPersona, CONCAT(N'2090', RIGHT(CONCAT(N'0000000', idPersona), 7)),
           CASE WHEN clave = N'tomas' THEN 0 ELSE 1 END, ${u}
      FROM @p WHERE clave NOT IN (N'diego', N'ana');

    -- Estudiantes: perfil pregrado + rol ESTUDIANTE. Diego: docente, DIRECTOR. Ana: docente, ADMINISTRADOR_PROCAD.
    DECLARE @pregrado TINYINT = (SELECT idPerfil FROM Catalogo.tblPerfiles WHERE nombre = N'Estudiante de pregrado');
    DECLARE @docente  TINYINT = (SELECT idPerfil FROM Catalogo.tblPerfiles WHERE nombre = N'Docente');
    DECLARE @rEstudiante TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'GLOBAL' AND nombreRol = N'ESTUDIANTE');
    DECLARE @rEmpleado   TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'GLOBAL' AND nombreRol = N'EMPLEADO');
    DECLARE @rDirector   TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'PROCAD' AND nombreRol = N'DIRECTOR');
    DECLARE @rAdmin      TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'PROCAD' AND nombreRol = N'ADMINISTRADOR_PROCAD');
    INSERT Catalogo.tblPersonaPerfilRol (idPersona, idPerfil, idRol, usuarioRegistro)
    SELECT idPersona, @pregrado, @rEstudiante, ${u} FROM @p WHERE clave NOT IN (N'diego', N'ana')
    UNION ALL SELECT idPersona, @docente, @rEmpleado, ${u} FROM @p WHERE clave IN (N'diego', N'ana');
    INSERT Catalogo.tblPersonaPerfilRol (idPersona, idPerfil, idRol, usuarioRegistro)
    SELECT idPersona, @docente, CASE clave WHEN N'diego' THEN @rDirector ELSE @rAdmin END, ${u}
      FROM @p WHERE clave IN (N'diego', N'ana');

    SELECT
      (SELECT idPeriodo FROM Catalogo.tblPeriodos WHERE anioPeriodo = 2090 AND numeroPac = 1) AS p1,
      (SELECT idPeriodo FROM Catalogo.tblPeriodos WHERE anioPeriodo = 2090 AND numeroPac = 2) AS p2,
      (SELECT idPersona FROM @p WHERE clave = N'juan')  AS juan,
      (SELECT idPersona FROM @p WHERE clave = N'maria') AS maria,
      (SELECT idPersona FROM @p WHERE clave = N'carla') AS carla,
      (SELECT idPersona FROM @p WHERE clave = N'pedro') AS pedro,
      (SELECT idPersona FROM @p WHERE clave = N'sofia') AS sofia,
      (SELECT idPersona FROM @p WHERE clave = N'tomas') AS tomas,
      (SELECT idPersona FROM @p WHERE clave = N'diego') AS dir,
      (SELECT idPersona FROM @p WHERE clave = N'ana')   AS adm,
      (SELECT TOP 2 ta.idTipoActividad AS id
         FROM Procad.tblTiposActividades ta
        INNER JOIN Procad.tblTiposGrupo tg ON tg.idTipoGrupo = ta.idTipoGrupo
        WHERE tg.nombreTipoGrupo = N'artistico' AND ta.estadoTipoActividad = 1
        ORDER BY ta.idTipoActividad FOR JSON PATH) AS tiposActividad,
      (SELECT TOP 1 idLugarVisoria FROM Procad.tblLugaresVisoria WHERE idCampus = 1 AND estadoLugar = 1 ORDER BY idLugarVisoria) AS lugar;
  `);
  const tipos = JSON.parse(fila!.tiposActividad) as { id: number }[];
  return { ...fila!, tiposActividad: tipos.map((t) => t.id) };
}

/** Grupo artistico creado directo en SQL, para las rondas cortas. */
async function crearGrupoSql(b: Base): Promise<number> {
  const fila = await consultarUna<{ id: number }>(`
    INSERT Procad.tblGrupos (nombreGrupo, idTipoGrupo, idCampus, usuarioRegistro)
    VALUES (N'Coro Recorrido', (SELECT idTipoGrupo FROM Procad.tblTiposGrupo WHERE nombreTipoGrupo = N'artistico'), 1, N'${MARCA}');
    DECLARE @id INT = CAST(SCOPE_IDENTITY() AS INT);
    INSERT Procad.tblGruposTiposActividades (idGrupo, idTipoActividad, usuarioRegistro)
    VALUES (@id, @tipo, N'${MARCA}');
    SELECT @id AS id;
  `, { tipo: [sql.Int, b.tiposActividad[0]] });
  return fila!.id;
}

/**
 * Lo que la Lambda de PROCAD tampoco crea: el acceso del director al grupo
 * (se da desde administracion) y las solicitudes (las envia el estudiante
 * desde el portal). Todas nacen PENDIENTE; Carla no cumple el indice.
 */
async function sembrarGrupo(b: Base, idGrupo: number): Promise<Record<string, number>> {
  const filas = await consultar<{ idPersona: number; idSolicitud: number }>(`
    INSERT Procad.tblAccesos (idPersona, idGrupo, idCampus, usuarioRegistro) VALUES (@dir, @grupo, 1, N'${MARCA}');

    DECLARE @pend INT = (SELECT idEstado FROM Catalogo.tblEstados
                          WHERE contextoEstado = N'PROCAD_SOLICITUD' AND codigoEstado = N'PENDIENTE');
    INSERT Procad.tblSolicitudes (idPersona, idGrupo, idPeriodo, idEstado, cumpleIndiceMinimo, usuarioRegistro)
    SELECT v.idPersona, @grupo, @p1, @pend, v.cumple, N'${MARCA}'
      FROM (VALUES (@juan, 1), (@maria, 1), (@carla, 0), (@pedro, 1), (@sofia, 1), (@tomas, 1)) v(idPersona, cumple);

    SELECT idPersona, idSolicitud FROM Procad.tblSolicitudes WHERE idGrupo = @grupo;
  `, {
    grupo: [sql.Int, idGrupo], p1: [sql.Int, b.p1], dir: [sql.Int, b.dir],
    juan: [sql.Int, b.juan], maria: [sql.Int, b.maria], carla: [sql.Int, b.carla],
    pedro: [sql.Int, b.pedro], sofia: [sql.Int, b.sofia], tomas: [sql.Int, b.tomas],
  });
  const porPersona = new Map(filas.map((f) => [f.idPersona, f.idSolicitud]));
  const nombres = ["juan", "maria", "carla", "pedro", "sofia", "tomas"] as const;
  return Object.fromEntries(nombres.map((n) => [n, porPersona.get(b[n])!]));
}

async function ronda(titulo: string, cuerpo: (b: Base) => Promise<void>): Promise<void> {
  console.log(`\n== ${titulo}`);
  await iniciarRonda();
  try {
    for (const archivo of migraciones) await ejecutarScript(readFileSync(archivo, "utf8"));
    await cuerpo(await sembrarBase());
  } catch (error) {
    ok(false, `la ronda se interrumpio: ${(error as Error).message}`);
  } finally {
    await terminarRonda();
  }
}

/** Cuantas fechas del rango caen en los dias ISO pedidos (1 = lunes ... 7 = domingo). */
function fechasDeSerie(inicio: string, fin: string, dias: number[]): number {
  let total = 0;
  for (let t = Date.parse(inicio); t <= Date.parse(fin); t += 86_400_000) {
    const iso = ((new Date(t).getUTCDay() + 6) % 7) + 1;
    if (dias.includes(iso)) total++;
  }
  return total;
}

/* -------------------------------- Rondas -------------------------------- */

async function rondaPrincipal(b: Base): Promise<void> {
  await paso("catalogos reales", "GET", "/catalogos", undefined, 200, (c) => c.deportes.length > 0);

  const grupo = await paso("crea el grupo artistico con 2 disciplinas y 2 tipos de actividad", "POST", "/grupos", {
    nombreGrupo: "Coro Recorrido", idTipoGrupo: 1, idCampus: 1, categoriaSexo: "mixto",
    disciplinas: [1, 2], tiposActividad: b.tiposActividad,
  }, 201, (c) => c.disciplinas.length === 2 && c.tiposActividad.length === 2);
  const g = grupo.idGrupo as number;

  await paso("edita solo el nombre", "PUT", `/grupos/${g}`, { nombreGrupo: "Coro Recorrido UNAH" }, 200,
    (c) => c.nombreGrupo === "Coro Recorrido UNAH" && c.disciplinas.length === 2);

  const s = await sembrarGrupo(b, g);
  console.log("  ·     (sembrado: acceso del director y 6 solicitudes PENDIENTE, como las enviaria el portal)");

  await paso("lista las 6 pendientes del grupo", "GET", `/solicitudes?grupo=${g}&estado=PENDIENTE`, undefined, 200,
    (c) => c.length === 6 || `${c.length} filas`);
  await paso("busca por nombre", "GET", `/solicitudes?grupo=${g}&q=sofia`, undefined, 200, (c) => c.length === 1);
  await paso("el listado trae el periodo y la ficha", "GET", `/solicitudes?grupo=${g}`, undefined, 200,
    (c) => c[0].anioPeriodo === 2090 && Array.isArray(c[0].adjuntos));

  // Resoluciones.
  await paso("aprueba a Juan", "POST", `/solicitudes/${s.juan}/resolucion`, { decision: "APROBADO", idPersona: b.dir }, 200,
    (c) => c.codigoEstado === "APROBADO" && c.historial.length === 1);
  await paso("observa a Sofia", "POST", `/solicitudes/${s.sofia}/resolucion`,
    { decision: "OBSERVADO", idPersona: b.dir, observacion: "Falta la constancia de experiencia" }, 200,
    (c) => c.codigoEstado === "OBSERVADO");
  await paso("Pedro no cumple", "POST", `/solicitudes/${s.pedro}/resolucion`,
    { decision: "NO_CUMPLE_REQUISITO", idPersona: b.dir }, 200, (c) => c.codigoEstado === "NO_CUMPLE_REQUISITO");
  await paso("resolver dos veces a Juan se rechaza", "POST", `/solicitudes/${s.juan}/resolucion`,
    { decision: "NO_CUMPLE_REQUISITO", idPersona: b.dir }, 409);
  await paso("aprueba a Maria", "POST", `/solicitudes/${s.maria}/resolucion`, { decision: "APROBADO", idPersona: b.dir }, 200,
    (c) => c.codigoEstado === "APROBADO");

  // Condicionado con doble firma.
  await paso("el director propone a Carla como condicionada", "POST", "/condicionados",
    { idSolicitud: s.carla, idPersonaPropone: b.dir }, 201, (c) => c.idPersonaProponeCondicionado === b.dir);
  await paso("aparece como PROPUESTO", "GET", `/condicionados?estado=PROPUESTO&grupo=${g}`, undefined, 200, (c) => c.length === 1);
  await paso("la admin la autoriza", "POST", `/condicionados/${s.carla}/autorizacion`, { idPersonaAutoriza: b.adm }, 200,
    (c) => c.esCondicionado === true);
  await paso("con las dos firmas, Carla se aprueba", "POST", `/solicitudes/${s.carla}/resolucion`,
    { decision: "APROBADO", idPersona: b.dir }, 200, (c) => c.codigoEstado === "APROBADO");

  await paso("el director propone a Sofia", "POST", "/condicionados", { idSolicitud: s.sofia, idPersonaPropone: b.dir }, 201);
  await paso("la admin rechaza la propuesta de Sofia, con motivo", "POST", `/condicionados/${s.sofia}/rechazo`,
    { idPersona: b.adm, motivo: "Sin evidencia de trayectoria" }, 200,
    (c) => c.idPersonaProponeCondicionado === null && c.historial.some((h: any) => /rechazada/.test(h.observacionCambio)));

  await paso("Juan pasa al equipo", "PUT", `/solicitudes/${s.juan}/equipo`, { esEquipo: true }, 200, (c) => c.esEquipo === true);
  await paso("Sofia (OBSERVADO) no puede ser del equipo", "PUT", `/solicitudes/${s.sofia}/equipo`, { esEquipo: true }, 409);
  await paso("integrantes: Juan, Maria y Carla", "GET", `/grupos/${g}/integrantes?periodo=${b.p1}`, undefined, 200,
    (c) => c.integrantes.length === 3 || `${c.integrantes.length} integrantes`);

  await paso("configura el minimo de actividades", "PUT", "/periodos/configuracion",
    { idGrupo: g, idPeriodo: b.p1, minimoActividades: 1 }, 200, (c) => c.minimoActividades === 1);

  // Actividad puntual, validacion y pase de lista.
  const act = await paso("el encargado reporta una actividad", "POST", "/actividades",
    { idGrupo: g, idPeriodo: b.p1, fechaActividad: "2090-02-02", idTipoActividad: b.tiposActividad[0], descripcionActividad: "Ensayo general" },
    201, (c) => c.codigoEstado === "PENDIENTE_VALIDACION");
  await paso("la admin la valida", "POST", `/actividades/${act.idActividad}/validacion`,
    { decision: "VALIDADA", idPersonaValidadora: b.adm }, 200, (c) => c.codigoEstado === "VALIDADA");
  await paso("pase de lista: Juan presente, Maria excusada", "POST", `/actividades/${act.idActividad}/asistencia`, {
    asistencias: [
      { idSolicitud: s.juan, asistio: true },
      { idSolicitud: s.maria, asistio: false, esExcusado: true, justificacionExcusa: "Cita medica", idPersonaValidaExcusa: b.dir },
    ],
  }, 200, (c) => c.asistencias.length === 2 && c.actividad.presentes === 1);

  // Serie recurrente (spGenerarActividadesSerie).
  const dias = [2, 4];
  const esperadas = fechasDeSerie("2090-02-06", "2090-02-19", dias);
  await paso(`serie martes y jueves por dos semanas genera ${esperadas} actividades`, "POST", "/series", {
    idGrupo: g, idPeriodo: b.p1, idTipoActividad: b.tiposActividad[0],
    fechaInicioSerie: "2090-02-06", fechaFinSerie: "2090-02-19", horaSerie: "17:00", diasSemana: dias,
  }, 201, (c) => c.actividadesGeneradas === esperadas || `genero ${c.actividadesGeneradas}`);

  // Visoria.
  const vis = await paso("crea una visoria", "POST", "/visorias",
    { idPeriodo: b.p1, idCampus: 1, fechaVisoria: "2090-01-20", horaVisoria: "08:00", idLugarVisoria: b.lugar }, 201);
  await paso("cita a Sofia", "POST", `/visorias/${vis.idVisoria}/citados`, { solicitudes: [s.sofia] }, 200,
    (c) => c.estudiantes.length === 1);

  await paso("matricula excepcional para Pedro, por numero de cuenta", "POST", "/matriculas-excepcionales",
    { numeroCuenta: `2090${String(b.pedro).padStart(7, "0")}`, idPeriodo: b.p1, motivoExcepcion: "Apoyo en la organizacion del festival VOAE", idPersonaAutoriza: b.adm }, 201);

  // Expulsion con motivo Otro.
  const exp = await paso("el director pide expulsar a Maria (motivo Otro, con detalle)", "POST", "/expulsiones",
    { idSolicitud: s.maria, idPersonaSolicita: b.dir, idMotivoExpulsion: 5, detalleMotivo: "Abandono la gira sin avisar" },
    201, (c) => c.codigoEstado === "PENDIENTE");
  await paso("la admin la aprueba", "POST", `/expulsiones/${exp.idSolicitudExpulsion}/resolucion`,
    { decision: "APROBADA", idPersonaResuelve: b.adm }, 200, (c) => c.codigoEstado === "APROBADA");
  await paso("Maria queda EXPULSADO, con el cambio en su historial", "GET", `/solicitudes/${s.maria}`, undefined, 200,
    (c) => (c.codigoEstado === "EXPULSADO" && c.historial.some((h: any) => h.estadoNuevo === "EXPULSADO")) || c.codigoEstado);

  // Lista preferencial desde vwElegibilidad: Juan asistio a 1 validada (minimo 1).
  const lista = await paso("genera la lista preferencial: solo Juan es elegible", "POST", "/listas-preferenciales",
    { idGrupo: g, idPeriodoEvaluado: b.p1, idPeriodoAplicacion: b.p2 }, 201,
    (c) => (c.cantidadElegibles === 1 && c.detalles[0]?.idPersona === b.juan) || `${c.cantidadElegibles} elegibles`);
  await paso("la envia a Registro", "POST", `/listas-preferenciales/${lista.idLista}/envio`, undefined, 200,
    (c) => c.codigoEstado === "ENVIADA");
  await paso("enviarla otra vez se rechaza", "POST", `/listas-preferenciales/${lista.idLista}/envio`, undefined, 409);

  // Activacion de periodo.
  if (migraciones.some((m) => /activar_nuevo_periodo/.test(m))) {
    await paso("activa el periodo 2: Juan pasa y Carla queda por reconfirmar", "POST", "/periodos/activar",
      { idPeriodoAnterior: b.p1, idPeriodoNuevo: b.p2 }, 200,
      (c) => (c.integrantesCopiados === 1 && c.condicionadosPorReconfirmar === 1)
        || `${c.integrantesCopiados} copiados, ${c.condicionadosPorReconfirmar} condicionados`);
    await paso("Carla aparece POR_RECONFIRMAR en el periodo 2", "GET", `/condicionados?estado=POR_RECONFIRMAR&periodo=${b.p2}`,
      undefined, 200, (c) => (c.length === 1 && c[0].idPersonaAutorizaAnterior === b.adm) || `${c.length} filas`);
  } else {
    console.log("  ·     (activar periodo se prueba en su ronda: el SP de Azure es el anterior)");
  }

  await paso("accesos del grupo", "GET", `/accesos?grupo=${g}`, undefined, 200, (c) => c.length === 1);
  await paso("revoca el acceso del director", "PUT", `/accesos/personas/${b.dir}`, { activo: false }, 200,
    (c) => c.every((x: any) => x.activo === false));
  await paso("se lo vuelve a otorgar", "PUT", `/accesos/personas/${b.dir}`, { activo: true }, 200,
    (c) => c.every((x: any) => x.activo === true));
  await paso("PROSENE responde", "GET", "/prosene", undefined, 200);
}

/* ------------------------------ Principal ------------------------------- */

async function principal(): Promise<void> {
  console.log("Recorrido de voae-procad contra Azure. Todo corre en transacciones que se revierten.");
  if (migraciones.length > 0) console.log(`Migraciones aplicadas dentro de cada ronda: ${migraciones.join(", ")}`);
  await conectar();

  await ronda("Ronda principal: el ciclo completo de PROCAD", rondaPrincipal);

  if (!migraciones.some((m) => /activar_nuevo_periodo/.test(m))) {
    await ronda("Activar periodo con el SP que hoy esta en Azure", async (b) => {
      const g = await crearGrupoSql(b);
      const s = await sembrarGrupo(b, g);
      await paso("aprueba a Juan", "POST", `/solicitudes/${s.juan}/resolucion`, { decision: "APROBADO", idPersona: b.dir }, 200);
      await paso("activa el periodo 2", "POST", "/periodos/activar", { idPeriodoAnterior: b.p1, idPeriodoNuevo: b.p2 }, 200,
        (c) => (c.integrantesEnPeriodoNuevo ?? c.integrantesCopiados) === 1);
    });
  }

  // Cada rechazo de un trigger revierte la transaccion entera: una ronda por caso.
  await ronda("Rechazo: aprobar sin matricula verificada", async (b) => {
    const s = await sembrarGrupo(b, await crearGrupoSql(b));
    await paso("Tomas no tiene la matricula verificada", "POST", `/solicitudes/${s.tomas}/resolucion`,
      { decision: "APROBADO", idPersona: b.dir }, 409);
  });

  await ronda("Rechazo: aprobar a quien no cumple el indice sin doble firma", async (b) => {
    const s = await sembrarGrupo(b, await crearGrupoSql(b));
    await paso("Carla sin firmas", "POST", `/solicitudes/${s.carla}/resolucion`, { decision: "APROBADO", idPersona: b.dir }, 409);
  });

  await ronda("Rechazo: expulsion con motivo Otro sin detalle", async (b) => {
    const s = await sembrarGrupo(b, await crearGrupoSql(b));
    await paso("aprueba a Juan", "POST", `/solicitudes/${s.juan}/resolucion`, { decision: "APROBADO", idPersona: b.dir }, 200);
    await paso("Otro sin detalle", "POST", "/expulsiones",
      { idSolicitud: s.juan, idPersonaSolicita: b.dir, idMotivoExpulsion: 5 }, 409);
  });

  await ronda("Rechazo: pasar lista en una actividad sin validar", async (b) => {
    const g = await crearGrupoSql(b);
    const s = await sembrarGrupo(b, g);
    await paso("aprueba a Juan", "POST", `/solicitudes/${s.juan}/resolucion`, { decision: "APROBADO", idPersona: b.dir }, 200);
    const act = await paso("reporta una actividad", "POST", "/actividades",
      { idGrupo: g, idPeriodo: b.p1, fechaActividad: "2090-02-02", idTipoActividad: b.tiposActividad[0] }, 201);
    await paso("pase de lista sobre la actividad pendiente", "POST", `/actividades/${act.idActividad}/asistencia`,
      { asistencias: [{ idSolicitud: s.juan, asistio: true }] }, 409);
  });

  await ronda("Rechazo: dos visorias en el mismo lugar, fecha y hora", async (b) => {
    const visoria = { idPeriodo: b.p1, idCampus: 1, fechaVisoria: "2090-01-20", horaVisoria: "08:00", idLugarVisoria: b.lugar };
    await paso("primera visoria", "POST", "/visorias", visoria, 201);
    await paso("segunda en el mismo lugar y hora", "POST", "/visorias", visoria, 409);
  });

  // Nada debe haber quedado escrito.
  await iniciarRonda();
  const restos = await consultarUna<Record<string, number>>(`
    SELECT (SELECT COUNT(*) FROM Catalogo.tblPersonas WHERE correoPersona LIKE N'%.recorrido@ejemplo.invalid') AS personas,
           (SELECT COUNT(*) FROM Catalogo.tblPeriodos WHERE anioPeriodo = 2090) AS periodos,
           (SELECT COUNT(*) FROM Procad.tblGrupos WHERE nombreGrupo LIKE N'Coro Recorrido%') AS grupos,
           (SELECT COUNT(*) FROM Procad.tblSolicitudes WHERE usuarioRegistro = N'${MARCA}') AS solicitudes`);
  await terminarRonda();
  console.log("\n== Despues del recorrido");
  ok(Object.values(restos ?? {}).every((n) => n === 0), `la base quedo como estaba: ${JSON.stringify(restos)}`);

  await desconectar();
  console.log(`\n${pasos - fallas} de ${pasos} pasos bien.${fallas === 0 ? " Todo bien." : ` ${fallas} falla(s).`}`);
  process.exitCode = fallas === 0 ? 0 : 1;
}

principal().catch((error) => {
  console.error("El recorrido no pudo correr:", error);
  process.exitCode = 1;
});
