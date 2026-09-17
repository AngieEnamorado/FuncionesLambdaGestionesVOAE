# Arquitectura propuesta — Funciones Lambda VOAE

Documento para discusión en equipo. Propuesta de arquitectura del backend del sistema de
gestiones VOAE (UNAH): frontend React compilado en S3, toda la lógica de backend y acceso a
datos en funciones Lambda.

**Estado:** propuesta, con la primera función ya construida. `voae-catalogo` se implementó y
desplegó el **2026-09-17** y está sirviendo tráfico real contra Azure; las otras cuatro siguen sin
implementar. Las cifras de latencia y de arranque en frío de §2 ya no vienen de una máquina de
desarrollo: salen de esa función corriendo en `us-east-1`.

---

## 1. Decisión: 5 funciones (4 de dominio + 1 de reportería)

Se evaluaron cuatro opciones de granularidad:

| Opción | Descripción | Veredicto |
|---|---|---|
| A | 1 Lambda por dominio (4 funciones) | Buena base, pero mezcla reportes con tráfico interactivo |
| B | 1 Lambda por submódulo (~22 funciones) | Viable, pero los bordes de submódulo no coinciden con los bordes de datos |
| C | Lambdalith (1 función) | Más simple de operar, mala para 3 personas trabajando en paralelo |
| **D** | **4 de dominio + 1 de reportería (5 funciones)** | **Elegida** |

### Por qué D

**Los dominios son islas de datos reales.** Se consultaron las 185 foreign keys de la base de
datos y agrupando por esquema da esto:

| Desde → Hacia | FKs |
|---|---|
| Giras → Giras | 50 |
| Procad → Procad | 36 |
| Voluntariado → Voluntariado | 30 |
| Procad → Catalogo | 32 |
| Voluntariado → Catalogo | 16 |
| Giras → Catalogo | 9 |
| Catalogo → Catalogo | 7 |
| Catalogo → Giras / Procad / Voluntariado | 3 / 1 / 1 |
| **Giras ↔ Procad ↔ Voluntariado** | **0** |

No existe **ni una sola** FK entre Giras, Procad y Voluntariado. Los tres subsistemas son
independientes entre sí y solo comparten `Catalogo`. En cambio, *dentro* de cada dominio la
densidad es alta (50 FKs internas solo en Giras). Un corte por submódulo (opción B) partiría esos
clústeres por la mitad: `informes` y `actividades` de Voluntariado serían Lambdas distintas leyendo
las mismas tablas, así que el límite quedaría de adorno. El corte por esquema sigue la línea que
los datos ya tienen dibujada.

**La reportería se separa por perfil de recursos, no por menú.** Las pantallas de estadísticas y
reportes hacen agregaciones pesadas y generan exportables; necesitan más memoria y timeout largo.
El resto de endpoints son CRUD de milisegundos. Con la base de datos en 1 vCore (ver §2), lo último
que conviene es que un reporte le robe CPU al tráfico interactivo. Separarla permite darle su propia
concurrencia reservada y contener el daño.

---

## 2. Restricciones medidas (2026-09-16, ampliadas el 2026-09-17)

Todo esto se verificó contra la base de datos real, no es estimación:

- **Tier: `GP_S_Gen5_1`** — Azure SQL General Purpose **Serverless, 1 vCore**. Es el cómputo más
  pequeño del tier. **Este es el cuello de botella del sistema completo**, no la capa Lambda.
  Repartir el backend en más funciones no da throughput: la base de datos es el techo.
- **`max_sessions` = 30,000.** El límite de conexiones **no** es una restricción. (Esto descartó el
  argumento inicial a favor de pocas funciones; la razón real para D es el acoplamiento de datos y
  el perfil de recursos, no las sesiones.)
- **Ubicación: Azure East US (Virginia)**, según el SLO `...128IAD`. Geográficamente pegada a AWS
  `us-east-1`, que es donde va el cómputo.
