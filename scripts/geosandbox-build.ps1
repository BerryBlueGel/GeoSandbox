. "$PSScriptRoot\geosandbox-env.ps1"
$env:NODE_OPTIONS='--max-old-space-size=6144'
Set-Location -LiteralPath $sandboxRoot
npm.cmd run build -w geolibre-desktop -- --mode geosandbox
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
