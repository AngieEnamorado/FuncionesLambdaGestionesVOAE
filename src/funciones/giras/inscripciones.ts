/**
 * Inscripciones a giras: lectura, alta, edicion, envio, dictamen y baja.
 *
 * Una inscripcion es la cabecera (Giras.tblInscripciones) mas, opcionalmente,
 * un acompanante externo (tblViajerosExternos), hasta dos fichas de salud
 * (tblFichasSalud: la del viajero y la del acompanante, distinguidas por
 * esViajeroExterno) y sus documentos.
 *
 * Lo que los triggers ya hacen y aqui NO se repite:
 *  - tgrInscripcionesExcepcionValidar exige idInscribidorExcepcional y
 *    motivoExcepcion cuando el tipo de inscripcion tiene requiereMotivo.
 *  - tgrGirasCancelacionValidar arrastra las inscripciones vivas a "Cancelada
 *    por gira" cuando se cancela la gira.
 *  - tgrInscripcionesLlenarLog llena la bitacora.
 * Lo que no hace ninguno y vive aqui: un dictamen no mueve el estado de la
 * inscripcion, asi que dictaminarInscripcion lo hace en su transaccion.
 */
import { consultar, consultarUna, enTransaccion, sql, type Parametro } from "../../compartido/db";
import { conflicto, noEncontrado, solicitudInvalida } from "../../compartido/errores";
import {
  enteroOpcional,
  textoOpcional,
  textoRequerido,
} from "../../compartido/validacion";
import {
  fechaIso,
  CONTEXTO,
  idEstado,
  nombreDeUsuario,
  paramFecha,
  periodoDe,
} from "./consultas";
import {
  fechaRequerida,
  leerDocumento,
  listaDeObjetos,
  type DocumentoEntrada,
  type Ejecutor,
} from "./entrada";

const ESTADOS_EDITABLES = ["Borrador", "Correccion"];
/** Una gira en estos estados ya no recibe inscripciones. */
const ESTADOS_GIRA_CERRADOS = ["Cancelada", "Finalizada"];

/* ---------------------------- Lectura de entrada ------------------------- */

export interface AcompananteEntrada {
  nombre: string;
  fechaNacimiento: string;
  correoViajero: string;
  telefonoViajeroExterno: string | null;
}

const CAMPOS_FICHA = [
  { nombre: "alergias", largo: 500 },
  { nombre: "discapacidad", largo: 500 },
  { nombre: "condicionesMedicas", largo: 500 },
  { nombre: "medicamentos", largo: 300 },
  { nombre: "contactoEmergenciaNombre", largo: 120 },
  { nombre: "contactoEmergenciaParentesco", largo: 50 },
  { nombre: "contactoEmergenciaTelefono", largo: 30 },
] as const;

export interface FichaEntrada {
  idTipoSangre: number | null;
  textos: Record<string, string | null>;
}

export interface CambiosInscripcion {
  cabecera: Record<string, Parametro>;
  /** undefined = no tocar; null = quitar el acompanante (y su ficha); objeto = crear o reemplazar. */
  acompanante?: AcompananteEntrada | null;
  fichaSaludEstudiante?: FichaEntrada | null;
  fichaSaludAcompanante?: FichaEntrada | null;
  documentos?: DocumentoEntrada[];
}

function leerAcompanante(valor: unknown): AcompananteEntrada | null {
  if (valor === null) return null;
  if (typeof valor !== "object" || Array.isArray(valor)) {
    throw solicitudInvalida("acompanante debe ser un objeto o null.");
  }
  const fila = valor as Record<string, unknown>;
  return {
    nombre: textoRequerido(fila["nombre"], "acompanante.nombre", 120),
    fechaNacimiento: fechaRequerida(fila["fechaNacimiento"], "acompanante.fechaNacimiento"),
    correoViajero: textoRequerido(fila["correoViajero"], "acompanante.correoViajero", 120),
    telefonoViajeroExterno: textoOpcional(fila["telefonoViajeroExterno"], "acompanante.telefonoViajeroExterno", 30),
  };
}

