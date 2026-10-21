/**
 * Usuarios del panel de PROCAD: las personas con algun rol de PROCAD en
 * Catalogo.tblPersonaPerfilRol, menos INTEGRANTE (ese es de los estudiantes
 * de los grupos, lo dan y lo quitan las solicitudes, no el panel).
 *
 * Reglas que pone la base y no se repiten aqui:
 * - tgrPersonaPerfilRolAdminRequiereDocente: ADMINISTRADOR_PROCAD exige perfil Docente activo.
 */
import { consultar, sql } from "../../compartido/db";
import { noEncontrado } from "../../compartido/errores";
import { ordenarPorNombre } from "./registro";

const ROLES_DEL_PANEL = `
  r.sistemaRol = N'PROCAD' AND r.nombreRol <> N'INTEGRANTE'`;

/** Una fila por persona, con sus roles de PROCAD. Activo si conserva al menos uno vigente. */
export async function listarUsuarios(idPersona: number | null = null) {
  const filas = await consultar(`
    SELECT p.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona,
           STRING_AGG(r.nombreRol, N', ') WITHIN GROUP (ORDER BY r.idRol) AS roles,
           CAST(MAX(CAST(ppr.estadoPersonaPerfilRol AS INT)) AS BIT) AS activo
      FROM Catalogo.tblPersonaPerfilRol ppr
     INNER JOIN Catalogo.tblRoles r    ON r.idRol = ppr.idRol
     INNER JOIN Catalogo.tblPersonas p ON p.idPersona = ppr.idPersona
     WHERE ${ROLES_DEL_PANEL}
       AND (@persona IS NULL OR ppr.idPersona = @persona)
     GROUP BY p.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona
  `, { persona: [sql.Int, idPersona] });
  return ordenarPorNombre(filas);
}

/** Desactiva o reactiva todos los roles de PROCAD de la persona (menos INTEGRANTE). */
export async function cambiarEstadoUsuario(idPersona: number, activo: boolean) {
  const [antes] = await listarUsuarios(idPersona);
  if (!antes) throw noEncontrado(`La persona ${idPersona} no tiene roles de PROCAD.`);

  await consultar(`
    UPDATE ppr
       SET ppr.estadoPersonaPerfilRol = @activo
      FROM Catalogo.tblPersonaPerfilRol ppr
     INNER JOIN Catalogo.tblRoles r ON r.idRol = ppr.idRol
     WHERE ppr.idPersona = @persona AND ${ROLES_DEL_PANEL}
  `, { persona: [sql.Int, idPersona], activo: [sql.Bit, activo] });

  const [despues] = await listarUsuarios(idPersona);
  return despues;
}
