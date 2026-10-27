/* =====================================================================
   PROCAD - usuarios y datos de prueba
   ---------------------------------------------------------------------
   Para poder probar el panel contra la base de la universidad: sin esto
   PROCAD esta vacio (ni administrador que firme, ni directores, ni grupos)
   y los triggers rechazan cualquier escritura del panel.

   Crea, todo con «Prueba» en el nombre y usuarioRegistro = semilla_pruebas:
   - 4 empleados: Admin, Vicerrector y dos Directores (perfil Docente o
     Administrativo, que es lo que exigen los triggers de roles y accesos).
   - 2 grupos en Ciudad Universitaria: Futbol masculino (deportivo) y Coro
     (artistico), cada uno con su director en Procad.tblAccesos.
   - 4 estudiantes reales de Registro (solo numeroCuenta: la v2 no copia sus
     datos) con una solicitud PENDIENTE en el periodo activo, para que el
     administrador las resuelva desde el panel. Una no cumple el indice, para
     poder probar el flujo de condicionado.

   Reejecutable: cada fila se busca antes de insertarla. Todo o nada: corre
   en una transaccion.
   ===================================================================== */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRANSACTION;

DECLARE @autor NVARCHAR(90) = N'semilla_pruebas';
DECLARE @campusCU INT = (SELECT idCampus FROM Catalogo.tblCampus WHERE nombreCampus = N'CIUDAD UNIVERSITARIA');
-- El mismo criterio que GET /v1/catalogo/periodos/activo: el activo cuyo rango contiene hoy.
DECLARE @periodo INT = (SELECT TOP 1 idPeriodo FROM Catalogo.tblPeriodos
                         WHERE estadoPeriodo = 1
                           AND CAST(SYSDATETIME() AS DATE) BETWEEN fechaInicioPeriodo AND fechaFinPeriodo
                         ORDER BY fechaInicioPeriodo DESC);

DECLARE @perfilDocente TINYINT = (SELECT idPerfil FROM Catalogo.tblPerfiles WHERE nombre = N'Docente');
DECLARE @perfilAdministrativo TINYINT = (SELECT idPerfil FROM Catalogo.tblPerfiles WHERE nombre = N'Administrativo');
DECLARE @perfilPregrado TINYINT = (SELECT idPerfil FROM Catalogo.tblPerfiles WHERE nombre = N'Estudiante de pregrado');

DECLARE @rolEmpleado TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'GLOBAL' AND nombreRol = N'EMPLEADO');
DECLARE @rolEstudiante TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'GLOBAL' AND nombreRol = N'ESTUDIANTE');
DECLARE @rolAdmin TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'PROCAD' AND nombreRol = N'ADMINISTRADOR_PROCAD');
DECLARE @rolVicerrector TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'PROCAD' AND nombreRol = N'VICERRECTOR');
DECLARE @rolDirector TINYINT = (SELECT idRol FROM Catalogo.tblRoles WHERE sistemaRol = N'PROCAD' AND nombreRol = N'DIRECTOR');

DECLARE @pendiente INT = (SELECT idEstado FROM Catalogo.tblEstados WHERE contextoEstado = N'PROCAD_SOLICITUD' AND codigoEstado = N'PENDIENTE');

IF @campusCU IS NULL OR @periodo IS NULL OR @pendiente IS NULL OR @rolAdmin IS NULL OR @perfilPregrado IS NULL
    THROW 50000, 'Falta un catalogo base (campus, periodo activo, estado PENDIENTE, rol o perfil).', 1;

/* ------------------------------ Empleados ------------------------------ */

DECLARE @empleados TABLE (clave NVARCHAR(20), nombre NVARCHAR(100), apellidos NVARCHAR(100), correo NVARCHAR(120),
                          idGenero TINYINT, idPerfil TINYINT, idRolProcad TINYINT);
INSERT INTO @empleados VALUES
 (N'admin',       N'Admin',       N'Prueba PROCAD',        N'admin.procad@prueba.local',       2, @perfilDocente,        @rolAdmin),
 (N'vicerrector', N'Vicerrector', N'Prueba PROCAD',        N'vicerrector.procad@prueba.local', 1, @perfilAdministrativo, @rolVicerrector),
 (N'dirFutbol',   N'Director',    N'Prueba PROCAD Futbol', N'director.futbol@prueba.local',    1, @perfilDocente,        @rolDirector),
 (N'dirCoro',     N'Directora',   N'Prueba PROCAD Coro',   N'directora.coro@prueba.local',     2, @perfilAdministrativo, @rolDirector);

INSERT INTO Catalogo.tblPersonas (nombrePersona, apellidosPersona, correoPersona, idGenero, idCampus, usuarioRegistro)
SELECT e.nombre, e.apellidos, e.correo, e.idGenero, @campusCU, @autor
  FROM @empleados e
 WHERE NOT EXISTS (SELECT 1 FROM Catalogo.tblPersonas p WHERE p.correoPersona = e.correo);

