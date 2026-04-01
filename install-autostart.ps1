#Requires -RunAsAdministrator
#Requires -Version 5.1
<#
.SYNOPSIS
    Installe le démarrage automatique de Backend CENTER + Cloudflare Tunnel au boot Windows.

.DESCRIPTION
    Crée une tâche Windows Scheduler qui :
    - Se déclenche au démarrage du système (avant connexion)
    - Lance Docker Compose (backend + tunnel Cloudflare) en arrière-plan
    - Attend 30s puis capture l'URL tunnel et met à jour server_config.dart

.PARAMETER Uninstall
    Supprime la tâche planifiée (reverse).

.EXAMPLE
    # Installation (lancer PowerShell en Administrateur) :
    .\install-autostart.ps1

    # Désinstallation :
    .\install-autostart.ps1 -Uninstall
#>
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName  = "CenterBackend_Autostart"
$TaskDesc  = "Démarre automatiquement le backend CENTER (Node.js + Cloudflare Tunnel via Docker)"
$ComposeDir = $PSScriptRoot   # center-backend/

# ─── DÉSINSTALLATION ─────────────────────────────────────────────────────────
if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "✅ Tâche '$TaskName' supprimée." -ForegroundColor Green
    } else {
        Write-Host "ℹ️  Tâche '$TaskName' introuvable." -ForegroundColor Yellow
    }
    exit 0
}

# ─── VÉRIFICATIONS PRÉ-INSTALLATION ──────────────────────────────────────────
Write-Host "🔧 Installation du démarrage automatique CENTER Backend..." -ForegroundColor Cyan
Write-Host ""

# Vérifier Docker
$dockerExe = (Get-Command docker -ErrorAction SilentlyContinue)?.Source
if (-not $dockerExe) {
    Write-Host "❌ Docker non trouvé dans PATH. Installez Docker Desktop d'abord." -ForegroundColor Red
    exit 1
}
Write-Host "✅ Docker détecté : $dockerExe"

# Vérifier docker-compose.backend.yml
$composeFile = Join-Path $ComposeDir "docker-compose.backend.yml"
if (-not (Test-Path $composeFile)) {
    Write-Host "❌ Fichier introuvable : $composeFile" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Compose file : $composeFile"

# ─── CRÉER LE SCRIPT DE DÉMARRAGE ────────────────────────────────────────────
# Ce script sera exécuté par Task Scheduler au boot
$launchScript = Join-Path $ComposeDir "autostart-launch.ps1"

@"
# Script de démarrage automatique (généré par install-autostart.ps1)
# Ne pas modifier manuellement.
Set-Location "$ComposeDir"

# Attendre que Docker soit disponible
`$maxWait = 120
`$elapsed = 0
while (`$elapsed -lt `$maxWait) {
    try {
        `$null = docker info 2>`$null
        break
    } catch { }
    Start-Sleep -Seconds 3
    `$elapsed += 3
}

# Lancer le Docker Compose en arrière-plan
Start-Process -FilePath "docker" ``
    -ArgumentList "compose", "-f", "docker-compose.backend.yml", "up", "-d", "--build" ``
    -WorkingDirectory "$ComposeDir" ``
    -WindowStyle Hidden

# Attendre que le tunnel soit prêt puis mettre à jour l'URL dans server_config.dart
Start-Sleep -Seconds 45
& "$ComposeDir\update-tunnel-url.ps1" -Timeout 120
"@ | Set-Content -Path $launchScript -Encoding UTF8

Write-Host "✅ Script de lancement créé : $launchScript"

# ─── CRÉER LA TÂCHE PLANIFIÉE ─────────────────────────────────────────────────
# Supprimer l'ancienne si elle existe
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "♻️  Ancienne tâche supprimée."
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launchScript`""

# Déclencheur : au démarrage du système + délai de 20s (pour que Docker ait le temps de démarrer)
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT20S"   # Délai ISO 8601 = 20 secondes

# Paramètres : lancer avec le compte SYSTEM, sans session utilisateur
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Description $TaskDesc `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "✅ INSTALLATION TERMINÉE" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Tâche créée : '$TaskName'"
Write-Host "   → Se déclenche 20s après le démarrage Windows"
Write-Host "   → Lance docker compose up -d (backend + tunnel)"
Write-Host "   → Met à jour server_config.dart avec la nouvelle URL tunnel"
Write-Host ""
Write-Host "🔍 Pour vérifier la tâche :"
Write-Host "   Get-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "🖥️  Pour activer Docker au démarrage Windows :"
Write-Host "   - Ouvrez Docker Desktop"
Write-Host "   - Settings → General → ✅ 'Start Docker Desktop when you sign in'"
Write-Host ""
Write-Host "🚀 Pour tester maintenant sans redémarrer :"
Write-Host "   cd '$ComposeDir'"
Write-Host "   docker compose -f docker-compose.backend.yml up -d --build"
Write-Host "   .\update-tunnel-url.ps1"
Write-Host ""
Write-Host "⚠️  RAPPEL URL TUNNEL :"
Write-Host "   L'URL trycloudflare.com change à chaque redémarrage du conteneur."
Write-Host "   update-tunnel-url.ps1 met automatiquement à jour server_config.dart."
Write-Host "   Relancez ensuite : flutter run (ou flutter build)"