function leerFicha(valor: unknown, etiqueta: string): FichaEntrada | null {
  if (valor === null) return null;
  if (typeof valor !== "object" || Array.isArray(valor)) {
    throw solicitudInvalida(`${etiqueta} debe ser un objeto o null.`);
  }
  const fila = valor as Record<string, unknown>;
  const idTipoSangre = enteroOpcional(fila["idTipoSangre"], `${etiqueta}.idTipoSangre`);
  if (idTipoSangre !== null && idTipoSangre > 255) {
    throw solicitudInvalida(`${etiqueta}.idTipoSangre esta fuera de rango.`);
  }
  const textos: Record<string, string | null> = {};
  for (const campo of CAMPOS_FICHA) {
    textos[campo.nombre] = textoOpcional(fila[campo.nombre], `${etiqueta}.${campo.nombre}`, campo.largo);
  }
  return { idTipoSangre, textos };
}

/**
 * idGira e idViajero se leen aparte (no cambian despues del alta). Aqui va lo
 * editable. Nombres de la base: idTipoInscripcion, idInscribidorExcepcional,
 * motivoExcepcion, observaciones.
 */
export function leerCuerpoInscripcion(cuerpo: Record<string, unknown>): CambiosInscripcion {
  const cambios: CambiosInscripcion = { cabecera: {} };

  if ("idTipoInscripcion" in cuerpo) {
    const id = enteroOpcional(cuerpo["idTipoInscripcion"], "idTipoInscripcion");
    if (id === null || id > 255) throw solicitudInvalida("idTipoInscripcion debe ser un id valido.");
    cambios.cabecera["idTipoInscripcion"] = [sql.TinyInt, id];
  }
  if ("idInscribidorExcepcional" in cuerpo) {
    cambios.cabecera["idInscribidorExcepcional"] = [
      sql.Int,
      enteroOpcional(cuerpo["idInscribidorExcepcional"], "idInscribidorExcepcional"),
    ];
  }
  if ("motivoExcepcion" in cuerpo) {
    cambios.cabecera["motivoExcepcion"] = [
      sql.NVarChar(500),
      textoOpcional(cuerpo["motivoExcepcion"], "motivoExcepcion", 500),
    ];
  }
  if ("observaciones" in cuerpo) {
    cambios.cabecera["observaciones"] = [
      sql.NVarChar(1000),
      textoOpcional(cuerpo["observaciones"], "observaciones", 1000),
    ];
  }

  if ("acompanante" in cuerpo) cambios.acompanante = leerAcompanante(cuerpo["acompanante"]);
  if ("fichaSaludEstudiante" in cuerpo) {
    cambios.fichaSaludEstudiante = leerFicha(cuerpo["fichaSaludEstudiante"], "fichaSaludEstudiante");
  }
  if ("fichaSaludAcompanante" in cuerpo) {
    cambios.fichaSaludAcompanante = leerFicha(cuerpo["fichaSaludAcompanante"], "fichaSaludAcompanante");
  }
  if ("documentos" in cuerpo) {
    cambios.documentos = listaDeObjetos(cuerpo["documentos"], "documentos", leerDocumento);
  }
  return cambios;
}

const hayCambios = (c: CambiosInscripcion): boolean =>
  Object.keys(c.cabecera).length > 0 ||
  [c.acompanante, c.fichaSaludEstudiante, c.fichaSaludAcompanante, c.documentos].some((x) => x !== undefined);

/* -------------------------------- Lectura -------------------------------- */

const INSCRIPCIONES_FROM = `
  FROM Giras.tblInscripciones i
 INNER JOIN Giras.tblGiras g ON g.idGira = i.idGira
 INNER JOIN Giras.tblSolicitudes s ON s.idSolicitud = g.idSolicitud
 INNER JOIN Catalogo.tblEstados e ON e.idEstado = i.idEstado
 INNER JOIN Giras.tblTiposInscripcion ti ON ti.idTipoInscripcion = i.idTipoInscripcion
 INNER JOIN Giras.tblUsuarioUnidad uv ON uv.idUsuarioUnidad = i.idViajero
 INNER JOIN Catalogo.tblPersonaPerfilRol pv ON pv.idPersonaPerfilRol = uv.idPersonaPerfilRol
 INNER JOIN Catalogo.tblPersonas p ON p.idPersona = pv.idPersona
  LEFT JOIN Catalogo.tblDetallesEstudiantes de ON de.idPersona = p.idPersona
  ${periodoDe("g.fechaSalidaConfirmada", "per")}`;

