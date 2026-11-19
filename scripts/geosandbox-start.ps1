param([switch]$OpenBrowser)
. "$PSScriptRoot\geosandbox-env.ps1"
Set-Location -LiteralPath $sandboxRoot
$sandboxLogs = Join-Path $env:GEOSANDBOX_DATA_DIR 'logs'
New-Item -ItemType Directory -Force -Path $sandboxLogs | Out-Null
function Test-SandboxUrl([string]$Url) {
    try { $null = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing; return $true } catch { return $false }
}
if (-not (Test-SandboxUrl 'http://127.0.0.1:8765/sandbox/status')) {
    if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 8765 is occupied by another service.' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSScriptRoot\geosandbox-backend.ps1`"") -WorkingDirectory $sandboxRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $sandboxLogs 'backend.log') -RedirectStandardError (Join-Path $sandboxLogs 'backend-error.log') | Out-Null
}
if (-not (Test-SandboxUrl 'http://127.0.0.1:5173/deployment.json')) {
    if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 5173 is occupied by another service.' }
    if (-not (Test-Path -LiteralPath (Join-Path $sandboxRoot 'apps\geolibre-desktop\dist\index.html'))) { throw 'Run scripts\geosandbox-build.ps1 before starting the production app.' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSScriptRoot\geosandbox-web.ps1`"",'-Production') -WorkingDirectory $sandboxRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $sandboxLogs 'web.log') -RedirectStandardError (Join-Path $sandboxLogs 'web-error.log') | Out-Null
}
$sandboxReady = $false
for ($attempt=0; $attempt -lt 40; $attempt++) {
    if ((Test-SandboxUrl 'http://127.0.0.1:8765/sandbox/status') -and (Test-SandboxUrl 'http://127.0.0.1:5173/deployment.json')) { $sandboxReady=$true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $sandboxReady) { throw "Startup failed. Check $sandboxLogs" }
$sandboxPids = @{}
foreach ($port in @(5173,8765)) {
    $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    $process = Get-Process -Id $connection.OwningProcess
    $sandboxPids[$port.ToString()] = @{ id=$process.Id; started=$process.StartTime.ToUniversalTime().ToString('o') }
}
$sandboxPids | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $env:GEOSANDBOX_DATA_DIR 'processes.json') -Encoding utf8
Write-Output 'GeoSandbox ready: http://127.0.0.1:5173/'
if ($OpenBrowser) { Start-Process 'http://127.0.0.1:5173/' }