- **Latencia, medida desde `voae-catalogo` en `us-east-1` (2026-09-17):**

  | | Desde una máquina de desarrollo (2026-09-16) | Desde la Lambda (2026-09-17) |
  |---|---|---|
  | Round trip con consulta | ~310 ms | **180–200 ms** |
  | Arranque en frío (`Init Duration`) | ~1.3 s | **649 ms** |
  | Consulta servida desde el caché | — | **2 ms** |

  La sospecha de que desde `us-east-1` sería bastante menor se confirmó. Los 649 ms de arranque en
  frío incluyen cargar un paquete de 13.8 MB (`mssql` arrastra `@azure/identity`, 48 MB sin
  comprimir, para una autenticación AAD que no usamos), así que el tamaño del paquete no es hoy un
  problema que valga la pena atacar.
- **Memoria: 124 MB usados de 512 MB** asignados, en todas las invocaciones observadas. Los 512 MB
  de §5 son holgados; 256 MB alcanzan.
- **La base de datos se queda en Azure de forma definitiva.** Decisión cerrada, no se rediscute.

### Consecuencias no negociables

1. **Pool de conexiones y secreto en *module scope***, fuera del handler, para que sobrevivan entre
   invocaciones. Abrir conexión o leer Secrets Manager por request es latencia y costo regalados.
2. **Concurrencia reservada por función**, para que ninguna pueda saturar 1 vCore sola.
3. **Cachear los catálogos.** `tblEstados` (61 filas), `tblCampus` (**18**, no 16: los seeds
   cambiaron desde que se escribió esto), `tblRoles` (14), `tblPerfiles` (5), `tblProgramasVoae` (3)
   y todos los `tblTipos*` son diminutos y casi estáticos, y prácticamente toda pantalla los pide.
   Sacarlos del camino crítico es la mayor palanca de rendimiento disponible — más que cualquier
   decisión sobre número de funciones.

   **Confirmado el 2026-09-17:** en una ráfaga de 10 peticiones concurrentes a `/v1/catalogo/campus`,
   las que encontraron el catálogo cacheado se resolvieron en **2 ms** contra los **180 ms** de las
   que fueron a la base. Dos órdenes de magnitud, y ni una sesión consumida del vCore.
4. **El auto-pause del tier serverless ESTÁ activo. Confirmado el 2026-09-17, y es un bloqueante
   de producción.** Lo que era una sospecha quedó demostrado al desplegar: las tres primeras
   peticiones de `voae-catalogo` (15:33:44–15:34:10 UTC) devolvieron 503 por timeout de conexión, y
   `sys.dm_db_resource_stats` no tiene ni una muestra anterior a las 15:34:52 pese a guardar una
   hora de historia. La prueba concluyente es `sqlserver_start_time = 15:34:17`: **el proceso de SQL
   Server arrancó 32 segundos después de la primera petición.** La Lambda despertó la base.

   Desde que llega la primera conexión hasta que la base sirve pasan **~70 segundos**, y eso **no se
   puede tapar desde el código**: el timeout duro de una HTTP API de API Gateway son 30 s. Ni
   alargar el timeout de la Lambda ni reintentar adentro alcanzan. Tal como está, **el primer
   usuario tras cada rato de inactividad recibe un error**, todos los días.

   Es una decisión de infraestructura, en el portal de Azure, y hay que tomarla antes de exponer
   esto a usuarios reales:

   - **Desactivar el auto-pause** (poner el retardo en "nunca"). Es el arreglo real; se paga cómputo
     continuo aunque nadie use el sistema.
   - **Un ping programado** que mantenga la base despierta. Cuesta prácticamente lo mismo que lo
     anterior, porque el costo es la base facturando, y agrega una pieza móvil que puede fallar en
     silencio.
   - **Aceptar la falla** y que el frontend la muestre como "el sistema está despertando, reintente
     en un minuto". Gratis, honesto, y probablemente inaceptable para una oficina que abre a las 8.

   Mientras tanto, el 503 que devuelven las funciones ante este caso es deliberado y correcto: no se
   disfraza de 500 ni se cuelga esperando.

---

## 3. Las funciones