-- Primero el perfil con el rol global (el trigger de ADMINISTRADOR_PROCAD
-- exige un perfil Docente o Administrativo ya activo), despues el de PROCAD.
INSERT INTO Catalogo.tblPersonaPerfilRol (idPersona, idPerfil, idRol, usuarioRegistro)
SELECT p.idPersona, e.idPerfil, @rolEmpleado, @autor
  FROM @empleados e INNER JOIN Catalogo.tblPersonas p ON p.correoPersona = e.correo
 WHERE NOT EXISTS (SELECT 1 FROM Catalogo.tblPersonaPerfilRol x
                    WHERE x.idPersona = p.idPersona AND x.idPerfil = e.idPerfil AND x.idRol = @rolEmpleado);

INSERT INTO Catalogo.tblPersonaPerfilRol (idPersona, idPerfil, idRol, usuarioRegistro)
SELECT p.idPersona, e.idPerfil, e.idRolProcad, @autor
  FROM @empleados e INNER JOIN Catalogo.tblPersonas p ON p.correoPersona = e.correo
 WHERE NOT EXISTS (SELECT 1 FROM Catalogo.tblPersonaPerfilRol x
                    WHERE x.idPersona = p.idPersona AND x.idPerfil = e.idPerfil AND x.idRol = e.idRolProcad);

/* -------------------------------- Grupos ------------------------------- */

DECLARE @tipoDeportivo TINYINT = (SELECT idTipoGrupo FROM Procad.tblTiposGrupo WHERE nombreTipoGrupo = N'deportivo');
DECLARE @tipoArtistico TINYINT = (SELECT idTipoGrupo FROM Procad.tblTiposGrupo WHERE nombreTipoGrupo = N'artistico');

IF NOT EXISTS (SELECT 1 FROM Procad.tblGrupos WHERE nombreGrupo = N'Futbol masculino Prueba')
    INSERT INTO Procad.tblGrupos (nombreGrupo, idTipoGrupo, idDeporte, categoriaSexo, idCampus, usuarioRegistro)
    VALUES (N'Futbol masculino Prueba', @tipoDeportivo,
            (SELECT idDeporte FROM Procad.tblDeportes WHERE nombreDeporte = N'Futbol 11'),
            N'masculino', @campusCU, @autor);

IF NOT EXISTS (SELECT 1 FROM Procad.tblGrupos WHERE nombreGrupo = N'Coro Prueba')
    INSERT INTO Procad.tblGrupos (nombreGrupo, idTipoGrupo, categoriaSexo, idCampus, usuarioRegistro)
    VALUES (N'Coro Prueba', @tipoArtistico, N'mixto', @campusCU, @autor);

DECLARE @grupoFutbol INT = (SELECT idGrupo FROM Procad.tblGrupos WHERE nombreGrupo = N'Futbol masculino Prueba');
DECLARE @grupoCoro INT = (SELECT idGrupo FROM Procad.tblGrupos WHERE nombreGrupo = N'Coro Prueba');

-- Cada grupo con todos los tipos de actividad de su clase.
INSERT INTO Procad.tblGruposTiposActividades (idGrupo, idTipoActividad, usuarioRegistro)
SELECT g.idGrupo, t.idTipoActividad, @autor
  FROM Procad.tblGrupos g
 INNER JOIN Procad.tblTiposActividades t ON t.idTipoGrupo = g.idTipoGrupo AND t.estadoTipoActividad = 1
 WHERE g.idGrupo IN (@grupoFutbol, @grupoCoro)
   AND NOT EXISTS (SELECT 1 FROM Procad.tblGruposTiposActividades x
                    WHERE x.idGrupo = g.idGrupo AND x.idTipoActividad = t.idTipoActividad);

IF NOT EXISTS (SELECT 1 FROM Procad.tblGruposDisciplinas WHERE idGrupo = @grupoCoro)
    INSERT INTO Procad.tblGruposDisciplinas (idGrupo, idDisciplina, usuarioRegistro)
    VALUES (@grupoCoro, (SELECT idDisciplina FROM Procad.tblDisciplinasArtisticas WHERE nombreDisciplina = N'coro'), @autor);

/* ------------------------------- Accesos ------------------------------- */

INSERT INTO Procad.tblAccesos (idPersona, idGrupo, idCampus, usuarioRegistro)
SELECT p.idPersona, g.idGrupo, @campusCU, @autor
  FROM (VALUES (N'director.futbol@prueba.local', @grupoFutbol),
               (N'directora.coro@prueba.local',  @grupoCoro)) v (correo, idGrupo)
 INNER JOIN Catalogo.tblPersonas p ON p.correoPersona = v.correo
 INNER JOIN Procad.tblGrupos g ON g.idGrupo = v.idGrupo
 WHERE NOT EXISTS (SELECT 1 FROM Procad.tblAccesos a WHERE a.idPersona = p.idPersona AND a.idGrupo = g.idGrupo);

