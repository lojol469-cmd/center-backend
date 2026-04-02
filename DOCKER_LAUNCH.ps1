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
    Write-Host "[1/4] Build des images Docker..." -ForegroundColor Cyan
    docker compose -f $ComposeFile build --no-cache backend moderation-api chat-api food-recommend-api
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
Write-Host "[3/4] Demarrage backend + tunnels (Cloudflare + ngrok)..." -ForegroundColor Cyan
docker compose -f $ComposeFile up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: Demarrage echoue." -ForegroundColor Red
    Pop-Location; exit 1
}
Write-Host "      Conteneurs lances" -ForegroundColor Green

# ── 4. Attente URLs tunnels (max 90s) ─────────────────────────────────────────
Write-Host ""
Write-Host "[4/4] Attente URLs tunnels (max 90s)..." -ForegroundColor Cyan

$timeout = 90
$elapsed = 0
$cloudflareUrl = $null
$ngrokUrl      = "https://macabrely-subsatirical-ayana.ngrok-free.dev"

while ($elapsed -lt $timeout) {
    Start-Sleep -Seconds 3
    $elapsed += 3

    # Cherche URL cloudflare
    if (-not $cloudflareUrl) {
        $logs = docker logs center-tunnel-cf 2>&1 | Out-String
        $match = [regex]::Match($logs, 'https://[a-z0-9\-]+\.trycloudflare\.com')
        if ($match.Success) { $cloudflareUrl = $match.Value }
    }

    if ($cloudflareUrl) { break }
    Write-Host "      ${elapsed}s - en attente..." -ForegroundColor DarkGray
}

# ── Mettre a jour tunnel-url.json et pousser sur GitHub ───────────────────────
$tunnelJsonPath = "$BackendDir\tunnel-url.json"
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$cfUrl = if ($cloudflareUrl) { $cloudflareUrl } else { "" }

$json = "{`n  `"ngrok`": `"$ngrokUrl`",`n  `"cloudflare`": `"$cfUrl`",`n  `"updated_at`": `"$now`"`n}`n"
Set-Content $tunnelJsonPath -Value $json -Encoding UTF8 -NoNewline

Write-Host "      tunnel-url.json mis a jour" -ForegroundColor Green

# Push vers GitHub (urls accessibles publiquement via raw.githubusercontent.com)
try {
    Push-Location $BackendDir
    git add tunnel-url.json 2>&1 | Out-Null
    git commit -m "chore: update tunnel urls [$now]" 2>&1 | Out-Null
    git push origin main 2>&1 | Out-Null
    Write-Host "      tunnel-url.json pousse sur GitHub" -ForegroundColor Green
} catch {
    Write-Host "      AVERTISSEMENT: push GitHub echoue (URL toujours dans le fichier local)" -ForegroundColor Yellow
}
Pop-Location

# ── Mettre a jour server_config.dart avec l'URL active ────────────────────────
$tunnelUrl = if ($cloudflareUrl) { $cloudflareUrl } else { $ngrokUrl }

if (-not $cloudflareUrl) {
    Write-Host ""
    Write-Host "AVERTISSEMENT: URL cloudflare non trouvee apres ${timeout}s" -ForegroundColor Yellow
    Write-Host "  ngrok sera utilise comme URL principale" -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "      Cloudflare : $cloudflareUrl" -ForegroundColor Green
}
Write-Host "      ngrok      : $ngrokUrl" -ForegroundColor Green

# Mettre a jour server_config.dart avec URL cloudflare (fallback prioritaire hotspot)
if (Test-Path $ServerConfigPath) {
    $content    = Get-Content $ServerConfigPath -Raw -Encoding UTF8
    $newContent = $content -replace "(?<=productionUrl\s*=\s*`n?\s*')[^']+", $tunnelUrl
    $newContent = $newContent -replace "(?<=cloudflareUrl\s*=\s*`n?\s*')[^']+", $cfUrl
    Set-Content $ServerConfigPath -Value $newContent -Encoding UTF8 -NoNewline
    Write-Host "      server_config.dart mis a jour" -ForegroundColor Green
} else {
    Write-Host "      AVERTISSEMENT: server_config.dart introuvable" -ForegroundColor Yellow
}

# ── Recapitulatif ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=========================================" -ForegroundColor DarkCyan

$localIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -match '^192\.168\.|^10\.' } |
    Select-Object -First 1).IPAddress

$health = docker inspect --format='{{.State.Health.Status}}' center-backend 2>$null
Write-Host "  Backend    : http://localhost:5000  (sante: $health)" -ForegroundColor White
if ($localIP) {
    Write-Host "  LAN        : http://${localIP}:5000" -ForegroundColor White
}
Write-Host "  ngrok      : $ngrokUrl" -ForegroundColor Green
if ($cloudflareUrl) {
    Write-Host "  Cloudflare : $cloudflareUrl" -ForegroundColor Green
}
Write-Host ""
Write-Host "  App Flutter: detecte auto ngrok (WiFi) ou Cloudflare (hotspot)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Commandes utiles :" -ForegroundColor Gray
Write-Host "    .\DOCKER_LAUNCH.ps1 -Logs    -> logs en direct" -ForegroundColor Gray
Write-Host "    .\DOCKER_LAUNCH.ps1 -NoBuild -> relancer sans rebuild" -ForegroundColor Gray
Write-Host "    .\DOCKER_LAUNCH.ps1 -Stop    -> arreter" -ForegroundColor Gray
Write-Host "=========================================" -ForegroundColor DarkCyan
Write-Host ""

Pop-Location