Ruteo: API Gateway HTTP API con ruta greedy por función (`/v1/{dominio}/{proxy+}`). Cada Lambda
lleva un router interno mínimo, así que agregar un endpoint es editar un archivo, no crear
infraestructura.

### 3.1 `voae-catalogo`

**Responsabilidad:** datos de referencia transversales y resolución de identidad/perfiles. Es la
función de la que dependen las otras tres, y la dueña del caché de catálogos.

**Esquema:** `Catalogo` (11 tablas)

| Endpoint | Qué hace |
|---|---|
| `GET /v1/catalogo/estados?contexto=GIRA_SOLICITUD` | Estados filtrados por `contextoEstado`. Alimenta todo selector y badge de estado de la app. Sin el filtro devuelve las 61 filas de los 3 sistemas mezcladas, que no le sirve a nadie. |
| `GET /v1/catalogo/campus` | Los 18 centros. Usado por los filtros de PROCAD, Voluntariado y Giras. |
| `GET /v1/catalogo/periodos` | Períodos académicos. |
| `GET /v1/catalogo/periodos/activo` | El período vigente, que casi toda pantalla necesita por defecto. **Ojo:** no hay columna ni trigger que marque cuál es el activo. Se resuelve por rango de fechas (el período activo cuyo rango contiene hoy) con respaldo al más reciente por año y PAC. Es una convención que la implementación tuvo que inventar; conviene que el equipo la valide o que el esquema la haga explícita. |
| `GET /v1/catalogo/roles` · `GET /v1/catalogo/perfiles` | Catálogo de roles (14) y perfiles (5). |
| `GET /v1/catalogo/programas` | Los 3 programas VOAE. |
| `GET /v1/catalogo/personas/{idPersona}` | Datos de una persona desde `tblPersonas`. |
| `GET /v1/catalogo/personas/{idPersona}/perfiles` | Sus filas de `tblPersonaPerfilRol` — qué es esa persona y en qué programa. Es el endpoint que reemplazará al mock de sesión del frontend cuando exista auth. |
| `GET /v1/catalogo/estudiantes/{numeroCuenta}` | Detalle 1:1 desde `tblDetallesEstudiantes` (índices, documentos). |
| `GET /v1/catalogo/empleados/{numeroEmpleado}` | Detalle 1:1 desde `tblDetallesEmpleados`. |
| `GET /v1/catalogo/notificaciones?persona={id}` · `POST .../{id}/lectura` | Bandeja de `tblNotificaciones` y marcado de leída. |

**Dos rutas que no estaban en esta tabla y se agregaron al implementar:**

- `GET /v1/catalogo/estados/contextos` — los contextos existentes con su conteo. Sin esto, quien
  consume `/estados` tiene que saber de memoria que el filtro se llama `GIRA_SOLICITUD` y no
  `GIRAS_SOLICITUD`.
- `GET /v1/catalogo/salud` — ping a la base con el tiempo que tardó y si el contenedor estaba frío.
  Se agregó porque las mediciones pendientes de §2 no se podían tomar desde fuera de la Lambda, y es
  lo que destapó el auto-pause. Cada función nueva debería traer la suya.

**Nota de diseño:** el modelo de identidad no tiene tablas "Empleado" ni "Estudiante". Hay una sola
`tblPersonas`, y ser empleado o estudiante es un rol que la persona *tiene*
(`tblPersonaPerfilRol`), con sus atributos propios en tablas de detalle 1:1. Los endpoints
respetan eso: se pide la persona, y aparte su detalle.

---

### 3.2 `voae-giras`

**Responsabilidad:** ciclo de vida completo de giras académicas — solicitud, dictamen, gira,
inscripciones, fichas de salud, costos, informes.

**Esquema:** `Giras` (38 tablas)

