/* =====================================================================
   PROCAD sobre DbVoae v2 - columnas y reglas que la v2 no trae
   ---------------------------------------------------------------------
   Ejecutar DESPUES de 01_DbVoae_v2.sql y 02_DbVoae_v2_registro.sql, en la
   misma base. Sin esto, voae-procad falla al crear o listar actividades y
   visorias (columnas tituloActividad, estadoVisoria... inexistentes).

   Son las migraciones 2026-09-23 (1), (3) y (4), que se aplicaron en Azure
   pero nunca entraron al script v2. Se copian sin cambios. Solo tocan el
   esquema Procad. Reejecutable: cada paso revisa si ya existe.

   NO incluye, a proposito:
   - 2026-09-23 (2) spActivarNuevoPeriodo: la v2 ya trae su propia version,
     que valida la matricula contra Registro. Ejecutar la de Azure la
     reemplazaria por una que lee columnas que la v2 ya no tiene.
   - 2026-09-23 (5) estado OBSERVADA de actividades: es una fila de
     Catalogo (compartido), estaba sin aplicar y voae-procad no la usa.
   ===================================================================== */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO
USE DbGestionProcesosVoae;
GO

/* ------------------------- 2026-09-23 (1) ---------------------------- */

-- Otro es un motivo abierto: sin detalle, la solicitud de expulsion no dice
-- por que se pide (RF-45). Se busca por nombre, igual que los demas triggers
-- buscan 'deportivo' o 'ADMINISTRADOR_PROCAD'.
CREATE OR ALTER TRIGGER Procad.tgrSolicitudesExpulsionOtroRequiereDetalle
ON Procad.tblSolicitudesExpulsion
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF NOT (UPDATE(idMotivoExpulsion) OR UPDATE(detalleMotivo)) RETURN;
    IF EXISTS (
        SELECT 1
        FROM inserted i
        INNER JOIN Procad.tblMotivosExpulsion m ON m.idMotivoExpulsion = i.idMotivoExpulsion
        WHERE m.nombreMotivoExpulsion = N'Otro'
          AND (i.detalleMotivo IS NULL OR LTRIM(RTRIM(i.detalleMotivo)) = N'')
    )
    BEGIN
        RAISERROR ('Si el motivo de expulsion es Otro, hay que explicarlo en detalleMotivo.', 16, 1);
        ROLLBACK TRANSACTION;
        RETURN;
    END
END
GO

/* ------------------------- 2026-09-23 (3) ---------------------------- */

IF COL_LENGTH('Procad.tblActividades', 'tituloActividad') IS NULL
    ALTER TABLE Procad.tblActividades ADD tituloActividad NVARCHAR(150) NULL;
GO
IF COL_LENGTH('Procad.tblActividades', 'horaActividad') IS NULL
    ALTER TABLE Procad.tblActividades ADD horaActividad TIME NULL;
GO
IF COL_LENGTH('Procad.tblActividades', 'lugarActividad') IS NULL
    ALTER TABLE Procad.tblActividades ADD lugarActividad NVARCHAR(150) NULL;
GO
-- Horas que se le abonan a cada asistente si la actividad queda VALIDADA.
IF COL_LENGTH('Procad.tblActividades', 'horasAbonadas') IS NULL
    ALTER TABLE Procad.tblActividades ADD horasAbonadas DECIMAL(4,1) NULL
        CONSTRAINT chkActividadProcad_HorasAbonadas CHECK (horasAbonadas IS NULL OR horasAbonadas >= 0);
GO
-- Por que se hizo y que deja: lo que el administrador lee antes de validar.
IF COL_LENGTH('Procad.tblActividades', 'justificacionActividad') IS NULL
    ALTER TABLE Procad.tblActividades ADD justificacionActividad NVARCHAR(1000) NULL;
GO
-- El encargado que la reporto. usuarioRegistro es una cadena de auditoria,
-- no una persona: con esto el panel puede mostrar nombre y correo.
IF COL_LENGTH('Procad.tblActividades', 'idPersonaReporta') IS NULL
    ALTER TABLE Procad.tblActividades ADD idPersonaReporta INT NULL
        CONSTRAINT fkActividadProcad_PersonaReporta FOREIGN KEY REFERENCES Catalogo.tblPersonas(idPersona);
GO

-- Respaldo de la actividad (fotos de la lista, constancias...). La base
-- guarda el enlace, nunca el archivo, igual que tblAdjuntosSolicitudes.
IF OBJECT_ID('Procad.tblAdjuntosActividades', 'U') IS NULL
CREATE TABLE Procad.tblAdjuntosActividades
(
    idAdjuntoActividad INT NOT NULL IDENTITY(1,1),
    idActividad        INT NOT NULL,
    nombreArchivo      NVARCHAR(200) NOT NULL,
    urlArchivo         NVARCHAR(300) NOT NULL,
    usuarioRegistro    NVARCHAR(90) NOT NULL
        CONSTRAINT dfAdjuntoActividad_UsuarioRegistro DEFAULT (SUSER_SNAME()),
    fechaRegistro      DATETIME2 NOT NULL
        CONSTRAINT dfAdjuntoActividad_FechaRegistro DEFAULT (SYSDATETIME()),
    CONSTRAINT pkAdjuntoActividad PRIMARY KEY (idAdjuntoActividad),
    CONSTRAINT fkAdjuntoActividad_Actividad FOREIGN KEY (idActividad)
        REFERENCES Procad.tblActividades(idActividad)
);
GO

/* ------------------------- 2026-09-23 (4) ---------------------------- */

IF COL_LENGTH('Procad.tblVisorias', 'idGrupo') IS NULL
    ALTER TABLE Procad.tblVisorias ADD idGrupo INT NULL
        CONSTRAINT fkVisoria_Grupo FOREIGN KEY REFERENCES Procad.tblGrupos(idGrupo);
GO
IF COL_LENGTH('Procad.tblVisorias', 'estadoVisoria') IS NULL
    ALTER TABLE Procad.tblVisorias ADD estadoVisoria NVARCHAR(15) NOT NULL
        CONSTRAINT dfVisoria_Estado DEFAULT (N'PROGRAMADA')
        CONSTRAINT chkVisoria_Estado CHECK (estadoVisoria IN (N'BORRADOR', N'PROGRAMADA'));
GO

-- Mismo criterio que tgrVisoriasLugarMismoCampus: la visoria de un grupo es
-- en su campus. Una seleccion queda fuera: su campus es solo la sede
-- administrativa y reune integrantes de varios centros.
CREATE OR ALTER TRIGGER Procad.tgrVisoriasGrupoMismoCampus
ON Procad.tblVisorias
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted i
        INNER JOIN Procad.tblGrupos g ON g.idGrupo = i.idGrupo
        WHERE g.esSeleccion = 0
          AND g.idCampus <> i.idCampus
    )
    BEGIN
        RAISERROR ('El grupo de la visoria debe pertenecer al mismo campus que la visoria.', 16, 1);
        ROLLBACK TRANSACTION;
        RETURN;
    END
END
GO
