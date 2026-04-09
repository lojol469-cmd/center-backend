# ============================================================
# test_vlm.ps1 — Tests HTTP complets de vlm_api.py (port 8005)
# Usage : .\test_vlm.ps1
# ============================================================

$BASE = "http://localhost:8005"
$PASS = 0
$FAIL = 0

function Test-Endpoint {
    param($Name, $Result, $Expected)
    if ($Result -match $Expected) {
        Write-Host " [PASS] $Name" -ForegroundColor Green
        $script:PASS++
    } else {
        Write-Host " [FAIL] $Name" -ForegroundColor Red
        Write-Host "        Réponse: $Result" -ForegroundColor DarkGray
        $script:FAIL++
    }
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   VLM API Tests — SmolVLM-256M-Instruct (port 8005)       " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Health ─────────────────────────────────────────────────────────────
Write-Host "1. GET /health" -ForegroundColor Yellow
try {
    $r = Invoke-RestMethod -Uri "$BASE/health" -Method Get -TimeoutSec 30
    $json = $r | ConvertTo-Json -Compress
    Write-Host "   $json" -ForegroundColor Gray
    Test-Endpoint "/health retourne status" $json "status"
    if ($r.model_loaded -eq $true) {
        Write-Host " [INFO] ✅ Modèle SmolVLM chargé — device: $($r.device) quant: $($r.quantization)" -ForegroundColor Cyan
    } else {
        Write-Host " [WARN] ⚠️ Modèle non chargé (mode dégradé)" -ForegroundColor DarkYellow
    }
} catch {
    Write-Host " [FAIL] /health inaccessible: $($_.Exception.Message)" -ForegroundColor Red
    $FAIL++
    Write-Host " ► Assurez-vous que START_VLM_API.ps1 est démarré" -ForegroundColor DarkYellow
    exit 1
}

# ── 2. Swagger docs ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "2. GET /docs (Swagger UI)" -ForegroundColor Yellow
try {
    $r = Invoke-WebRequest -Uri "$BASE/docs" -TimeoutSec 10
    Test-Endpoint "/docs accessible" "$($r.StatusCode)" "200"
} catch {
    Write-Host " [WARN] /docs: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

# ── 3. describe-image avec image synthétique ──────────────────────────────
Write-Host ""
Write-Host "3. POST /describe-image (image 100x100 verte)" -ForegroundColor Yellow

# Générer une image JPEG en mémoire via .NET
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 100, 100
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Green)
$g.DrawString("TEST 5000 XAF", (New-Object System.Drawing.Font("Arial", 12)), [System.Drawing.Brushes]::White, 5, 40)
$g.Dispose()
$tmpImg = [System.IO.Path]::GetTempFileName() -replace "\.tmp$", ".jpg"
$bmp.Save($tmpImg, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()

try {
    $boundary = [System.Guid]::NewGuid().ToString()
    $imgBytes  = [System.IO.File]::ReadAllBytes($tmpImg)
    $body  = "--$boundary`r`n"
    $body += "Content-Disposition: form-data; name=`"image`"; filename=`"test.jpg`"`r`n"
    $body += "Content-Type: image/jpeg`r`n`r`n"
    $bodyBytes = [System.Text.Encoding]::ASCII.GetBytes($body) + $imgBytes +
                 [System.Text.Encoding]::ASCII.GetBytes("`r`n--$boundary--`r`n")

    $r = Invoke-RestMethod -Uri "$BASE/describe-image" -Method Post `
         -ContentType "multipart/form-data; boundary=$boundary" `
         -Body $bodyBytes -TimeoutSec 120

    Write-Host "   description: $($r.description.Substring(0, [Math]::Min(120, $r.description.Length)))..." -ForegroundColor Gray
    Test-Endpoint "/describe-image retourne description" $r.description "."
} catch {
    Write-Host " [FAIL] /describe-image: $($_.Exception.Message)" -ForegroundColor Red
    $FAIL++
}

# ── 4. validate-payment avec la même image ─────────────────────────────────
Write-Host ""
Write-Host "4. POST /validate-payment (image de test)" -ForegroundColor Yellow
try {
    $boundary = [System.Guid]::NewGuid().ToString()
    $imgBytes  = [System.IO.File]::ReadAllBytes($tmpImg)
    $body  = "--$boundary`r`n"
    $body += "Content-Disposition: form-data; name=`"image`"; filename=`"proof.jpg`"`r`n"
    $body += "Content-Type: image/jpeg`r`n`r`n"
    $body2  = "`r`n--$boundary`r`n"
    $body2 += "Content-Disposition: form-data; name=`"expected_amount`"`r`n`r`n5000`r`n"
    $body2 += "--$boundary`r`n"
    $body2 += "Content-Disposition: form-data; name=`"payment_number`"`r`n`r`n076356144`r`n"
    $body2 += "--$boundary--`r`n"
    $bodyBytes = [System.Text.Encoding]::ASCII.GetBytes($body) + $imgBytes +
                 [System.Text.Encoding]::ASCII.GetBytes($body2)

    $r = Invoke-RestMethod -Uri "$BASE/validate-payment" -Method Post `
         -ContentType "multipart/form-data; boundary=$boundary" `
         -Body $bodyBytes -TimeoutSec 120

    $json = $r | ConvertTo-Json -Compress
    Write-Host "   $json" -ForegroundColor Gray
    Test-Endpoint "/validate-payment retourne valid" $json "valid"
    Test-Endpoint "/validate-payment retourne confidence" $json "confidence"
} catch {
    Write-Host " [FAIL] /validate-payment: $($_.Exception.Message)" -ForegroundColor Red
    $FAIL++
}

# ── 5. analyze-content (texte seul) ───────────────────────────────────────
Write-Host ""
Write-Host "5. POST /analyze-content (texte modéré)" -ForegroundColor Yellow
try {
    $boundary = [System.Guid]::NewGuid().ToString()
    $textBody  = "--$boundary`r`n"
    $textBody += "Content-Disposition: form-data; name=`"text`"`r`n`r`n"
    $textBody += "Bonjour, j'aimerais acheter des Topocoin pour booster ma vidéo.`r`n"
    $textBody += "--$boundary--`r`n"
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($textBody)

    $r = Invoke-RestMethod -Uri "$BASE/analyze-content" -Method Post `
         -ContentType "multipart/form-data; boundary=$boundary" `
         -Body $bodyBytes -TimeoutSec 120

    Write-Host "   safe=$($r.safe) confidence=$($r.confidence) reason=$($r.reason)" -ForegroundColor Gray
    Test-Endpoint "/analyze-content retourne safe" "$($r.safe)" "True|False"
} catch {
    Write-Host " [FAIL] /analyze-content: $($_.Exception.Message)" -ForegroundColor Red
    $FAIL++
}

# Nettoyage image temp
Remove-Item $tmpImg -ErrorAction SilentlyContinue

# ── 6. Test deposit-with-proof via Node.js backend ────────────────────────
Write-Host ""
Write-Host "6. Test intégration monetization.js (requiert login token)" -ForegroundColor Yellow
Write-Host "   → Ce test nécessite un token JWT valide." -ForegroundColor DarkGray
Write-Host "   → Pour tester manuellement après login :" -ForegroundColor DarkGray
Write-Host '   $token = "<votre_token>"' -ForegroundColor DarkGray
Write-Host '   # Envoyer un screenshot réel de paiement Airtel Money' -ForegroundColor DarkGray
Write-Host '   curl -X POST http://localhost:5000/api/wallet/deposit-with-proof' -ForegroundColor DarkGray
Write-Host '        -H "Authorization: Bearer $token"' -ForegroundColor DarkGray
Write-Host '        -F "pack_id=pack_100"' -ForegroundColor DarkGray
Write-Host '        -F "screenshot=@C:\path\to\airtel_money_screenshot.jpg"' -ForegroundColor DarkGray

# ── Résumé ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   RÉSULTATS : $PASS passé(s) | $FAIL échoué(s)" -ForegroundColor $(if ($FAIL -eq 0) { "Green" } else { "Yellow" })
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

if ($FAIL -eq 0) {
    Write-Host " ✅ VLM API opérationnelle ! Prête pour l'image Docker." -ForegroundColor Green
} else {
    Write-Host " ⚠️  Vérifiez que START_VLM_API.ps1 est démarré et le modèle chargé." -ForegroundColor Yellow
}
