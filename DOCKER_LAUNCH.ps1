# ================================================================
# DOCKER_LAUNCH.ps1
# Build + Lance le backend CENTER (Node.js + Cloudflare Tunnel)
# via Docker Compose, et met a jour server_config.dart
# ================================================================
# Usage :
#   .\DOCKER_LAUNCH.ps1          -> build + start + URL auto
#   .\DOCKER_LAUNCH.ps1 -NoBuild -> skip le build (image existante)
#   .\DOCKER_LAUNCH.ps1 -Stop    -> arreter les conteneurs
#   .\DOCKER_LAUNCH.ps1 -Logs    -> voir les logs en direct
# ================================================================

param(
    [switch]$NoBuild,
    [switch]$Stop,
    [switch]$Logs
)

$ComposeFile      = "docker-compose.backend.yml"
$BackendDir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerConfigPath = "$BackendDir\..\frontend-center\lib\config\server_config.dart"

Push-Location $BackendDir

Write-Host ""
Write-Host "=========================================" -ForegroundColor DarkCyan
Write-Host " CENTER BACKEND - DOCKER LAUNCHER" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor DarkCyan
Write-Host ""

# ── Verifier Docker ───────────────────────────────────────────────────────────
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "ERREUR: Docker n'est pas installe." -ForegroundColor Red
    Write-Host "  Telecharge Docker Desktop : https://www.docker.com/products/docker-desktop" -ForegroundColor Gray
    Pop-Location; exit 1
}
$dockerInfo = docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: Docker Desktop n'est pas demarre." -ForegroundColor Red
    Pop-Location; exit 1
}

# ── Mode ARRET ────────────────────────────────────────────────────────────────
if ($Stop) {
    Write-Host "[STOP] Arret des conteneurs..." -ForegroundColor Yellow
    docker compose -f $ComposeFile down
    Write-Host "      Arrete." -ForegroundColor DarkGray
    Pop-Location; exit 0
}

# ── Mode LOGS ─────────────────────────────────────────────────────────────────
if ($Logs) {
    docker compose -f $ComposeFile logs -f
    Pop-Location; exit 0
}

# ── 1. Build de l'image backend ───────────────────────────────────────────────
if (-not $NoBuild) {
    Write-Host "[1/4] Build de l'image Docker backend..." -ForegroundColor Cyan
    docker compose -f $ComposeFile build --no-cache backend
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERREUR: Build echoue." -ForegroundColor Red
        Pop-Location; exit 1
    }
    Write-Host "      Build OK" -ForegroundColor Green
} else {
    Write-Host "[1/4] Build ignore (-NoBuild)" -ForegroundColor DarkGray
}

# ── 2. Arret propre des anciens conteneurs ────────────────────────────────────
Write-Host ""
Write-Host "[2/4] Arret des anciens conteneurs..." -ForegroundColor Yellow
docker compose -f $ComposeFile down --remove-orphans 2>&1 | Out-Null
Write-Host "      OK" -ForegroundColor DarkGray

# ── 3. Demarrage ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[3/4] Demarrage backend + tunnel Cloudflare..." -ForegroundColor Cyan
docker compose -f $ComposeFile up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: Demarrage echoue." -ForegroundColor Red
    Pop-Location; exit 1
}
Write-Host "      Conteneurs lances" -ForegroundColor Green

# ── 4. Attente URL tunnel (max 90s) ───────────────────────────────────────────
Write-Host ""
Write-Host "[4/4] Attente URL tunnel Cloudflare (max 90s)..." -ForegroundColor Cyan

$timeout = 90
$elapsed = 0
$tunnelUrl = $null

while ($elapsed -lt $timeout) {
    Start-Sleep -Seconds 3
    $elapsed += 3

    $logs = docker logs center-tunnel 2>&1 | Out-String
    $match = [regex]::Match($logs, 'https://[a-z0-9\-]+\.trycloudflare\.com')
    if ($match.Success) {
        $tunnelUrl = $match.Value
        break
    }
    Write-Host "      ${elapsed}s - en attente..." -ForegroundColor DarkGray
}

if (-not $tunnelUrl) {
    Write-Host ""
    Write-Host "AVERTISSEMENT: URL tunnel non trouvee apres ${timeout}s" -ForegroundColor Yellow
    Write-Host "  Consultez les logs : .\DOCKER_LAUNCH.ps1 -Logs" -ForegroundColor Gray
    Write-Host "  Ou : docker logs center-tunnel" -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "      Tunnel actif : $tunnelUrl" -ForegroundColor Green

    # Mettre a jour server_config.dart
    if (Test-Path $ServerConfigPath) {
        $content    = Get-Content $ServerConfigPath -Raw -Encoding UTF8
        $newContent = $content -replace "(?<=productionUrl\s*=\s*`n?\s*')[^']+", $tunnelUrl
        Set-Content $ServerConfigPath -Value $newContent -Encoding UTF8 -NoNewline
        Write-Host "      server_config.dart mis a jour" -ForegroundColor Green
    } else {
        Write-Host "      AVERTISSEMENT: server_config.dart introuvable" -ForegroundColor Yellow
        Write-Host "        Chemin attendu : $ServerConfigPath" -ForegroundColor Gray
    }
}

# ── Recapitulatif ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=========================================" -ForegroundColor DarkCyan

$localIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -match '^192\.168\.|^10\.' } |
    Select-Object -First 1).IPAddress

$health = docker inspect --format='{{.State.Health.Status}}' center-backend 2>$null
Write-Host "  Backend : http://localhost:5000  (sante: $health)" -ForegroundColor White
if ($localIP) {
    Write-Host "  LAN     : http://${localIP}:5000" -ForegroundColor White
}
if ($tunnelUrl) {
    Write-Host "  Public  : $tunnelUrl" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Flutter : server_config.dart = isProduction:true" -ForegroundColor Cyan
    Write-Host "            URL -> $tunnelUrl" -ForegroundColor Cyan
} else {
    Write-Host "  Public  : (tunnel non disponible)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Commandes utiles :" -ForegroundColor Gray
Write-Host "    .\DOCKER_LAUNCH.ps1 -Logs    -> logs en direct" -ForegroundColor Gray
Write-Host "    .\DOCKER_LAUNCH.ps1 -NoBuild -> relancer sans rebuild" -ForegroundColor Gray
Write-Host "    .\DOCKER_LAUNCH.ps1 -Stop    -> arreter" -ForegroundColor Gray
Write-Host "=========================================" -ForegroundColor DarkCyan
Write-Host ""

Pop-Location