const INSCRIPCIONES_COLUMNAS = `
  i.idInscripcion, i.idGira, s.destinoGira, i.idViajero,
  p.nombrePersona + N' ' + p.apellidosPersona AS nombreViajero,
  p.correoPersona, p.telefonoPersona, de.numeroCuenta, de.carreraEstudiante,
  i.idEstado, e.codigoEstado, e.nombreEstado,
  i.idTipoInscripcion, ti.nombre AS nombreTipoInscripcion, ti.requiereMotivo AS esExcepcional,
  i.idInscribidorExcepcional, ${nombreDeUsuario("i.idInscribidorExcepcional")} AS nombreInscribidorExcepcional,
  i.motivoExcepcion, i.observaciones, i.idJefeMision,
  CAST(CASE WHEN i.idViajeroExterno IS NULL THEN 0 ELSE 1 END AS BIT) AS tieneAcompanante,
  i.fechaEnvio, i.usuarioRegistro, i.fechaRegistro,
  per.idPeriodo, per.anioPeriodo, per.numeroPac`;

export function listarInscripciones(filtros: {
  idGira: number | null;
  codigoEstado: string | null;
  excluirBorradores: boolean;
  idViajero: number | null;
  numeroCuenta: string | null;
  busqueda: string | null;
}) {
  const parametros: Record<string, Parametro> = {};
  let donde = "WHERE 1 = 1";

  if (filtros.idGira !== null) {
    donde += " AND i.idGira = @gira";
    parametros["gira"] = [sql.Int, filtros.idGira];
  }
  if (filtros.codigoEstado) {
    donde += " AND e.codigoEstado = @estado";
    parametros["estado"] = [sql.NVarChar(40), filtros.codigoEstado];
  }
  if (filtros.excluirBorradores) donde += " AND e.codigoEstado <> N'Borrador'";
  if (filtros.idViajero !== null) {
    donde += " AND i.idViajero = @viajero";
    parametros["viajero"] = [sql.Int, filtros.idViajero];
  }
  if (filtros.numeroCuenta) {
    donde += " AND de.numeroCuenta = @cuenta";
    parametros["cuenta"] = [sql.NVarChar(15), filtros.numeroCuenta];
  }
  if (filtros.busqueda) {
    donde += " AND (p.nombrePersona + N' ' + p.apellidosPersona LIKE @busqueda OR de.numeroCuenta LIKE @busqueda OR CAST(i.idInscripcion AS NVARCHAR(12)) = @exacto)";
    parametros["busqueda"] = [sql.NVarChar(120), `%${filtros.busqueda}%`];
    parametros["exacto"] = [sql.NVarChar(12), filtros.busqueda];
  }

  return consultar(`SELECT ${INSCRIPCIONES_COLUMNAS} ${INSCRIPCIONES_FROM} ${donde} ORDER BY i.idInscripcion DESC`, parametros);
}

