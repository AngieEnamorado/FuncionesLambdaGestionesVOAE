#!/usr/bin/env bash
#
# Crea el bucket privado de archivos de usuario y le da acceso al rol de las
# funciones. Idempotente: se puede correr las veces que haga falta.
#
# Uso: bash infra/archivos.sh
#
# Despues hay que redesplegar cada funcion que firme archivos (hoy solo
# voluntariado) para que reciba BUCKET_ARCHIVOS:
#   bash infra/desplegar.sh voluntariado
#
# El bucket:
#   - bloquea todo acceso publico: sin URL firmada no se lee nada
#   - cifra en reposo (SSE-S3)
#   - permite POST y GET desde el navegador (CORS), que es como sube y lee
#     el frontend con las URLs firmadas
#
# El rol voae-lambda-ejecucion recibe PutObject y GetObject sobre este bucket
# y nada mas: no puede listar, borrar ni tocar otros buckets.

set -euo pipefail

PERFIL="${PERFIL_AWS:-valerio}"
REGION="${REGION_AWS:-us-east-1}"
ROL="voae-lambda-ejecucion"

aws_() { aws "$@" --profile "$PERFIL" --region "$REGION"; }

cuenta="$(aws_ sts get-caller-identity --query Account --output text)"
BUCKET="voae-archivos-${cuenta}"

echo "==> Bucket ${BUCKET}"
if aws_ s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "    ya existia"
else
  # En us-east-1 create-bucket no lleva LocationConstraint.
  aws_ s3api create-bucket --bucket "$BUCKET" >/dev/null
  echo "    creado"
fi

aws_ s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws_ s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Origen abierto mientras el frontend corre en el dev server de Vite. Con el
# frontend detras de CloudFront se cambia por su dominio.
aws_ s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["POST", "GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3000
  }]
}'

echo "==> Permiso del rol ${ROL} sobre el bucket"
aws_ iam put-role-policy \
  --role-name "$ROL" \
  --policy-name "archivos-${BUCKET}" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"s3:PutObject\", \"s3:GetObject\"],
      \"Resource\": \"arn:aws:s3:::${BUCKET}/*\"
    }]
  }"

echo
echo "Listo. Bucket: ${BUCKET}"
echo "Ahora redesplega voluntariado para que reciba BUCKET_ARCHIVOS:"
echo "  bash infra/desplegar.sh voluntariado"
