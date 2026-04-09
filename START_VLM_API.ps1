# ============================================================
# START_VLM_API.ps1 — SmolVLM-256M-Instruct Validation API
# Port 8005 | CUDA cu130 | Environnement local "environment"
# ============================================================
# Usage :
#   .\START_VLM_API.ps1          # démarrage normal
#   .\START_VLM_API.ps1 -Reload  # avec auto-reload (dev)
# ============================================================
param(
    [switch]$Reload
)

$ErrorActionPreference = "Stop"

# ── Chemins ───────────────────────────────────────────────────────────────
$ROOT        = Split-Path $PSScriptRoot -Parent
$PYTHON      = "$ROOT\frontend-center\environment\python.exe"
$UVICORN     = "$ROOT\frontend-center\environment\Scripts\uvicorn.exe"
$SCRIPT_DIR  = $PSScriptRoot   # center-backend/
$MODEL_DIR   = "$ROOT\frontend-center\models--HuggingFaceTB--SmolVLM-256M-Instruct"
$MODELS_CODE = "$SCRIPT_DIR\models"  # pour accéder à unified_agent.py

# ── Vérifications ─────────────────────────────────────────────────────────
if (-not (Test-Path $PYTHON)) {
    Write-Error "Python introuvable : $PYTHON"
    exit 1
}
if (-not (Test-Path $MODEL_DIR)) {
    Write-Error "Modèle SmolVLM introuvable : $MODEL_DIR"
    exit 1
}
if (-not (Test-Path "$SCRIPT_DIR\vlm_api.py")) {
    Write-Error "vlm_api.py introuvable dans : $SCRIPT_DIR"
    exit 1
}

# ── Variables d'environnement ─────────────────────────────────────────────
$env:SMOLVLM_MODEL_PATH = $MODEL_DIR
$env:VLM_PORT           = "8005"
$env:PYTHONUNBUFFERED   = "1"

# Ajouter models/ au PYTHONPATH pour accéder à unified_agent.py
$env:PYTHONPATH = "$MODELS_CODE;$($env:PYTHONPATH)"

# Récupérer les variables .env pour EMAIL, MONGO, etc.
$envFile = "$SCRIPT_DIR\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"').Trim("'"))
        }
    }
}

# ── Affichage ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   SmolVLM-256M-Instruct — VLM Validation API              " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Python    : $PYTHON" -ForegroundColor Gray
Write-Host " Modèle    : $MODEL_DIR" -ForegroundColor Gray
Write-Host " Port      : 8005" -ForegroundColor Green
Write-Host " PYTHONPATH: $env:PYTHONPATH" -ForegroundColor Gray
Write-Host ""

# Vérifier torch + CUDA
Write-Host " Vérification PyTorch..." -ForegroundColor Yellow
& $PYTHON -c "import torch; print(f'  torch {torch.__version__} | CUDA {torch.cuda.is_available()} | {torch.version.cuda if torch.cuda.is_available() else \"CPU only\"}')"
Write-Host ""

# ── Lancement ─────────────────────────────────────────────────────────────
Set-Location $SCRIPT_DIR

Write-Host " Démarrage uvicorn vlm_api:app sur http://0.0.0.0:8005 ..." -ForegroundColor Green
Write-Host " Endpoints :" -ForegroundColor Gray
Write-Host "   GET  http://localhost:8005/health" -ForegroundColor Gray
Write-Host "   POST http://localhost:8005/validate-payment" -ForegroundColor Gray
Write-Host "   POST http://localhost:8005/analyze-content" -ForegroundColor Gray
Write-Host "   POST http://localhost:8005/describe-image" -ForegroundColor Gray
Write-Host "   GET  http://localhost:8005/docs  (Swagger UI)" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

if ($Reload) {
    & $UVICORN vlm_api:app --host 0.0.0.0 --port 8005 --reload --log-level info
} else {
    & $PYTHON -m uvicorn vlm_api:app --host 0.0.0.0 --port 8005 --log-level info
}
