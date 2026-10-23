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
  DB_TRUST_SERVER_CERTIFICATE?: string | boolean;
  DB_REQUEST_TIMEOUT_MS?: string | number;
}

const ID_SECRETO = process.env.ID_SECRETO_VOAE ?? "secreto-voae";

const cliente = new SecretsManagerClient({});

/** Sobrevive entre invocaciones mientras el contenedor siga caliente. */
let secretoCacheado: SecretoBaseDatos | null = null;
/** Si dos invocaciones concurrentes lo piden, comparten la misma llamada. */
let lecturaEnCurso: Promise<SecretoBaseDatos> | null = null;

/**
 * Solo para infra/servidor-local.mjs: con VOAE_DB_SERVER (y sus hermanas) en
 * .env.local, la conexion sale de ahi y no de Secrets Manager. Sirve para
 * probar contra una base que la Lambda todavia no alcanza, sin tocar el
 * secreto que usan las funciones desplegadas. En AWS no se define.
 */
function secretoLocal(): SecretoBaseDatos | null {
  const env = process.env;
  if (!env["VOAE_DB_SERVER"]) return null;
  return {
    DB_SERVER: env["VOAE_DB_SERVER"],
    DB_NAME: env["VOAE_DB_NAME"] ?? "",
    DB_USER: env["VOAE_DB_USER"] ?? "",
    DB_PASSWORD: env["VOAE_DB_PASSWORD"] ?? "",
    DB_PORT: env["VOAE_DB_PORT"],
    DB_TRUST_SERVER_CERTIFICATE: env["VOAE_DB_TRUST_SERVER_CERTIFICATE"],
    DB_REQUEST_TIMEOUT_MS: env["VOAE_DB_REQUEST_TIMEOUT_MS"],
  };
}

async function leerSecreto(): Promise<SecretoBaseDatos> {
  const local = secretoLocal();
  if (local) {
    for (const clave of ["DB_NAME", "DB_USER", "DB_PASSWORD"] as const) {
      if (!local[clave]) throw new Error(`Falta VOAE_${clave} en .env.local.`);
    }
    return local;
  }

  const respuesta = await cliente.send(
    new GetSecretValueCommand({ SecretId: ID_SECRETO }),
  );

  if (!respuesta.SecretString) {
    throw new Error(`El secreto ${ID_SECRETO} no tiene contenido de texto.`);
  }

  const secreto = JSON.parse(respuesta.SecretString) as SecretoBaseDatos & {
    DB_CONFIAR_CERTIFICADO?: string | boolean;
  };
  // secreto-voae-local (lo creo la DEGT) nombra asi la opcion del certificado.
  secreto.DB_TRUST_SERVER_CERTIFICATE ??= secreto.DB_CONFIAR_CERTIFICADO;

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
