/**
 * Reporteria de Giras: los registros que alimentan el panel de Estadisticas.
 *
 * Una fila por solicitud enviada, sin agregar. El panel filtra, agrupa y suma
 * en el cliente, igual que con Voluntariado, para que dos graficos del mismo
 * panel no puedan contar distinto.
 *
 * Antes el frontend armaba esto pidiendo el detalle de cada solicitud (una
 * peticion por solicitud). Aqui sale en una sola consulta.
 */
import { consultar } from "../../compartido/db";
import { fechaIso, periodoDe } from "../giras/consultas";

/* Una solicitud puede tener varias facultades o finalidades. Se toma la
   primera por nombre, que es la misma que tomaba el frontend, para que cada
   solicitud siga contando como una sola gira en los totales. */
export const listarRegistrosGiras = () =>
  consultar(`
    SELECT s.idSolicitud,
           COALESCE(${fechaIso("s.fechaSalidaPropuesta")}, ${fechaIso("s.fechaRegistro")}) AS fecha,
           per.anioPeriodo, per.numeroPac,
           c.nombreCampus AS campus,
           (SELECT TOP 1 f.nombre FROM Giras.tblSolicitudFacultades x
              INNER JOIN Giras.tblFacultades f ON f.idFacultad = x.idFacultad
             WHERE x.idSolicitud = s.idSolicitud ORDER BY f.nombre) AS facultad,
           (SELECT TOP 1 t.nombre FROM Giras.tblSolicitudFinalidades x
              INNER JOIN Giras.tblTiposFinalidades t ON t.idTipoFinalidad = x.idTipoFinalidad
             WHERE x.idSolicitud = s.idSolicitud ORDER BY t.nombre) AS finalidad,
           ta.nombre AS alcance,
           e.codigoEstado AS estado,
           s.destinoGira AS destino,
           s.totalAproximadoEstudiantes AS estudiantes,
           s.costos AS costo
      FROM Giras.tblSolicitudes s
     INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
     INNER JOIN Catalogo.tblCampus c ON c.idCampus = s.idCampus
      LEFT JOIN Giras.tblTiposAlcance ta ON ta.idTipoAlcance = s.idTipoAlcance
     ${periodoDe("s.fechaSalidaPropuesta", "per")}
     WHERE e.codigoEstado <> N'Borrador'
     ORDER BY s.idSolicitud DESC
  `);
