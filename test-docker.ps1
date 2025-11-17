# Script PowerShell de test local du Docker avant déploiement Render

Write-Host "🐳 Construction de l'image Docker..." -ForegroundColor Cyan
docker build -f Dockerfile.node -t center-backend:test .

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Erreur lors de la construction de l'image" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Image construite avec succès" -ForegroundColor Green
Write-Host ""
Write-Host "🚀 Démarrage du conteneur de test..." -ForegroundColor Cyan

# Arrêter et supprimer le conteneur s'il existe
docker stop center-backend-test 2>$null
docker rm center-backend-test 2>$null

# Lire les variables d'environnement depuis .env ou utiliser des valeurs par défaut
$envFile = ".\.env"
$mongoUri = "mongodb://localhost:27017/centerDB"
$jwtSecret = "test-jwt-secret-key"
$adminSecret = "test-admin-secret-key"

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^MONGODB_URI=(.+)$') { $mongoUri = $matches[1] }
        if ($_ -match '^JWT_SECRET=(.+)$') { $jwtSecret = $matches[1] }
        if ($_ -match '^ADMIN_SECRET_KEY=(.+)$') { $adminSecret = $matches[1] }
    }
}

# Démarrer le conteneur
docker run -d `
    --name center-backend-test `
    -p 5000:5000 `
    -e NODE_ENV=production `
    -e PORT=5000 `
    -e MONGODB_URI="$mongoUri" `
    -e JWT_SECRET="$jwtSecret" `
    -e ADMIN_SECRET_KEY="$adminSecret" `
    center-backend:test

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Erreur lors du démarrage du conteneur" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Conteneur démarré avec succès" -ForegroundColor Green
Write-Host ""
Write-Host "⏳ Attente du démarrage du serveur (10 secondes)..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

Write-Host "🔍 Test de santé du serveur..." -ForegroundColor Cyan
try {
    $response = Invoke-WebRequest -Uri "http://localhost:5000/api/server-info" -UseBasicParsing -TimeoutSec 5
    $statusCode = $response.StatusCode
    
    if ($statusCode -eq 200) {
        Write-Host "✅ Serveur opérationnel ! (HTTP $statusCode)" -ForegroundColor Green
        Write-Host ""
        Write-Host "📊 Logs du conteneur :" -ForegroundColor Cyan
        docker logs center-backend-test
        Write-Host ""
        Write-Host "🌐 Test manuel disponible sur : http://localhost:5000" -ForegroundColor Green
        Write-Host ""
        Write-Host "🛑 Pour arrêter le conteneur de test :" -ForegroundColor Yellow
        Write-Host "   docker stop center-backend-test" -ForegroundColor White
        Write-Host "   docker rm center-backend-test" -ForegroundColor White
    }
    else {
        Write-Host "❌ Échec du test de santé (HTTP $statusCode)" -ForegroundColor Red
        docker logs center-backend-test
        exit 1
    }
}
catch {
    Write-Host "❌ Impossible de se connecter au serveur" -ForegroundColor Red
    Write-Host "Erreur: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "📊 Logs du conteneur :" -ForegroundColor Cyan
    docker logs center-backend-test
    exit 1
}