| Endpoint | Qué hace |
|---|---|
| `GET /v1/giras/solicitudes` | Lista con filtros (centro, período, estado, facultad). Pantalla `giras/Solicitudes.tsx`. |
| `GET /v1/giras/solicitudes/{id}` | Detalle completo: `tblSolicitudes` + finalidades + facultades + categorías + financiamientos + transportes + costos. |
| `POST /v1/giras/solicitudes` | Crea solicitud. Escribe la cabecera y sus N:M (`tblSolicitudFinalidades`, `tblSolicitudFacultades`, `tblSolicitudCategorias`, `tblSolicitudFinanciamientos`, `tblSolicitudTransportes`). |
| `PUT /v1/giras/solicitudes/{id}` | Edita solicitud no dictaminada. |
| `POST /v1/giras/solicitudes/{id}/dictamen` | Aprueba o deniega. Escribe `tblSolicitudDictamenes`; si deniega, guarda `idTipoCancelacion`. **El cambio de estado lo hacen los triggers, el handler no lo escribe a mano.** |
| `GET/POST/PUT/DELETE /v1/giras/borradores[/{id}]` | Borradores de solicitud a medio llenar (pantalla `Borradores.tsx`; el tipo `BorradorGira` del frontend tiene todo opcional salvo el id). |
| `GET /v1/giras/giras?persona={id}` | "Mis giras": donde la persona es docente o jefe de misión. Pantalla `MisGiras.tsx`. El id va explícito como parámetro mientras no exista una capa de sesión. |
| `GET /v1/giras/giras/{id}` | Resumen de gira (`ResumenGira.tsx`). |
| `POST /v1/giras/giras/{id}/cancelacion` | Cancela una gira ya aprobada. Escribe `idTipoCancelacion`, `idPersonaCancela`, `motivoCancelacion`; **el trigger `tgrGirasCancelacionValidar` valida la coherencia y arrastra las inscripciones vivas al estado "Cancelada por gira"**. No replicar esa cascada en código. |
| `POST /v1/giras/giras/{id}/modificaciones` | `tblGiraModificaciones` + `tblTiposModificaciones`. |
| `GET /v1/giras/giras/{id}/inscripciones` | Listado de inscritos (`InscripcionesGira.tsx`). |
| `GET /v1/giras/inscripciones/{id}` | Detalle: datos del estudiante, ficha de salud, acompañante externo, documentos (`DetalleInscripcion.tsx`). |
| `POST /v1/giras/giras/{id}/inscripciones` | Inscripción autogestionada (`idTipoInscripcion` = 1 por defecto). |
| `POST /v1/giras/giras/{id}/inscripciones/excepcional` | Inscripción hecha por un tercero. Requiere `idInscribidorExcepcional` y `motivoExcepcion`; **el trigger `tgrInscripcionesExcepcionValidar` los exige**. El origen es independiente del estado: una excepcional recorre igual Borrador → Pendiente → Inscrito. |
| `POST /v1/giras/inscripciones/{id}/dictamen` | `tblInscripcionDictamenes`. |
| `PUT /v1/giras/inscripciones/{id}/ficha-salud` | `tblFichasSalud` + `tblTiposSangre`, propia y del acompañante. |
| `POST /v1/giras/inscripciones/{id}/acompanante` | `tblViajerosExternos`. |
| `POST /v1/giras/{solicitudes\|inscripciones}/{id}/documentos` | Alta de documento de respaldo. Sube a S3 con URL prefirmada; la BD guarda la llave, no el archivo (`tblSolicitudDocumentos` / `tblInscripcionDocumentos`). |
| `PUT /v1/giras/solicitudes/{id}/costos` | Escribe líneas en `tblCostosDetalle` (nombre y descripción en texto abierto). **El total en `tblSolicitudes.costos` lo mantiene un trigger** — el handler escribe el detalle y vuelve a leer el total, no lo calcula. |
| `GET/POST /v1/giras/informes` | `tblInformes` + `tblTiposInforme`. |
| `GET /v1/giras/catalogos` | Catálogos propios del dominio en una sola respuesta cacheable: alcances (3), finalidades (5), financiamientos (5), transporte, cancelación (8), categorías (2), tipos de informe (3), tipos de inscripción (2), facultades, parámetros (9). |
| `GET /v1/giras/unidades` | `tblUnidadFacultadCentro`, `tblTiposUnidad`, `tblUsuarioUnidad` — la cadena de unidades administrativas. |

