/**
 * S3 simulado para las pruebas de voae-voluntariado.
 *
 * Todo lo de src/compartido/archivos se usa tal cual (validacion de llaves,
 * tipos permitidos...) salvo la firma de descargas, que en la Lambda necesita
 * credenciales de AWS. Aqui devuelve una URL falsa predecible.
 */
export * from "../../../src/compartido/archivos";

export async function urlDeDescarga(llave: string | null | undefined): Promise<string | null> {
  if (!llave || llave.startsWith("prototipo/")) return null;
  return `https://s3.simulado/${llave}?firmada`;
}
