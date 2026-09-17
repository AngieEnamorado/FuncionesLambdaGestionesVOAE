#!/usr/bin/env bash
#
# Despliega una funcion de VOAE en AWS. Idempotente: crea lo que falte y
# actualiza lo que exista, asi que se puede correr las veces que haga falta.
#
# Uso: bash infra/desplegar.sh [nombre-funcion]     (por defecto: catalogo)
#
# Crea/actualiza, en este orden:
#   1. el rol de ejecucion (logs + lectura del secreto, nada mas)
#   2. la funcion Lambda
#   3. la HTTP API, su integracion y la ruta greedy ANY /v1/<dominio>/{proxy+}
#
# No fija concurrencia reservada a proposito: ese numero se pone despues de
# medir cuantas consultas concurrentes aguanta 1 vCore sin degradarse.

set -euo pipefail

PERFIL="${PERFIL_AWS:-valerio}"
REGION="${REGION_AWS:-us-east-1}"
DOMINIO="${1:-catalogo}"
FUNCION="voae-${DOMINIO}"
ROL="voae-lambda-ejecucion"
SECRETO="secreto-voae"
NOMBRE_API="voae-api"
RUNTIME="nodejs22.x"
MEMORIA_MB=512
TIMEOUT_S=10

aws_() { aws "$@" --profile "$PERFIL" --region "$REGION"; }

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zip="${raiz}/dist/${FUNCION}.zip"

echo "==> Construyendo ${FUNCION}"
(cd "$raiz" && npm run build -- "$DOMINIO")
[[ -f "$zip" ]] || { echo "No se genero $zip"; exit 1; }

cuenta="$(aws_ sts get-caller-identity --query Account --output text)"
arn_secreto="$(aws_ secretsmanager describe-secret --secret-id "$SECRETO" --query ARN --output text)"

# ----------------------------------------------------------------- rol -----
echo "==> Rol de ejecucion ${ROL}"
if ! aws_ iam get-role --role-name "$ROL" >/dev/null 2>&1; then
  aws_ iam create-role \
    --role-name "$ROL" \
    --description "Ejecucion de las funciones Lambda de gestiones VOAE" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": { "Service": "lambda.amazonaws.com" },
        "Action": "sts:AssumeRole"
      }]
    }' >/dev/null
  echo "    creado"
else
  echo "    ya existia"
fi

aws_ iam attach-role-policy \
  --role-name "$ROL" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Solo este secreto: el rol no puede leer ningun otro de la cuenta.
aws_ iam put-role-policy \
  --role-name "$ROL" \
  --policy-name "leer-${SECRETO}" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"secretsmanager:GetSecretValue\",
      \"Resource\": \"${arn_secreto}\"
    }]
  }"

arn_rol="arn:aws:iam::${cuenta}:role/${ROL}"

# -------------------------------------------------------------- funcion ----
echo "==> Funcion ${FUNCION}"
if aws_ lambda get-function --function-name "$FUNCION" >/dev/null 2>&1; then
  aws_ lambda update-function-code \
    --function-name "$FUNCION" \
    --zip-file "fileb://${zip}" \
    --query 'LastModified' --output text
  aws_ lambda wait function-updated --function-name "$FUNCION"
  aws_ lambda update-function-configuration \
    --function-name "$FUNCION" \
    --runtime "$RUNTIME" \
    --memory-size "$MEMORIA_MB" \
    --timeout "$TIMEOUT_S" \
    --environment "Variables={ID_SECRETO_VOAE=${SECRETO}}" \
    --query 'LastModified' --output text
  aws_ lambda wait function-updated --function-name "$FUNCION"
else
  # El rol recien creado tarda unos segundos en propagarse en IAM.
  for intento in 1 2 3 4 5 6; do
    if aws_ lambda create-function \
      --function-name "$FUNCION" \
      --runtime "$RUNTIME" \
      --role "$arn_rol" \
      --handler index.handler \
      --zip-file "fileb://${zip}" \
      --memory-size "$MEMORIA_MB" \
      --timeout "$TIMEOUT_S" \
      --environment "Variables={ID_SECRETO_VOAE=${SECRETO}}" \
      --description "Datos de referencia e identidad (esquema Catalogo)" \
      --query 'FunctionArn' --output text 2>/dev/null; then
      break
    fi
    echo "    esperando propagacion del rol (intento ${intento})"
    sleep 5
  done
  aws_ lambda wait function-active --function-name "$FUNCION"
