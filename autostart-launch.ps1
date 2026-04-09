Set-Location "C:\Users\Admin\Desktop\centerbackendSETRAF-clean\center-backend"
$maxWait = 120; $elapsed = 0
while ($elapsed -lt $maxWait) { try { docker info 2>$null; if ($LASTEXITCODE -eq 0) { break } } catch { }; Start-Sleep -Seconds 3; $elapsed += 3 }
docker compose -f docker-compose.backend.yml up -d
Start-Sleep -Seconds 45
if (Test-Path "C:\Users\Admin\Desktop\centerbackendSETRAF-clean\center-backend\update-tunnel-url.ps1") { & "C:\Users\Admin\Desktop\centerbackendSETRAF-clean\center-backend\update-tunnel-url.ps1" -Timeout 120 }
