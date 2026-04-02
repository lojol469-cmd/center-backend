# START_CHAT_API.ps1
# Lance chat_agent_api.py avec le Python local (cu130 + SmolVLM deja installes)
# Usage: .\START_CHAT_API.ps1

$PYTHON = "C:\Users\Admin\Desktop\centerbackendSETRAF-clean\frontend-center\environment\python.exe"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$MODEL_DIR = "C:\Users\Admin\Desktop\centerbackendSETRAF-clean\frontend-center\models--HuggingFaceTB--SmolVLM-256M-Instruct"
$FAISS_STORAGE = "$SCRIPT_DIR\storage\chat_memory"

# Creer le dossier FAISS si necessaire
New-Item -ItemType Directory -Force -Path $FAISS_STORAGE | Out-Null

# Variables d'environnement
$env:SMOLVLM_MODEL_PATH = $MODEL_DIR
$env:SENTENCE_TRANSFORMERS_HOME = "$SCRIPT_DIR\storage\models_cache"
$env:HF_HOME = "$SCRIPT_DIR\storage\models_cache"
$env:CHAT_PORT = "8002"
$env:PYTHONUNBUFFERED = "1"

# Charger le .env si present
$envFile = "$SCRIPT_DIR\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.*)') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

Write-Host "=== Chat API (SmolVLM-256M cu130) ===" -ForegroundColor Cyan
Write-Host "Python  : $PYTHON" -ForegroundColor Green
Write-Host "Modele  : $MODEL_DIR" -ForegroundColor Green
Write-Host "Port    : 8002" -ForegroundColor Green
Write-Host ""

Set-Location $SCRIPT_DIR

& $PYTHON -m uvicorn chat_agent_api:app --host 0.0.0.0 --port 8002 --log-level info