export async function obtenerInscripcion(idInscripcion: number) {
  const id: Parametro = [sql.Int, idInscripcion];

  const cabecera = await consultarUna<{ idViajeroExterno?: number }>(
    `SELECT ${INSCRIPCIONES_COLUMNAS}, i.idViajeroExterno ${INSCRIPCIONES_FROM} WHERE i.idInscripcion = @id`,
    { id },
  );
  if (!cabecera) return null;

  const [acompanante, fichas, documentos, dictamenes] = await Promise.all([
    cabecera.idViajeroExterno
      ? consultarUna(`
          SELECT idViajeroExterno, nombre, ${fechaIso("fechaNacimiento")} AS fechaNacimiento,
                 correoViajero, telefonoViajeroExterno
            FROM Giras.tblViajerosExternos WHERE idViajeroExterno = @externo
        `, { externo: [sql.Int, cabecera.idViajeroExterno] })
      : Promise.resolve(null),
    consultar<{ esViajeroExterno: boolean }>(`
      SELECT f.idFichaSalud, f.esViajeroExterno, f.idTipoSangre, ts.nombre AS nombreTipoSangre,
             f.alergias, f.discapacidad, f.condicionesMedicas, f.medicamentos,
             f.contactoEmergenciaNombre, f.contactoEmergenciaParentesco, f.contactoEmergenciaTelefono
        FROM Giras.tblFichasSalud f
        LEFT JOIN Giras.tblTiposSangre ts ON ts.idTipoSangre = f.idTipoSangre
       WHERE f.idInscripcion = @id
    `, { id }),
    consultar(`
      SELECT idInscripcionDocumento, tipoDocumento, nombre, linkDocumento, fechaRegistro
        FROM Giras.tblInscripcionDocumentos WHERE idInscripcion = @id ORDER BY idInscripcionDocumento
    `, { id }),
    consultar(`
      SELECT d.idInscripcionDictamen, d.idJefeMision, ${nombreDeUsuario("d.idJefeMision")} AS nombreJefeMision,
             d.idEstado, e.codigoEstado, e.nombreEstado, d.justificacionDictamen, d.numeroVersion, d.fechaDictamen
        FROM Giras.tblInscripcionDictamenes d
       INNER JOIN Catalogo.tblEstados e ON e.idEstado = d.idEstado
       WHERE d.idInscripcion = @id ORDER BY d.fechaDictamen DESC, d.idInscripcionDictamen DESC
    `, { id }),
  ]);

  const { idViajeroExterno: _omitido, ...resto } = cabecera;
  return {
    ...resto,
    acompanante,
    fichaSaludEstudiante: fichas.find((f) => !f.esViajeroExterno) ?? null,
    fichaSaludAcompanante: fichas.find((f) => f.esViajeroExterno) ?? null,
    documentos,
    dictamenes,
  };
}

/* -------------------------------- Escritura ------------------------------ */

const usuarioParam = (usuario: string): Parametro => [sql.NVarChar(90), usuario];

/** Lee y BLOQUEA la inscripcion: dos cambios de estado simultaneos se serializan aqui. */
async function bloquear(ejecutar: Ejecutor, idInscripcion: number) {
  const filas = await ejecutar<{ codigoEstado: string; idViajeroExterno: number | null }>(`
    SELECT e.codigoEstado, i.idViajeroExterno
      FROM Giras.tblInscripciones i WITH (UPDLOCK)
     INNER JOIN Catalogo.tblEstados e ON e.idEstado = i.idEstado
     WHERE i.idInscripcion = @id
  `, { id: [sql.Int, idInscripcion] });
  if (!filas[0]) throw noEncontrado(`No existe la inscripcion ${idInscripcion}.`);
  return filas[0];
}

function exigirEditable(codigoEstado: string, idInscripcion: number): void {
  if (!ESTADOS_EDITABLES.includes(codigoEstado)) {
    throw conflicto(
      `La inscripcion ${idInscripcion} esta en estado ${codigoEstado} y ya no se puede modificar: solo en ${ESTADOS_EDITABLES.join(" o ")}.`,
    );
  }
}

async function escribirFicha(
  ejecutar: Ejecutor,
  idInscripcion: number,
  esViajeroExterno: boolean,
  ficha: FichaEntrada | null,
  usuario: string,
): Promise<void> {
  await ejecutar(`DELETE FROM Giras.tblFichasSalud WHERE idInscripcion = @id AND esViajeroExterno = @externo`, {
    id: [sql.Int, idInscripcion],
    externo: [sql.Bit, esViajeroExterno],
  });
  if (ficha === null) return;

  const t = ficha.textos;
  await ejecutar(`
    INSERT INTO Giras.tblFichasSalud
        (idInscripcion, esViajeroExterno, idTipoSangre, alergias, discapacidad, condicionesMedicas,
         medicamentos, contactoEmergenciaNombre, contactoEmergenciaParentesco, contactoEmergenciaTelefono,
         usuarioRegistro)
    VALUES (@id, @externo, @sangre, @alergias, @discapacidad, @condiciones,
            @medicamentos, @contactoNombre, @contactoParentesco, @contactoTelefono, @usuario)
  `, {
    id: [sql.Int, idInscripcion],
    externo: [sql.Bit, esViajeroExterno],
    sangre: [sql.TinyInt, ficha.idTipoSangre],
    alergias: [sql.NVarChar(500), t["alergias"]],
    discapacidad: [sql.NVarChar(500), t["discapacidad"]],
    condiciones: [sql.NVarChar(500), t["condicionesMedicas"]],
    medicamentos: [sql.NVarChar(300), t["medicamentos"]],
    contactoNombre: [sql.NVarChar(120), t["contactoEmergenciaNombre"]],
    contactoParentesco: [sql.NVarChar(50), t["contactoEmergenciaParentesco"]],
    contactoTelefono: [sql.NVarChar(30), t["contactoEmergenciaTelefono"]],
    usuario: usuarioParam(usuario),
  });
}

