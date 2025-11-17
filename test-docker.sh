#!/bin/bash

# Script de test local du Docker avant déploiement Render

echo "🐳 Construction de l'image Docker..."
docker build -f Dockerfile.node -t center-backend:test .

if [ $? -ne 0 ]; then
    echo "❌ Erreur lors de la construction de l'image"
    exit 1
fi

echo "✅ Image construite avec succès"
echo ""
echo "🚀 Démarrage du conteneur de test..."

# Arrêter et supprimer le conteneur s'il existe
docker stop center-backend-test 2>/dev/null
docker rm center-backend-test 2>/dev/null

# Démarrer le conteneur
docker run -d \
    --name center-backend-test \
    -p 5000:5000 \
    -e NODE_ENV=production \
    -e PORT=5000 \
    -e MONGODB_URI="${MONGODB_URI}" \
    -e JWT_SECRET="${JWT_SECRET}" \
    -e ADMIN_SECRET_KEY="${ADMIN_SECRET_KEY}" \
    center-backend:test

if [ $? -ne 0 ]; then
    echo "❌ Erreur lors du démarrage du conteneur"
    exit 1
fi

echo "✅ Conteneur démarré avec succès"
echo ""
echo "⏳ Attente du démarrage du serveur (10 secondes)..."
sleep 10

echo "🔍 Test de santé du serveur..."
response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5000/api/server-info)

if [ "$response" -eq 200 ]; then
    echo "✅ Serveur opérationnel ! (HTTP $response)"
    echo ""
    echo "📊 Logs du conteneur :"
    docker logs center-backend-test
    echo ""
    echo "🌐 Test manuel disponible sur : http://localhost:5000"
    echo ""
    echo "🛑 Pour arrêter le conteneur de test :"
    echo "   docker stop center-backend-test"
    echo "   docker rm center-backend-test"
else
    echo "❌ Échec du test de santé (HTTP $response)"
    echo ""
    echo "📊 Logs du conteneur :"
    docker logs center-backend-test
    exit 1
fi