/* ----------------------------- Estudiantes ----------------------------- */

-- Matriculados de Ciudad Universitaria en Registro, con cuenta de 11 digitos
-- (el formato de la UNAH). 20201000079 tiene indice del periodo 59 (< 70):
-- entra con cumpleIndiceMinimo = 0 para probar la propuesta de condicionado.
DECLARE @estudiantes TABLE (numeroCuenta NVARCHAR(15), idGrupo INT, cumpleIndice BIT);
INSERT INTO @estudiantes VALUES
 (N'20201000033', @grupoFutbol, 1),
 (N'20201000056', @grupoFutbol, 1),
 (N'20201000079', @grupoFutbol, 0),
 (N'20201000008', @grupoCoro,   1);

DECLARE @cuenta NVARCHAR(15), @idPersona INT;
DECLARE cursorEstudiantes CURSOR LOCAL FAST_FORWARD FOR
    SELECT e.numeroCuenta FROM @estudiantes e
     WHERE NOT EXISTS (SELECT 1 FROM Catalogo.tblDetallesEstudiantes d WHERE d.numeroCuenta = e.numeroCuenta);
OPEN cursorEstudiantes;
FETCH NEXT FROM cursorEstudiantes INTO @cuenta;
WHILE @@FETCH_STATUS = 0
BEGIN
    INSERT INTO Catalogo.tblPersonas (idCampus, usuarioRegistro) VALUES (@campusCU, @autor);
    SET @idPersona = SCOPE_IDENTITY();
    INSERT INTO Catalogo.tblDetallesEstudiantes (idPersona, numeroCuenta, usuarioRegistro) VALUES (@idPersona, @cuenta, @autor);
    FETCH NEXT FROM cursorEstudiantes INTO @cuenta;
END
CLOSE cursorEstudiantes;
DEALLOCATE cursorEstudiantes;

INSERT INTO Catalogo.tblPersonaPerfilRol (idPersona, idPerfil, idRol, usuarioRegistro)
SELECT d.idPersona, @perfilPregrado, @rolEstudiante, @autor
  FROM @estudiantes e INNER JOIN Catalogo.tblDetallesEstudiantes d ON d.numeroCuenta = e.numeroCuenta
 WHERE NOT EXISTS (SELECT 1 FROM Catalogo.tblPersonaPerfilRol x
                    WHERE x.idPersona = d.idPersona AND x.idPerfil = @perfilPregrado AND x.idRol = @rolEstudiante);

INSERT INTO Procad.tblSolicitudes (idPersona, idGrupo, idPeriodo, idEstado, cumpleIndiceMinimo, fechaInscripcion, usuarioRegistro)
SELECT d.idPersona, e.idGrupo, @periodo, @pendiente, e.cumpleIndice, SYSDATETIME(), @autor
  FROM @estudiantes e INNER JOIN Catalogo.tblDetallesEstudiantes d ON d.numeroCuenta = e.numeroCuenta
 WHERE NOT EXISTS (SELECT 1 FROM Procad.tblSolicitudes s
                    WHERE s.idPersona = d.idPersona AND s.idGrupo = e.idGrupo AND s.idPeriodo = @periodo);

COMMIT TRANSACTION;

/* ------------------------------- Resumen ------------------------------- */

SELECT p.idPersona, CONCAT(p.nombrePersona, N' ', p.apellidosPersona) AS persona, p.correoPersona,
       STRING_AGG(r.nombreRol, N', ') AS roles
  FROM Catalogo.tblPersonas p
 INNER JOIN Catalogo.tblPersonaPerfilRol ppr ON ppr.idPersona = p.idPersona
 INNER JOIN Catalogo.tblRoles r ON r.idRol = ppr.idRol
 WHERE p.correoPersona LIKE N'%@prueba.local'
 GROUP BY p.idPersona, p.nombrePersona, p.apellidosPersona, p.correoPersona
 ORDER BY p.idPersona;

SELECT g.idGrupo, g.nombreGrupo, s.idSolicitud, d.numeroCuenta, s.cumpleIndiceMinimo, e.codigoEstado
  FROM Procad.tblSolicitudes s
 INNER JOIN Procad.tblGrupos g ON g.idGrupo = s.idGrupo
 INNER JOIN Catalogo.tblDetallesEstudiantes d ON d.idPersona = s.idPersona
 INNER JOIN Catalogo.tblEstados e ON e.idEstado = s.idEstado
 WHERE g.nombreGrupo LIKE N'% Prueba'
 ORDER BY g.idGrupo, s.idSolicitud;
GO
