param([switch]$Production)
. "$PSScriptRoot\geosandbox-env.ps1"
Set-Location -LiteralPath $sandboxRoot
if ($Production) {
    npm.cmd run preview -w geolibre-desktop -- --host 127.0.0.1 --port 5173 --strictPort --mode geosandbox
} else {
    npm.cmd run dev -w geolibre-desktop -- --host 127.0.0.1 --mode geosandbox
}
