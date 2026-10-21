/**
 * Recorrido de voae-voluntariado contra la base REAL, sin dejar rastro.
 *
 * Igual que el de PROCAD: llama al handler de verdad dentro de una
 * transaccion que se revierte al final (pruebas/dobles/db-transaccion.ts).
 * Por ahora cubre la creacion de un grupo: solicitud con junta, fundadores y
 * logo, aprobacion, y lo que el grupo aprobado hereda de la solicitud.
 *
 * Usa estudiantes que ya existen en la base (los de la semilla de
 * Voluntariado); no crea personas.
 */
import { handler } from "../../src/funciones/voluntariado/index";
import { conectar, consultar, consultarUna, desconectar, iniciarRonda, terminarRonda } from "../dobles/db-transaccion";
import { invocar } from "../evento";

const RAIZ = "/v1/voluntariado";
const NOMBRE = `Recorrido Voluntariado ${Date.now()}`;
const CARGO_MIEMBRO = 1;
const CARGO_COORDINADOR = 2;
const CARGO_PRESIDENTE = 3;

/* ------------------------------- Reporte -------------------------------- */

let fallas = 0;
let pasos = 0;

function ok(condicion: boolean, mensaje: string): void {
  pasos++;
  if (!condicion) fallas++;
  console.log(`  ${condicion ? "OK   " : "FALLA"} ${mensaje}`);
}

async function paso(descripcion: string, metodo: string, ruta: string, cuerpo: unknown, codigoEsperado: number): Promise<any> {
  const r = await invocar(handler, metodo, `${RAIZ}${ruta}`, cuerpo);
  const bien = r.codigo === codigoEsperado;
  const detalle = bien ? "" : ` — recibio ${r.codigo}: ${JSON.stringify(r.cuerpo)?.slice(0, 220)}`;
  ok(bien, `${metodo} ${ruta} → ${codigoEsperado}  ${descripcion}${detalle}`);
  return r.cuerpo;
}

/* ------------------------------ Recorrido ------------------------------- */

async function principal(): Promise<void> {
  await conectar();
  await iniciarRonda();
  try {
    // Tres estudiantes de la semilla: coordinador, presidente (y fundador) y un fundador sin cargo.
    const estudiantes = await consultar<{ idPersona: number; numeroCuenta: string }>(`
      SELECT TOP 3 de.idPersona, de.numeroCuenta
        FROM Catalogo.tblDetallesEstudiantes de
       WHERE de.numeroCuenta LIKE N'2099%'
       ORDER BY de.numeroCuenta`);
    if (estudiantes.length < 3) throw new Error("Se necesitan 3 estudiantes de la semilla (cuentas 2099...).");
    const [coordinador, presidente, fundador] = estudiantes as [typeof estudiantes[0], typeof estudiantes[0], typeof estudiantes[0]];

    const logo = await consultarUna<{ idRequisitoAdjunto: number }>(`
      SELECT idRequisitoAdjunto FROM Voluntariado.tblRequisitosAdjuntos
       WHERE procesoRequisito = N'SOLICITUD_GRUPO' AND tipoRequisito = N'LOGO'`);
    const red = await consultarUna<{ idRedTematica: number }>(`
      SELECT TOP 1 idRedTematica FROM Voluntariado.tblRedesTematicas ORDER BY idRedTematica`);

    console.log("\n== Creacion de un grupo");
    const solicitud = await paso("solicitud con junta y un fundador fuera de ella", "POST", "/solicitudes-grupos", {
      idPersonaSolicitante: coordinador.idPersona,
      idCampus: 1,
      nombreGrupo: NOMBRE,
      propositoGrupo: "Proposito del recorrido",
      misionGrupo: "Mision del recorrido",
      juntaDirectiva: [
        { numeroCuenta: coordinador.numeroCuenta, idCargo: CARGO_COORDINADOR },
        { numeroCuenta: presidente.numeroCuenta, idCargo: CARGO_PRESIDENTE },
      ],
      fundadores: [presidente.numeroCuenta, fundador.numeroCuenta],
      actividadesProyectadas: [],
    }, 201);
    const idSolicitud = solicitud.idSolicitudGrupoNuevo as number;

    const llaveLogo = `voluntariado/solicitudes-grupos/${idSolicitud}/recorrido-logo.png`;
    await paso("adjunta el logo", "POST", `/solicitudes-grupos/${idSolicitud}/adjuntos`,
      { idRequisitoAdjunto: logo!.idRequisitoAdjunto, archivoUrl: llaveLogo }, 201);

    const resolucion = await paso("aprueba la solicitud", "POST", `/solicitudes-grupos/${idSolicitud}/resolucion`,
      { estado: "APROBADA", redesTematicas: [red!.idRedTematica] }, 200);
    const idGrupo = resolucion.idGrupoCreado as number;
    ok(Number.isInteger(idGrupo), `se creo el grupo ${idGrupo}`);
    ok(Array.isArray(resolucion.cuentasSinPersona) && resolucion.cuentasSinPersona.length === 0,
      `ninguna cuenta quedo sin persona: ${JSON.stringify(resolucion.cuentasSinPersona)}`);

    const grupo = await consultarUna<{ logoUrl: string | null }>(
      `SELECT logoUrl FROM Voluntariado.tblGrupos WHERE idGrupo = ${idGrupo}`);
    ok(grupo?.logoUrl === llaveLogo, `el grupo hereda el logo de la solicitud (${grupo?.logoUrl})`);

    const miembros = await consultar<{ idPersona: number; idCargo: number; esFundador: boolean }>(`
      SELECT idPersona, idCargo, esFundador FROM Voluntariado.tblMiembrosGrupos
       WHERE idGrupo = ${idGrupo} ORDER BY idCargo DESC, idPersona`);
    const cargoDe = (idPersona: number) => miembros.find((m) => m.idPersona === idPersona)?.idCargo;
    ok(miembros.length === 3, `el grupo tiene 3 miembros (${miembros.length})`);
    ok(cargoDe(coordinador.idPersona) === CARGO_COORDINADOR, "el coordinador entra con su cargo");
    ok(cargoDe(presidente.idPersona) === CARGO_PRESIDENTE, "quien es fundador y presidente conserva el cargo, sin duplicarse");
    ok(cargoDe(fundador.idPersona) === CARGO_MIEMBRO, "el fundador sin cargo entra como miembro");
    ok(miembros.every((m) => m.esFundador), "los tres quedan marcados como fundadores");
  } finally {
    await terminarRonda();
  }

  // Nada debe haber quedado escrito.
  await iniciarRonda();
  const restos = await consultarUna<{ grupos: number; solicitudes: number }>(`
    SELECT (SELECT COUNT(*) FROM Voluntariado.tblGrupos WHERE nombreGrupo = N'${NOMBRE}') AS grupos,
           (SELECT COUNT(*) FROM Voluntariado.tblSolicitudesGruposNuevos WHERE nombreGrupo = N'${NOMBRE}') AS solicitudes`);
  await terminarRonda();
  console.log("\n== Despues del recorrido");
  ok(restos?.grupos === 0 && restos?.solicitudes === 0, `la base quedo como estaba: ${JSON.stringify(restos)}`);

  await desconectar();
  console.log(`\n${pasos - fallas} de ${pasos} pasos bien.${fallas === 0 ? " Todo bien." : ` ${fallas} falla(s).`}`);
  process.exitCode = fallas === 0 ? 0 : 1;
}

principal().catch((error) => {
  console.error("El recorrido no pudo correr:", error);
  process.exitCode = 1;
});