---

### 3.3 `voae-procad`

**Responsabilidad:** gestión del programa de cultura, arte y deporte — solicitudes de ingreso,
agrupaciones, actividades, visorías, expulsiones, configuración de períodos.

**Esquema:** `Procad` (29 tablas)

| Endpoint | Qué hace |
|---|---|
| `GET /v1/procad/solicitudes` | Solicitudes de ingreso con filtros (centro, tipo, grupo, estado). Pantalla `procad/Estudiantes.tsx`. |
| `GET /v1/procad/solicitudes/{id}` | Ficha completa: `tblSolicitudes` + `tblDetallesSolicitudes` + adjuntos de experiencia. |
| `POST /v1/procad/solicitudes/{id}/resolucion` | Aprobar / observar / no cumple. Registra en `tblLogsEstadosSolicitudes`. |
| `GET /v1/procad/condicionados` · `POST /v1/procad/condicionados/{id}/autorizacion` | Excepciones de talento: el entrenador propone, el administrador autoriza. Sin esa segunda firma la solicitud no puede quedar aprobada. |
| `GET /v1/procad/expulsiones` · `POST /v1/procad/expulsiones/{id}/resolucion` | `tblSolicitudesExpulsion` + `tblMotivosExpulsion` (5). |
| `GET/POST /v1/procad/matriculas-excepcionales` | `tblMatriculasExcepcionales`. |
| `GET /v1/procad/grupos` · `GET /v1/procad/grupos/{id}` | Agrupaciones con sus disciplinas (`tblGruposDisciplinas`) y tipos de actividad permitidos (`tblGruposTiposActividades`). Pantalla `Agrupaciones.tsx`. |
| `POST/PUT /v1/procad/grupos[/{id}]` | Alta y edición de agrupación. |
| `GET /v1/procad/grupos/{id}/integrantes` | Incluye `tblSeleccionIntegrantes` para selecciones multi-campus. |
| `GET /v1/procad/actividades` | Actividades reportadas por encargados, pendientes de validar. |
| `POST /v1/procad/actividades/{id}/validacion` | Validar / observar / rechazar. Estados: `PENDIENTE_VALIDACION` → `VALIDADA` / `OBSERVADA` / `RECHAZADA`. Las horas se abonan a los asistentes al validar. |
| `POST /v1/procad/actividades/{id}/asistencia` | `tblAsistencias`. |
| `POST /v1/procad/series` | Actividades recurrentes. **Llama a `Procad.spGenerarActividadesSerie`** (`tblSeriesActividades` + `tblSeriesActividadesDias`). La lógica de recurrencia ya existe en el SP; no se reimplementa. |
| `POST /v1/procad/periodos/activar` | **Llama a `Procad.spActivarNuevoPeriodo`.** Junto con el SP anterior, son los dos únicos stored procedures de toda la base de datos. |
| `GET /v1/procad/periodos/configuracion` | `tblConfiguracionesGruposPeriodos`. |
| `GET/POST /v1/procad/visorias` · `POST /v1/procad/visorias/{id}/programar` | Pruebas de ingreso. En `BORRADOR` solo existen para el administrador; al programarlas los citados quedan notificados. `tblLugaresVisoria` (10), `tblAulas`. |
| `GET/POST /v1/procad/listas-preferenciales` | `tblListasPreferenciales` + `tblDetallesListasPreferenciales`. |
| `GET /v1/procad/prosene` | `tblBeneficiariosProsene`. |
| `GET /v1/procad/accesos` | `tblAccesos` — quién tiene acceso al panel. Un colaborador externo nunca lo recibe: el administrador actúa en su nombre. |
| `GET /v1/procad/catalogos` | Deportes, disciplinas artísticas (6), instrumentos (10), posiciones (18), tipos de actividad (9), tipos de grupo (2), motivos de expulsión (5), lugares de visoría (10). |

---

