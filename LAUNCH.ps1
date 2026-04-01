# ================================================================
# LAUNCH.ps1 - Lance backend Node.js + tunnel Cloudflare
# ================================================================
# Usage :
#   .\LAUNCH.ps1           -> backend + tunnel (URL publique auto)
#   .\LAUNCH.ps1 -NoTunnel -> backend local uniquement
# ================================================================

param(
    [switch]$NoTunnel
)

$ErrorActionPreference = 'SilentlyContinue'

$BackendDir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerConfigPath = "$BackendDir\..\frontend-center\lib\config\server_config.dart"
$TunnelLog        = Join-Path $env:TEMP "cloudflared-center.log"

Push-Location $BackendDir

Write-Host ""
Write-Host "=========================================" -ForegroundColor DarkCyan
Write-Host " CENTER BACKEND - LAUNCHER" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor DarkCyan

# ── 1. Arret des processus existants ─────────────────────────────────────────
Write-Host ""
Write-Host "[1/3] Arret des processus existants..." -ForegroundColor Yellow
Get-Process node        -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Write-Host "      OK" -ForegroundColor DarkGray

# ── 2. Tunnel Cloudflare ─────────────────────────────────────────────────────
$CloudflaredExe = "cloudflared"
if (-not $NoTunnel) {
    # Priorite 1 : cloudflared.exe dans le meme dossier que ce script (portable)
    $LocalExe = Join-Path $BackendDir "cloudflared.exe"
    if (Test-Path $LocalExe) {
        $CloudflaredExe = $LocalExe
        Write-Host "      cloudflared portable trouve : $LocalExe" -ForegroundColor DarkGray
    } elseif (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "AVERTISSEMENT: cloudflared introuvable." -ForegroundColor Yellow
        Write-Host "  Placez cloudflared.exe dans : $BackendDir" -ForegroundColor Gray
        Write-Host "  Mode local uniquement." -ForegroundColor Gray
        $NoTunnel = $true
    }
}

$tunnelProcess = $null
$tunnelUrl     = $null

if (-not $NoTunnel) {
    Write-Host ""
    Write-Host "[2/3] Demarrage du tunnel Cloudflare..." -ForegroundColor Cyan

    if (Test-Path $TunnelLog) { Remove-Item $TunnelLog -Force }

    $tunnelProcess = Start-Process `
        -FilePath $CloudflaredExe `
        -ArgumentList "tunnel", "--no-autoupdate", "--url", "http://localhost:5000" `
        -RedirectStandardError $TunnelLog `
        -NoNewWindow `
        -PassThru `
        -ErrorAction SilentlyContinue

    if (-not $tunnelProcess -or $tunnelProcess.HasExited) {
        Write-Host "      ERREUR: Impossible de lancer cloudflared. Mode local." -ForegroundColor Red
        $NoTunnel = $true
    } else {
        Write-Host "      PID cloudflared : $($tunnelProcess.Id)"
        Write-Host "      Attente URL publique (max 60s)..." -ForegroundColor Gray

        $timeout = 60
        $elapsed = 0

        while ($elapsed -lt $timeout) {
            Start-Sleep -Seconds 2
            $elapsed += 2

            if (Test-Path $TunnelLog) {
                $logContent = Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue
                if ($logContent) {
                    $match = [regex]::Match($logContent, 'https://[a-z0-9\-]+\.trycloudflare\.com')
                    if ($match.Success) {
                        $tunnelUrl = $match.Value
                        break
                    }
                }
            }
            Write-Host "      ${elapsed}s..." -ForegroundColor DarkGray
        }

        if ($tunnelUrl) {
            Write-Host ""
            Write-Host "      Tunnel actif : $tunnelUrl" -ForegroundColor Green

            if (Test-Path $ServerConfigPath) {
                $content    = Get-Content $ServerConfigPath -Raw -Encoding UTF8
                $newContent = $content -replace "(?<=productionUrl\s*=\s*`n?\s*')[^']+", $tunnelUrl
                Set-Content $ServerConfigPath -Value $newContent -Encoding UTF8 -NoNewline
                Write-Host "      server_config.dart mis a jour" -ForegroundColor Green
            }
        } else {
            Write-Host "      URL non trouvee apres ${timeout}s - mode local." -ForegroundColor Yellow
        }
    }
}

# ── 3. Recapitulatif ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=========================================" -ForegroundColor DarkCyan

$localIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -match '^192\.168\.|^10\.' } |
    Select-Object -First 1).IPAddress

Write-Host "  Local  : http://localhost:5000" -ForegroundColor White
if ($localIP) {
    Write-Host "  LAN    : http://${localIP}:5000" -ForegroundColor White
}
if ($tunnelUrl) {
    Write-Host "  Public : $tunnelUrl" -ForegroundColor Green
} else {
    Write-Host "  Public : (pas de tunnel)" -ForegroundColor DarkGray
}
Write-Host "=========================================" -ForegroundColor DarkCyan
Write-Host ""

# ── 4. Node.js (bloquant - logs visibles en direct) ──────────────────────────
Write-Host "[3/3] Demarrage backend Node.js..." -ForegroundColor Cyan
Write-Host "      (Ctrl+C pour arreter - le tunnel s'arretera aussi)" -ForegroundColor DarkGray
Write-Host ""

try {
    node server.js
} finally {
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
        Write-Host ""
        Write-Host "Arret du tunnel..." -ForegroundColor Yellow
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Backend arrete." -ForegroundColor DarkGray
    Pop-Location
}
