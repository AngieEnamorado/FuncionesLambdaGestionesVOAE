/**
 * Lectura del secreto de base de datos desde AWS Secrets Manager.
 *
 * Se cachea fuera del handler: pedirlo en cada invocacion es latencia y costo
 * regalados.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export interface SecretoBaseDatos {
  DB_SERVER: string;
  DB_NAME: string;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_PORT?: string | number;
  /**
   * Para un SQL Server propio (p. ej. el 10.8 de la UNAH) cuyo certificado no
   * firma una CA publica: el certificado publico del servidor, o el de la CA
   * que lo emitio, en PEM ("-----BEGIN CERTIFICATE-----..."). Solo se acepta
   * ese servidor; la conexion nunca deja de validar. Azure SQL no lo lleva.
   */
  DB_CERTIFICADO?: string;
  /** Nombre que trae ese certificado (CN o SAN) cuando DB_SERVER es una IP. */
  DB_NOMBRE_CERTIFICADO?: string;
  /**
   * "true": cifrar pero aceptar el certificado del servidor sin validarlo,
   * como "Confiar en el certificado de servidor" de SSMS. Solo para pruebas:
   * db.ts lo ignora salvo que corra el servidor local (VOAE_ENTORNO=local).
   */
  DB_CONFIAR_CERTIFICADO?: string;
}

const ID_SECRETO = process.env.ID_SECRETO_VOAE ?? "secreto-voae";

const cliente = new SecretsManagerClient({});

/** Sobrevive entre invocaciones mientras el contenedor siga caliente. */
let secretoCacheado: SecretoBaseDatos | null = null;
/** Si dos invocaciones concurrentes lo piden, comparten la misma llamada. */
let lecturaEnCurso: Promise<SecretoBaseDatos> | null = null;

async function leerSecreto(): Promise<SecretoBaseDatos> {
  const respuesta = await cliente.send(
    new GetSecretValueCommand({ SecretId: ID_SECRETO }),
  );

  if (!respuesta.SecretString) {
    throw new Error(`El secreto ${ID_SECRETO} no tiene contenido de texto.`);
  }

  const secreto = JSON.parse(respuesta.SecretString) as SecretoBaseDatos;

  for (const clave of ["DB_SERVER", "DB_NAME", "DB_USER", "DB_PASSWORD"] as const) {
    if (!secreto[clave]) {
      throw new Error(`Al secreto ${ID_SECRETO} le falta la clave ${clave}.`);
    }
  }

  return secreto;
}

export async function obtenerSecreto(): Promise<SecretoBaseDatos> {
  if (secretoCacheado) return secretoCacheado;

  if (!lecturaEnCurso) {
    lecturaEnCurso = leerSecreto()
      .then((secreto) => {
        secretoCacheado = secreto;
        return secreto;
      })
      .finally(() => {
        lecturaEnCurso = null;
      });
  }

  return lecturaEnCurso;
}