### 3.4 `voae-voluntariado`

**Responsabilidad:** voluntariado universitario, con dos audiencias sobre el mismo esquema: el
panel administrativo VOAE y el portal del estudiante.

**Esquema:** `Voluntariado` (24 tablas)

| Endpoint | Qué hace |
|---|---|
| `GET /v1/voluntariado/grupos` | Catálogo de grupos con campus y redes temáticas. Pantallas `GestionGrupos.tsx` (admin) y `CatalogoGrupos.tsx` (estudiante). |
| `GET /v1/voluntariado/grupos/{id}` | Detalle: misión, visión, reseña, junta directiva, miembros, documentos. |
| `POST /v1/voluntariado/solicitudes-grupos` | Solicitud de creación de grupo. Escribe `tblSolicitudesGruposNuevos` + `tblSolicitudesJuntasDirectivas` + `tblSolicitudesMiembrosFundadores` en una transacción. Es el `CrearGrupoWizard.tsx`. |
| `GET /v1/voluntariado/solicitudes-grupos` · `POST .../{id}/resolucion` | Bandeja y dictamen del admin (`SolicitudesGruposLista.tsx`). |
| `GET /v1/voluntariado/grupos/{id}/miembros` | `tblMiembrosGrupos` + `tblCargos` (8 cargos de junta directiva). |
| `POST /v1/voluntariado/grupos/{id}/solicitudes-union` | El estudiante pide unirse (`tblSolicitudesUniones`). |
| `POST /v1/voluntariado/solicitudes-union/{id}/resolucion` | El **coordinador del grupo** acepta o rechaza, no VOAE (`SolicitudesPendientes.tsx`). |
| `GET /v1/voluntariado/grupos/{id}/campus` | `tblGruposCampus` — un grupo puede operar en varios centros con nombre único a nivel nacional. |
| `GET /v1/voluntariado/actividades` | Actividades con su grupo y coorganizador (`tblActividadesGrupos` para las conjuntas). |
| `POST /v1/voluntariado/solicitudes-actividades` | Solicitud de actividad proyectada (`tblSolicitudesActividadesProyectadas`). |
| `POST /v1/voluntariado/actividades/{id}/aprobacion` | Aprobación por VOAE (`AprobacionActividades.tsx`). |
| `POST /v1/voluntariado/actividades/{id}/asistencia` | Pasar lista (`PasarLista.tsx`) → `tblParticipaciones`. **Es el endpoint más importante del dominio:** de aquí salen las horas confirmadas y el porcentaje de participación que determina la elegibilidad a diploma. |
| `POST /v1/voluntariado/actividades/{id}/fotos` | Evidencia fotográfica. S3 prefirmado + `tblFotosActividades`. |
| `PUT /v1/voluntariado/actividades/{id}/resultados` | Resultados narrativos (`ResultadosEvidencia.tsx`). |
| `GET /v1/voluntariado/informes` · `GET /v1/voluntariado/informes/{id}` | Informes trimestrales (`InformesLista.tsx`, `InformeDetalle.tsx`). |
| `POST/PUT /v1/voluntariado/informes[/{id}]` | Captura del informe + `tblInformesTrimestralesActividades`. |
| `POST /v1/voluntariado/informes/{id}/envio` | `EN CAPTURA` → `ENVIADO`. |
| `POST /v1/voluntariado/informes/{id}/dictamen` | `ENVIADO` → `OBSERVADO` / `ACEPTADO`. |
| `GET/PUT /v1/voluntariado/informes/{id}/economico` | `tblInformesEconomicos` + `tblMovimientosEconomicos` (ingreso/egreso, responsable, tipo de comprobante) + `tblInformesEconomicosGrupos`. Pantalla `InformeEconomico.tsx`. |
| `GET /v1/voluntariado/diplomas/elegibles` | Estudiantes que superan el umbral de participación. **El cálculo debe vivir aquí o en la BD, no en el cliente** — hoy está en `voluntariadoSelectors.ts` del frontend. |
| `POST /v1/voluntariado/diplomas` | Emisión (`tblDiplomas`). |
| `POST /v1/voluntariado/solicitudes/{id}/adjuntos` | `tblAdjuntosSolicitudes` + `tblRequisitosAdjuntos` (4 requisitos). S3 prefirmado. |
| `GET /v1/voluntariado/catalogos` | Redes temáticas, trimestres (con `fechaLimite`), cargos (8), requisitos de adjuntos (4). |

