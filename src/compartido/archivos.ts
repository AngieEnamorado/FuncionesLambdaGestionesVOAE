/**
 * Archivos de usuario en S3: firma de subidas y de descargas.
 *
 * El binario nunca pasa por la Lambda ni por la base. El navegador pide una
 * subida firmada, manda el archivo directo al bucket y despues registra la
 * llave del objeto en el endpoint de su dominio. Para mostrarlo se pide una
 * URL de descarga firmada, de vida corta.
 *
 * El bucket es privado: sin firma no se lee nada. La firma es un calculo
 * local con las credenciales de la funcion, no una llamada a S3.
 */
import { randomUUID } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ErrorHttp, solicitudInvalida } from "./errores";

const bucket = () => process.env.BUCKET_ARCHIVOS ?? "";

const cliente = new S3Client({});

/** Lo que se acepta subir. Cualquier otro tipo se rechaza antes de firmar. */
export const TIPOS_PERMITIDOS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** 10 MB. S3 rechaza la subida si el archivo pasa de aqui, no la Lambda. */
export const TAMANIO_MAXIMO = 10 * 1024 * 1024;

const VIDA_SUBIDA_S = 5 * 60;
const VIDA_DESCARGA_S = 15 * 60;

/** Llaves sembradas antes de que existiera S3: se aceptan, pero no tienen objeto detras. */
export const PREFIJO_PROTOTIPO = "prototipo/";

export function bucketConfigurado(): boolean {
  return bucket() !== "";
}

export function exigirBucket() {
  if (!bucketConfigurado()) {
    throw new ErrorHttp(501, "La subida de archivos no esta configurada en esta funcion (falta BUCKET_ARCHIVOS).");
  }
}

/** Nombre apto para una llave: sin rutas, sin acentos, sin espacios raros. */
function nombreSeguro(nombre: string): string {
  const base = nombre.split(/[\\/]/).pop() ?? "archivo";
  const limpio = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-80);
  return limpio || "archivo";
}

export interface SubidaFirmada {
  llave: string;
  url: string;
  campos: Record<string, string>;
  tamanioMaximo: number;
  expiraEnSegundos: number;
}

/**
 * Firma una subida por POST de formulario. Se usa POST y no PUT porque la
 * politica del POST deja fijar el tipo y el tamanio maximo: con un PUT
 * firmado S3 aceptaria un archivo de cualquier tamanio.
 */
export async function firmarSubida(prefijo: string, nombreArchivo: string, tipoContenido: string): Promise<SubidaFirmada> {
  exigirBucket();
  if (!(tipoContenido in TIPOS_PERMITIDOS)) {
    throw solicitudInvalida(`Tipo de archivo no permitido. Se aceptan: ${Object.keys(TIPOS_PERMITIDOS).join(", ")}.`);
  }

  const llave = `${prefijo}${randomUUID().slice(0, 8)}-${nombreSeguro(nombreArchivo)}`;
  const { url, fields } = await createPresignedPost(cliente, {
    Bucket: bucket(),
    Key: llave,
    Conditions: [
      ["content-length-range", 1, TAMANIO_MAXIMO],
      ["eq", "$Content-Type", tipoContenido],
    ],
    Fields: { "Content-Type": tipoContenido },
    Expires: VIDA_SUBIDA_S,
  });

  return { llave, url, campos: fields, tamanioMaximo: TAMANIO_MAXIMO, expiraEnSegundos: VIDA_SUBIDA_S };
}

/** URL de descarga de vida corta, o null si la llave es de prototipo o no hay bucket. */
export async function urlDeDescarga(llave: string | null | undefined): Promise<string | null> {
  if (!llave || !bucketConfigurado() || llave.startsWith(PREFIJO_PROTOTIPO)) return null;
  return getSignedUrl(cliente, new GetObjectCommand({ Bucket: bucket(), Key: llave }), {
    expiresIn: VIDA_DESCARGA_S,
  });
}

/**
 * Una llave que se va a guardar en la base debe colgar del registro al que
 * pertenece. Sin esto, cualquiera podria registrar como evidencia de su
 * actividad un archivo subido para otra.
 */
export function exigirLlaveDe(llave: string, prefijoEsperado: string): void {
  if (llave.startsWith(PREFIJO_PROTOTIPO)) return;
  if (!llave.startsWith(prefijoEsperado) || llave.includes("..")) {
    throw solicitudInvalida(`La llave del archivo no corresponde a este registro (se esperaba ${prefijoEsperado}...).`);
  }
}