fi

arn_funcion="$(aws_ lambda get-function --function-name "$FUNCION" --query 'Configuration.FunctionArn' --output text)"

# ------------------------------------------------------------------ api ----
echo "==> HTTP API ${NOMBRE_API}"
id_api="$(aws_ apigatewayv2 get-apis --query "Items[?Name=='${NOMBRE_API}'].ApiId | [0]" --output text)"

if [[ "$id_api" == "None" || -z "$id_api" ]]; then
  # CORS abierto mientras el frontend corre en el dev server de Vite. En
  # produccion frontend y API van detras de una sola distribucion de
  # CloudFront, son same-origin, y esto se quita.
  id_api="$(aws_ apigatewayv2 create-api \
    --name "$NOMBRE_API" \
    --protocol-type HTTP \
    --description "API de gestiones VOAE" \
    --cors-configuration 'AllowOrigins=*,AllowMethods=GET,POST,PUT,DELETE,OPTIONS,AllowHeaders=Content-Type,X-Voae-Usuario' \
    --query ApiId --output text)"
  echo "    creada: ${id_api}"
else
  echo "    ya existia: ${id_api}"
fi

id_integracion="$(aws_ apigatewayv2 get-integrations --api-id "$id_api" \
  --query "Items[?IntegrationUri=='${arn_funcion}'].IntegrationId | [0]" --output text)"

if [[ "$id_integracion" == "None" || -z "$id_integracion" ]]; then
  id_integracion="$(aws_ apigatewayv2 create-integration \
    --api-id "$id_api" \
    --integration-type AWS_PROXY \
    --integration-uri "$arn_funcion" \
    --payload-format-version 2.0 \
    --query IntegrationId --output text)"
fi

# Una sola ruta greedy por dominio: agregar un endpoint es editar el router
# interno, no tocar API Gateway.
clave_ruta="ANY /v1/${DOMINIO}/{proxy+}"
id_ruta="$(aws_ apigatewayv2 get-routes --api-id "$id_api" \
  --query "Items[?RouteKey=='${clave_ruta}'].RouteId | [0]" --output text)"

if [[ "$id_ruta" == "None" || -z "$id_ruta" ]]; then
  aws_ apigatewayv2 create-route \
    --api-id "$id_api" \
    --route-key "$clave_ruta" \
    --target "integrations/${id_integracion}" >/dev/null
else
  aws_ apigatewayv2 update-route \
    --api-id "$id_api" \
    --route-id "$id_ruta" \
    --target "integrations/${id_integracion}" >/dev/null
fi

if ! aws_ apigatewayv2 get-stage --api-id "$id_api" --stage-name '$default' >/dev/null 2>&1; then
  aws_ apigatewayv2 create-stage \
    --api-id "$id_api" --stage-name '$default' --auto-deploy >/dev/null
fi

# Permiso para que API Gateway invoque la funcion (idempotente a mano: si ya
# existe el statement, AWS devuelve ResourceConflictException y se ignora).
aws_ lambda add-permission \
  --function-name "$FUNCION" \
  --statement-id "apigateway-${id_api}" \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${cuenta}:${id_api}/*/*/v1/${DOMINIO}/*" \
  >/dev/null 2>&1 || true

url="$(aws_ apigatewayv2 get-api --api-id "$id_api" --query ApiEndpoint --output text)"

echo
echo "Listo."
echo "  Funcion:  ${FUNCION}  (${MEMORIA_MB} MB, ${TIMEOUT_S}s, ${RUNTIME})"
echo "  Base URL: ${url}/v1/${DOMINIO}"
echo "  Salud:    curl -s ${url}/v1/${DOMINIO}/salud"
echo
echo "Sin auth: cualquiera con la URL puede llamarla. No exponer con datos reales."