/** Devuelve el idViajeroExterno con el que queda la inscripcion (null si ya no tiene acompanante). */
async function escribirAcompanante(
  ejecutar: Ejecutor,
  idInscripcion: number,
  actual: number | null,
  acompanante: AcompananteEntrada | null,
  usuario: string,
): Promise<number | null> {
  if (acompanante === null) {
    if (actual !== null) {
      // Orden por las FK: soltar el vinculo, borrar su ficha y por ultimo la persona externa.
      await ejecutar(`UPDATE Giras.tblInscripciones SET idViajeroExterno = NULL WHERE idInscripcion = @id`, {
        id: [sql.Int, idInscripcion],
      });
      await escribirFicha(ejecutar, idInscripcion, true, null, usuario);
      await ejecutar(`DELETE FROM Giras.tblViajerosExternos WHERE idViajeroExterno = @externo`, {
        externo: [sql.Int, actual],
      });
    }
    return null;
  }

  const parametros: Record<string, Parametro> = {
    nombre: [sql.NVarChar(120), acompanante.nombre],
    nacimiento: paramFecha(acompanante.fechaNacimiento),
    correo: [sql.NVarChar(120), acompanante.correoViajero],
    telefono: [sql.NVarChar(30), acompanante.telefonoViajeroExterno],
  };

  if (actual !== null) {
    await ejecutar(`
      UPDATE Giras.tblViajerosExternos
         SET nombre = @nombre, fechaNacimiento = @nacimiento, correoViajero = @correo,
             telefonoViajeroExterno = @telefono
       WHERE idViajeroExterno = @externo
    `, { ...parametros, externo: [sql.Int, actual] });
    return actual;
  }

  const filas = await ejecutar<{ id: number }>(`
    INSERT INTO Giras.tblViajerosExternos (nombre, fechaNacimiento, correoViajero, telefonoViajeroExterno, usuarioRegistro)
    VALUES (@nombre, @nacimiento, @correo, @telefono, @usuario);
    SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
  `, { ...parametros, usuario: usuarioParam(usuario) });
  const idExterno = filas[0]!.id;
  await ejecutar(`UPDATE Giras.tblInscripciones SET idViajeroExterno = @externo WHERE idInscripcion = @id`, {
    externo: [sql.Int, idExterno],
    id: [sql.Int, idInscripcion],
  });
  return idExterno;
}

async function escribirHijos(
  ejecutar: Ejecutor,
  idInscripcion: number,
  externoActual: number | null,
  c: CambiosInscripcion,
  usuario: string,
): Promise<void> {
  let externo = externoActual;
  if (c.acompanante !== undefined) {
    externo = await escribirAcompanante(ejecutar, idInscripcion, externoActual, c.acompanante, usuario);
  }
  if (c.fichaSaludEstudiante !== undefined) {
    await escribirFicha(ejecutar, idInscripcion, false, c.fichaSaludEstudiante, usuario);
  }
  if (c.fichaSaludAcompanante !== undefined) {
    if (c.fichaSaludAcompanante !== null && externo === null) {
      throw solicitudInvalida("No se puede guardar la ficha de salud del acompanante: la inscripcion no tiene acompanante.");
    }
    await escribirFicha(ejecutar, idInscripcion, true, c.fichaSaludAcompanante, usuario);
  }
  if (c.documentos !== undefined) {
    await ejecutar(`DELETE FROM Giras.tblInscripcionDocumentos WHERE idInscripcion = @id`, {
      id: [sql.Int, idInscripcion],
    });
    for (const d of c.documentos) {
      await ejecutar(`
        INSERT INTO Giras.tblInscripcionDocumentos (idInscripcion, tipoDocumento, nombre, linkDocumento, usuarioRegistro)
        VALUES (@id, @tipo, @nombre, @link, @usuario)
      `, {
        id: [sql.Int, idInscripcion],
        tipo: [sql.NVarChar(40), d.tipoDocumento],
        nombre: [sql.NVarChar(200), d.nombre],
        link: [sql.NVarChar(400), d.linkDocumento],
        usuario: usuarioParam(usuario),
      });
    }
  }
}

