Param(
  [Parameter(Mandatory=$true)]
  [string]$FlyToken
)

$fly = "C:\Users\Admin\Desktop\centerbackendSETRAF-clean\frontend-center\environment\flyctl.exe"
$env:FLY_API_TOKEN = $FlyToken

Write-Output "Checking flyctl version..."
& $fly version

Write-Output "Verifying authentication..."
& $fly auth whoami

# Create app if it does not exist
$appName = "center-backend"
  $createResult = & $fly apps create --name $appName -o ol-loj --save 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Output "App create output: $createResult"
    Write-Output "App creation failed or org not found — attempting fallback: fly launch"
    $launchResult = & $fly launch --name $appName --yes 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Output "Fallback launch output: $launchResult"
      Write-Output "Fallback failed. Please run interactive auth and launch locally:"
      Write-Output "  $fly auth login"
      Write-Output "  $fly launch --name $appName --yes"
      Write-Output "After creating the app/run launch, re-run this script. Aborting."
      exit 1
    } else {
      Write-Output "fly launch succeeded and fly.toml created"
    }
  } else {
    Write-Output "App $appName created"
  }

# Path to .env
$envFile = "C:\Users\Admin\Desktop\centerbackendSETRAF-clean\center-backend\.env"
if (-Not (Test-Path $envFile)) {
  Write-Error ".env not found at $envFile"
  exit 1
}

# Keys to import as secrets
$keys = @(
  "MONGO_URI","MONGO_USER","MONGO_PASSWORD","MONGO_DB_NAME","MONGO_CLUSTER","MONGO_HOSTS",
  "JWT_SECRET","JWT_REFRESH_SECRET",
  "CLOUDINARY_CLOUD_NAME","CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET","CLOUDINARY_URL",
  "EMAIL_USER","EMAIL_PASS",
  "HF_TOKEN","TAVILY_API_KEY",
  "FIREBASE_SERVICE_ACCOUNT"
)

Write-Output "Importing secrets from .env"
Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq '' -or $line.StartsWith('#')) { return }
  $m = $line -match "^(?<k>[A-Za-z0-9_]+)=(?<v>.*)$"
  if ($m) {
    $k = $Matches['k']
    $v = $Matches['v']
    # Remove surrounding quotes if present
    if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Trim('"') }
    if ($keys -contains $k) {
      Write-Output "Setting secret $k"
      # Use flyctl to set secret for the specific app
      & $fly secrets set --app $appName "$k=$v"
      if ($LASTEXITCODE -ne 0) {
        Write-Output "Warning: setting $k failed"
      }
    }
  }
}

# Deploy using Dockerfile in repo
Write-Output "Starting deploy... this may take a few minutes"
& $fly deploy --dockerfile Dockerfile --app $appName

Write-Output "Deploy finished with exit code $LASTEXITCODE"