**Nota:** el portal del estudiante (`/voluntariado/portal-estudiante/*`) consume esta misma función.
Es una audiencia distinta con su propio shell móvil en el frontend, pero los mismos datos. Si más
adelante su tráfico o su modelo de permisos divergen, es el candidato natural a separarse en una
sexta función — no hace falta decidirlo ahora.

---

### 3.5 `voae-reporteria`

**Responsabilidad:** agregaciones pesadas y exportables de los tres dominios. Es la única función
que lee de varios esquemas, y lo hace **solo en modo lectura**.

**Esquemas:** `Giras`, `Procad`, `Voluntariado`, `Catalogo` (lectura)

| Endpoint | Qué hace |
|---|---|
| `GET /v1/reporteria/giras/estadisticas` | KPIs y series del dashboard de Giras: giras por período, campus, facultad, finalidad, alcance, costo, estudiantes movilizados. Pantalla `giras/Estadisticas.tsx`. |
| `GET /v1/reporteria/procad/estadisticas` | Cifras por agrupación y los rollups por centro regional. Pantalla `procad/Estadisticas.tsx`. Ojo: el frontend nunca consulta una métrica ya agregada — filtra, suma y escala desde la unidad por agrupación. Conviene que la API devuelva esa misma unidad y no totales pre-cocinados, para que el panel no pueda contradecirse. |
| `GET /v1/reporteria/procad/reporte-personalizado` | Reporte armado según la selección que el panel lleva en la URL (`ReportePersonalizado.tsx`). |
| `GET /v1/reporteria/voluntariado/tablero` | Tablero nacional (`TableroNacional.tsx`). |
| `GET /v1/reporteria/voluntariado/estadisticas` | Participación, horas y actividades por campus y red temática. |
| `POST /v1/reporteria/exportaciones` | **Decisión pendiente** — ver §7. Generaría el PDF/Excel en servidor, lo dejaría en S3 y devolvería una URL prefirmada. Hoy el frontend ya genera PDF en el cliente con jsPDF. |

**Configuración diferenciada:** más memoria, timeout largo y concurrencia reservada propia. Es todo
el punto de que exista como función aparte.

---

## 4. Código compartido

Un paquete interno bundleado en las 5 funciones (más simple que un Lambda Layer con tan pocas
funciones):

- **`db`** — pool de conexiones creado en *module scope*. Una sola instancia por contenedor,
  reutilizada entre invocaciones.
- **`secretos`** — lectura de `secreto-voae` desde AWS Secrets Manager, cacheada en memoria. Nunca
  por request.
- **`catalogos`** — caché en memoria de las tablas de referencia, con TTL.
- **`router`** — router mínimo sobre `method` + `path` (o Hono, a definir).
- **`errores`** — mapeo de errores de SQL Server a respuestas HTTP. Importante: cuando un trigger
  rechaza una operación, el mensaje del trigger *es* el mensaje de negocio y hay que propagarlo con
  un 4xx legible, no convertirlo en 500.
- **`validacion`** — validación de entrada (zod o similar) en el borde.

---

## 5. Configuración por función

Valores iniciales a ajustar con datos reales de producción:

| Función | Memoria | Timeout | Concurrencia reservada |
|---|---|---|---|
| `voae-catalogo` | 512 MB | 10 s | media-alta (la piden todas las pantallas) |
| `voae-giras` | 512 MB | 15 s | media |
| `voae-procad` | 512 MB | 15 s | media |
| `voae-voluntariado` | 512 MB | 15 s | media |
| `voae-reporteria` | 1–2 GB | 60 s | **baja y acotada** |