async function enviarEnTransaccion(ejecutar: Ejecutor, idInscripcion: number): Promise<void> {
  const { codigoEstado } = await bloquear(ejecutar, idInscripcion);
  exigirEditable(codigoEstado, idInscripcion);
  await ejecutar(`UPDATE Giras.tblInscripciones SET idEstado = @estado, fechaEnvio = SYSDATETIME() WHERE idInscripcion = @id`, {
    estado: [sql.Int, await idEstado(CONTEXTO.inscripcion, "Pendiente")],
    id: [sql.Int, idInscripcion],
  });
}

/** Crea la inscripcion como Borrador, o ya como Pendiente si `enviar`. */
export async function crearInscripcion(
  idGira: number,
  idViajero: number,
  cambios: CambiosInscripcion,
  enviar: boolean,
  usuario: string,
): Promise<number> {
  const estadoBorrador = await idEstado(CONTEXTO.inscripcion, "Borrador");

  return enTransaccion(async (ejecutar) => {
    const gira = await ejecutar<{ codigoEstado: string }>(`
      SELECT e.codigoEstado FROM Giras.tblGiras g
       INNER JOIN Catalogo.tblEstados e ON e.idEstado = g.idEstado
       WHERE g.idGira = @gira
    `, { gira: [sql.Int, idGira] });
    if (!gira[0]) throw noEncontrado(`No existe la gira ${idGira}.`);
    if (ESTADOS_GIRA_CERRADOS.includes(gira[0].codigoEstado)) {
      throw conflicto(`La gira ${idGira} esta ${gira[0].codigoEstado} y ya no recibe inscripciones.`);
    }

    const columnas = ["idGira", "idViajero", "idEstado", ...Object.keys(cambios.cabecera), "usuarioRegistro"];
    const filas = await ejecutar<{ id: number }>(`
      INSERT INTO Giras.tblInscripciones (${columnas.join(", ")})
      VALUES (${columnas.map((c) => `@${c}`).join(", ")});
      SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;
    `, {
      ...cambios.cabecera,
      idGira: [sql.Int, idGira],
      idViajero: [sql.Int, idViajero],
      idEstado: [sql.Int, estadoBorrador],
      usuarioRegistro: usuarioParam(usuario),
    });
    const idInscripcion = filas[0]!.id;

    await escribirHijos(ejecutar, idInscripcion, null, cambios, usuario);
    if (enviar) await enviarEnTransaccion(ejecutar, idInscripcion);
    return idInscripcion;
  });
}

/** Edita una inscripcion en Borrador o Correccion. Lo que no llega en el cuerpo no se toca. */
export async function actualizarInscripcion(
  idInscripcion: number,
  cambios: CambiosInscripcion,
  usuario: string,
): Promise<void> {
  if (!hayCambios(cambios)) throw solicitudInvalida("No se envio ningun campo para modificar.");

  await enTransaccion(async (ejecutar) => {
    const { codigoEstado, idViajeroExterno } = await bloquear(ejecutar, idInscripcion);
    exigirEditable(codigoEstado, idInscripcion);

    const columnas = Object.keys(cambios.cabecera);
    if (columnas.length > 0) {
      await ejecutar(`
        UPDATE Giras.tblInscripciones
           SET ${columnas.map((c) => `${c} = @${c}`).join(", ")}
         WHERE idInscripcion = @idInscripcion
      `, { ...cambios.cabecera, idInscripcion: [sql.Int, idInscripcion] });
    }
    await escribirHijos(ejecutar, idInscripcion, idViajeroExterno, cambios, usuario);
  });
}

/** Borrador o Correccion → Pendiente (el reenvio tras una correccion es el mismo gesto). */
export async function enviarInscripcion(idInscripcion: number): Promise<void> {
  await enTransaccion((ejecutar) => enviarEnTransaccion(ejecutar, idInscripcion));
}

