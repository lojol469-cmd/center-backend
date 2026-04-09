$r = Invoke-RestMethod -Uri 'https://api.github.com/repos/superfly/flyctl/releases/latest' -UseBasicParsing
foreach ($a in $r.assets) {
  if ($a.name -match '(?i)windows') {
    Write-Output $a.browser_download_url
  }
}