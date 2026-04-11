#!/bin/bash
# deploy.sh — Builds the Somnia bot image and deploys it to the telegram-bots k3d cluster.
#
# Prerequisites:
#   - The k3d cluster 'telegram-bots' and base infra (LocalStack + ESO) must be running.
#     If this is the first time, bring them up from the k8s-home-cluster repo:
#       cd ../k8s-home-cluster && ./bootstrap.sh
#
#   - The bot secret must exist in LocalStack:
#       kubectl port-forward -n localstack svc/localstack 4566:4566 &
#       aws --endpoint-url=http://localhost:4566 secretsmanager create-secret \
#           --name somnia-bot/tokens \
#           --secret-string '{"TELEGRAM_BOT_TOKEN":"YOUR_TOKEN","HF_API_TOKEN":"hf_xxx"}'

set -e

CLUSTER_NAME="telegram-bots"
NAMESPACE="somnia"
IMAGE_NAME="somnia-bot"
IMAGE_TAG="latest"

echo "🌙 Somnia Bot - Deploy to k3d"
echo "=============================="

# 1. Check dependencies
for cmd in k3d kubectl docker; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "❌ '$cmd' is not installed. Run: brew install $cmd"
    exit 1
  fi
done

# 2. Verify the cluster exists
if ! k3d cluster list | grep -q "$CLUSTER_NAME"; then
  echo "❌ Cluster '$CLUSTER_NAME' not found."
  echo "   Bring up the base infra first:"
  echo "   cd ../k8s-home-cluster && ./bootstrap.sh"
  exit 1
fi

# 3. Point kubectl to the cluster
echo "🔗 Configuring kubectl..."
kubectl config use-context "k3d-${CLUSTER_NAME}"

# 4. Build the Docker image
echo "🐳 Building Docker image..."
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .

# 5. Import the image into the k3d cluster
echo "📦 Importing image into cluster..."
k3d image import "${IMAGE_NAME}:${IMAGE_TAG}" -c "$CLUSTER_NAME"

# 6. Apply bot manifests
echo "☸️  Applying manifests..."
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/external-secret.yaml
kubectl apply -f k8s/deployment.yaml

# 7. Wait for the pod to be ready
echo "⏳ Waiting for the bot to start..."
kubectl rollout status deployment/somnia-bot -n "$NAMESPACE" --timeout=60s

echo ""
echo "✅ Somnia bot deployed!"
echo ""
echo "📋 Useful commands:"
echo "   kubectl logs -f deployment/somnia-bot -n $NAMESPACE"
echo "   kubectl get pods -n $NAMESPACE"
echo "   kubectl get externalsecret -n $NAMESPACE"
echo "   kubectl rollout restart deployment/somnia-bot -n $NAMESPACE"