/** Solo un Borrador se elimina; una inscripcion enviada queda en el expediente de la gira. */
export async function eliminarInscripcion(idInscripcion: number): Promise<void> {
  await enTransaccion(async (ejecutar) => {
    const { codigoEstado, idViajeroExterno } = await bloquear(ejecutar, idInscripcion);
    if (codigoEstado !== "Borrador") {
      throw conflicto(`Solo se pueden eliminar inscripciones en Borrador; la ${idInscripcion} esta en ${codigoEstado}.`);
    }

    const id: Parametro = [sql.Int, idInscripcion];
    for (const tabla of ["tblFichasSalud", "tblInscripcionDocumentos", "tblInscripcionesLog"]) {
      await ejecutar(`DELETE FROM Giras.${tabla} WHERE idInscripcion = @id`, { id });
    }
    await ejecutar(`DELETE FROM Giras.tblInscripciones WHERE idInscripcion = @id`, { id });
    if (idViajeroExterno !== null) {
      await ejecutar(`DELETE FROM Giras.tblViajerosExternos WHERE idViajeroExterno = @externo`, {
        externo: [sql.Int, idViajeroExterno],
      });
    }
  });
}

/* -------------------------------- Dictamen ------------------------------- */

export const DECISIONES_INSCRIPCION = ["Inscrito", "Rechazada", "Correccion"] as const;
export type DecisionInscripcion = (typeof DECISIONES_INSCRIPCION)[number];

export interface DictamenInscripcion {
  idJefeMision: number;
  decision: DecisionInscripcion;
  justificacion: string | null;
}

/**
 * Pendiente → Inscrito | Rechazada | Correccion, con el dictamen en la misma
 * transaccion. Mismos supuestos que dictaminarSolicitud: solo se dictamina lo
 * Pendiente, y la fila de dictamen lleva GIRA_DICTAMEN (Aprobado/Denegado), o
 * el estado Correccion de la inscripcion cuando no hay equivalente. El jefe
 * que dictamina queda tambien en tblInscripciones.idJefeMision (quien revisa).
 */
export async function dictaminarInscripcion(
  idInscripcion: number,
  d: DictamenInscripcion,
  usuario: string,
): Promise<void> {
  const estadoNuevo = await idEstado(CONTEXTO.inscripcion, d.decision);
  const estadoDictamen =
    d.decision === "Correccion"
      ? estadoNuevo
      : await idEstado(CONTEXTO.dictamen, d.decision === "Inscrito" ? "Aprobado" : "Denegado");

  await enTransaccion(async (ejecutar) => {
    const { codigoEstado } = await bloquear(ejecutar, idInscripcion);
    if (codigoEstado !== "Pendiente") {
      throw conflicto(`Solo se dictamina una inscripcion Pendiente; la ${idInscripcion} esta en ${codigoEstado}.`);
    }

    const version = await ejecutar<{ numeroVersion: number | null }>(`
      SELECT MAX(numeroVersion) AS numeroVersion FROM Giras.tblInscripcionesLog WHERE idInscripcion = @id
    `, { id: [sql.Int, idInscripcion] });

    await ejecutar(`
      INSERT INTO Giras.tblInscripcionDictamenes
          (idInscripcion, idJefeMision, idEstado, justificacionDictamen, numeroVersion, usuarioRegistro)
      VALUES (@id, @jefe, @estadoDictamen, @justificacion, @version, @usuario)
    `, {
      id: [sql.Int, idInscripcion],
      jefe: [sql.Int, d.idJefeMision],
      estadoDictamen: [sql.Int, estadoDictamen],
      justificacion: [sql.NVarChar(1000), d.justificacion],
      version: [sql.Int, version[0]?.numeroVersion ?? null],
      usuario: usuarioParam(usuario),
    });

    await ejecutar(`UPDATE Giras.tblInscripciones SET idEstado = @estado, idJefeMision = @jefe WHERE idInscripcion = @id`, {
      estado: [sql.Int, estadoNuevo],
      jefe: [sql.Int, d.idJefeMision],
      id: [sql.Int, idInscripcion],
    });
  });
}
