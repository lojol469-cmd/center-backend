#Requires -Version 5.1
<#
.SYNOPSIS
    Lit l'URL Cloudflare depuis les logs Docker et met à jour server_config.dart.

.DESCRIPTION
    À lancer après chaque démarrage de center-tunnel (Docker Compose).
    L'URL trycloudflare.com change à chaque (re)démarrage du conteneur.

.EXAMPLE
    .\update-tunnel-url.ps1
    .\update-tunnel-url.ps1 -Timeout 120
#>
param(
    [int]$Timeout = 60   # Secondes avant abandon
)

$ErrorActionPreference = 'Stop'

$ServerConfigPath = Join-Path $PSScriptRoot "..\frontend-center\lib\config\server_config.dart"
$ServerConfigPath = (Resolve-Path $ServerConfigPath -ErrorAction SilentlyContinue)?.Path

if (-not $ServerConfigPath) {
    # Chemin alternatif si le script est lancé depuis une autre cwd
    $ServerConfigPath = "C:\Users\Admin\Desktop\centerbackendSETRAF-clean\frontend-center\lib\config\server_config.dart"
}

Write-Host "🔍 Lecture URL tunnel depuis Docker logs..." -ForegroundColor Cyan
Write-Host "   Timeout: ${Timeout}s"

$elapsed = 0
$tunnelUrl = $null

while ($elapsed -lt $Timeout) {
    try {
        $logs = docker logs center-tunnel 2>&1 | Out-String
        $match = [regex]::Match($logs, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($match.Success) {
            $tunnelUrl = $match.Value
            break
        }
    } catch {
        # Conteneur pas encore démarré
    }
    Start-Sleep -Seconds 3
    $elapsed += 3
    Write-Host "   ⏳ Attente... ${elapsed}s" -ForegroundColor Yellow
}

if (-not $tunnelUrl) {
    Write-Host "❌ URL tunnel introuvable après ${Timeout}s" -ForegroundColor Red
    Write-Host "   Vérifiez que le conteneur center-tunnel est bien démarré :"
    Write-Host "   docker logs center-tunnel"
    exit 1
}

Write-Host "✅ URL trouvée : $tunnelUrl" -ForegroundColor Green

# Lire server_config.dart
$content = Get-Content $ServerConfigPath -Raw -Encoding UTF8

# Remplacer l'URL de production (ligne productionUrl)
$newContent = $content -replace "(?<=static const String productionUrl =\s*\n?\s*')[^']+(?=')", $tunnelUrl

if ($newContent -eq $content) {
    Write-Host "⚠️  Pattern non trouvé dans server_config.dart - vérification du fichier requise" -ForegroundColor Yellow
} else {
    Set-Content -Path $ServerConfigPath -Value $newContent -Encoding UTF8 -NoNewline
    Write-Host "✅ server_config.dart mis à jour avec $tunnelUrl" -ForegroundColor Green
}

# S'assurer que isProduction = true
$newContent = Get-Content $ServerConfigPath -Raw -Encoding UTF8
if ($newContent -match 'isProduction\s*=\s*false') {
    $newContent = $newContent -replace '(isProduction\s*=\s*)false', '${1}true'
    Set-Content -Path $ServerConfigPath -Value $newContent -Encoding UTF8 -NoNewline
    Write-Host "✅ isProduction mis à true" -ForegroundColor Green
}

Write-Host ""
Write-Host "🚀 Prochaine étape : reconstruire l'app Flutter" -ForegroundColor Cyan
Write-Host "   cd ..\frontend-center"
Write-Host "   flutter run -d windows"