El total de concurrencia reservada debe fijarse **después** de medir cuántas consultas concurrentes
aguanta 1 vCore sin degradarse. Poner números antes de esa medición es adivinar. `voae-catalogo` se
desplegó **sin** concurrencia reservada por esa razón, no por olvido.

**Medido el 2026-09-17:** `voae-catalogo` usa 124 MB de los 512 asignados, así que 256 MB le sobran.
Los 512 se dejan hasta tener tráfico real, porque en Lambda la memoria también compra CPU y bajarla
alargaría el arranque en frío, que es justo lo que conviene proteger con la base en Azure.

---

## 6. Lo que NO va en las Lambdas

La base de datos tiene **53 triggers** y 2 stored procedures que ya codifican reglas de negocio. Los
handlers validan la entrada, llaman al SP o al query parametrizado, y mapean el resultado. **Si una
regla se reimplementa en TypeScript, se va a desincronizar del trigger — y el trigger gana
siempre.**

Casos concretos que ya se sabe que NO se codifican en la Lambda:

- Transiciones de estado de solicitudes, giras e inscripciones.
- `tgrGirasCancelacionValidar` — valida la cancelación y arrastra las inscripciones vivas.
- `tgrInscripcionesExcepcionValidar` — exige persona y motivo en inscripciones excepcionales.
- El total de `tblSolicitudes.costos`, mantenido por trigger desde `tblCostosDetalle`.
- `Procad.spGenerarActividadesSerie` — generación de actividades recurrentes.
- `Procad.spActivarNuevoPeriodo` — activación de período.

Antes de escribir lógica de negocio en un handler, revisar si ya existe un trigger que la haga.

---

## 7. Frontend, S3 y ruteo

- El frontend React compilado va a un bucket S3.
- **Una sola distribución de CloudFront** delante de todo: `/` → S3, `/v1/*` → API Gateway. Así el
  frontend y la API quedan *same-origin* y CORS nunca entra en la ecuación (ni preflights).
- Los archivos subidos por usuarios (documentos de giras, evidencia fotográfica, adjuntos, logos de
  grupos) van a un bucket **separado y privado**, con subida por URL prefirmada. La base de datos
  guarda la llave del objeto, nunca el binario.
- **Las rutas de la API son independientes del número de Lambdas.** El mapeo ruta → función es
  configuración de API Gateway; se puede cambiar después sin tocar una línea del frontend. Esta
  decisión es reversible.

### Decisión pendiente: PDFs en cliente o en servidor

El frontend ya genera PDF y Excel en el navegador (`jspdf`, `jspdf-autotable`, `html-to-image`,
`src/utils/exportarPdf.ts`, `exportarExcel.ts`, `exportarGraficasPdf.ts`), y para PROCAD la
exportación se construye desde las mismas funciones que dibujan la pantalla precisamente para que no
puedan contradecirse. Moverlo al servidor rompería esa propiedad y duplicaría la lógica de layout.

**Recomendación: dejar la generación en el cliente por ahora** y que `voae-reporteria` sirva solo
los datos agregados. Reconsiderar únicamente si aparece un requisito de reportes programados o por
correo, que sí exigen servidor.

---

## 8. Hueco de esquema detectado

**Galería de PROCAD.** No existe ninguna tabla de álbumes ni fotos en el esquema `Procad`. Esto se
verificó contra el script y contra la base de datos en Azure. El frontend tiene el módulo completo
(`procad/Galeria.tsx`, los tipos `AlbumGaleria` / `AlbumDeActividad` / `AlbumSuelto` / `FotoGaleria`,
y `mockProcadGaleria.ts`), con un modelo no trivial: un álbum puede venir de una actividad —y
entonces no guarda título ni fecha propios, los toma de la actividad— o existir por su cuenta, y ahí
sí lleva sus datos. **Requiere diseño de esquema antes de poder implementar sus endpoints.**
Compárese con Voluntariado, que sí tiene `tblFotosActividades`.

No bloquea arrancar con las 5 funciones, pero conviene decidir en equipo quién diseña ese esquema.
