# ================================================================
# START.ps1 — Lance le backend CENTER en Docker (toujours actif)
# ================================================================
# Usage :
#   .\START.ps1            → backend local sur http://IP:5000
#   .\START.ps1 -Tunnel    → backend + URL publique via Cloudflare
# ================================================================

param(
    [switch]$Tunnel,
    [switch]$Stop,
    [switch]$Logs
)

$composeFile = "docker-compose.backend.yml"
$backendDir  = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $backendDir

# ── ARRÊT ──────────────────────────────────────────────────────
if ($Stop) {
    Write-Host "🛑 Arrêt du backend..." -ForegroundColor Red
    docker compose -f $composeFile down
    Pop-Location
    exit 0
}

# ── LOGS ───────────────────────────────────────────────────────
if ($Logs) {
    docker compose -f $composeFile logs -f backend
    Pop-Location
    exit 0
}

# ── VÉRIFIER DOCKER ────────────────────────────────────────────
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Docker n'est pas installé. Télécharge Docker Desktop : https://www.docker.com/products/docker-desktop" -ForegroundColor Red
    exit 1
}

$dockerRunning = docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Docker Desktop n'est pas démarré. Lance-le d'abord !" -ForegroundColor Red
    exit 1
}

# ── BUILD + DÉMARRAGE ──────────────────────────────────────────
Write-Host "🔨 Build de l'image backend..." -ForegroundColor Cyan
docker compose -f $composeFile build --no-cache backend

if ($Tunnel) {
    # Vérifier que CLOUDFLARE_TUNNEL_TOKEN est dans .env
    if (-not (Select-String -Path ".env" -Pattern "CLOUDFLARE_TUNNEL_TOKEN" -Quiet)) {
        Write-Host ""
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
        Write-Host " CLOUDFLARE TUNNEL — CONFIGURATION INITIALE" -ForegroundColor Yellow
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
        Write-Host " 1. Va sur https://dash.cloudflare.com" -ForegroundColor White
        Write-Host " 2. Zero Trust → Networks → Tunnels → Create tunnel" -ForegroundColor White
        Write-Host " 3. Choisis Docker → copie le TOKEN affiché" -ForegroundColor White
        Write-Host " 4. Ajoute dans .env :" -ForegroundColor White
        Write-Host "    CLOUDFLARE_TUNNEL_TOKEN=eyJhXXXXXXXXXXX..." -ForegroundColor Green
        Write-Host " 5. Configure le tunnel pour pointer sur :" -ForegroundColor White
        Write-Host "    http://backend:5000   (service interne Docker)" -ForegroundColor Green
        Write-Host " 6. Tu auras une URL fixe gratuite type :" -ForegroundColor White
        Write-Host "    https://center-backend.ton-domaine.workers.dev" -ForegroundColor Green
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
        Write-Host ""
        $token = Read-Host "Entre ton CLOUDFLARE_TUNNEL_TOKEN (ou ENTRÉE pour ignorer)"
        if ($token) {
            Add-Content -Path ".env" -Value "`nCLOUDFLARE_TUNNEL_TOKEN=$token"
            Write-Host "✅ Token enregistré dans .env" -ForegroundColor Green
        } else {
            Write-Host "⚠️  Passage en mode local uniquement (sans URL publique)" -ForegroundColor Yellow
            $Tunnel = $false
        }
    }

    if ($Tunnel) {
        Write-Host "🚀 Démarrage backend + Cloudflare Tunnel..." -ForegroundColor Cyan
        docker compose -f $composeFile --profile tunnel up -d
    }
} else {
    Write-Host "🚀 Démarrage backend local..." -ForegroundColor Cyan
    docker compose -f $composeFile up -d backend
}

# ── VÉRIFICATION ───────────────────────────────────────────────
Write-Host ""
Write-Host "⏳ Attente démarrage (15s)..." -ForegroundColor Gray
Start-Sleep 15

$health = docker inspect --format='{{.State.Health.Status}}' center-backend 2>&1
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host " BACKEND CENTER" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan

# Obtenir l'IP locale
$localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^192\.168\.|^10\.' } | Select-Object -First 1).IPAddress
Write-Host " 📍 Local LAN  : http://${localIP}:5000" -ForegroundColor Green
Write-Host " 📍 Machine    : http://localhost:5000" -ForegroundColor Green

if ($Tunnel) {
    Write-Host " 🌐 Public URL : visible dans https://dash.cloudflare.com" -ForegroundColor Yellow
}

Write-Host " 🏥 État       : $health" -ForegroundColor $(if ($health -eq 'healthy') { 'Green' } else { 'Yellow' })
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""
Write-Host " Commandes utiles :" -ForegroundColor Gray
Write-Host "   .\START.ps1 -Logs   → voir les logs en direct" -ForegroundColor Gray
Write-Host "   .\START.ps1 -Stop   → arrêter le backend" -ForegroundColor Gray
Write-Host ""

Pop-Location
