#!/bin/bash
# deploy.sh — Construye la imagen de Somnia bot y la despliega en el cluster telegram-bots.
#
# Requisitos previos:
#   - El cluster k3d 'telegram-bots' y la infra base (LocalStack + ESO) deben estar
#     corriendo. Si es la primera vez, levántalos desde el repo k8s-home-cluster:
#       cd ../k8s-home-cluster && ./bootstrap.sh
#
#   - El secret del bot debe existir en LocalStack:
#       kubectl port-forward -n localstack svc/localstack 4566:4566 &
#       aws --endpoint-url=http://localhost:4566 secretsmanager create-secret \
#           --name somnia-bot/tokens \
#           --secret-string '{"TELEGRAM_BOT_TOKEN":"TU_TOKEN","HF_API_TOKEN":"hf_xxx"}'

set -e

CLUSTER_NAME="telegram-bots"
NAMESPACE="somnia"
IMAGE_NAME="somnia-bot"
IMAGE_TAG="latest"

echo "🌙 Somnia Bot - Deploy to k3d"
echo "=============================="

# 1. Verificar dependencias
for cmd in k3d kubectl docker; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "❌ '$cmd' no está instalado. Ejecuta: brew install $cmd"
    exit 1
  fi
done

# 2. Verificar que el cluster existe
if ! k3d cluster list | grep -q "$CLUSTER_NAME"; then
  echo "❌ Cluster '$CLUSTER_NAME' no encontrado."
  echo "   Levanta la infra base primero:"
  echo "   cd ../k8s-home-cluster && ./bootstrap.sh"
  exit 1
fi

# 3. Apuntar kubectl al cluster
echo "🔗 Configurando kubectl..."
kubectl config use-context "k3d-${CLUSTER_NAME}"

# 4. Construir imagen Docker
echo "🐳 Construyendo imagen Docker..."
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .

# 5. Importar imagen al cluster k3d
echo "📦 Importando imagen al cluster..."
k3d image import "${IMAGE_NAME}:${IMAGE_TAG}" -c "$CLUSTER_NAME"

# 6. Aplicar manifiestos del bot
echo "☸️  Aplicando manifiestos..."
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/external-secret.yaml
kubectl apply -f k8s/deployment.yaml

# 7. Esperar a que el pod esté listo
echo "⏳ Esperando a que el bot arranque..."
kubectl rollout status deployment/somnia-bot -n "$NAMESPACE" --timeout=60s

echo ""
echo "✅ ¡Somnia bot desplegado!"
echo ""
echo "📋 Comandos útiles:"
echo "   kubectl logs -f deployment/somnia-bot -n $NAMESPACE"
echo "   kubectl get pods -n $NAMESPACE"
echo "   kubectl get externalsecret -n $NAMESPACE"
echo "   kubectl rollout restart deployment/somnia-bot -n $NAMESPACE"
