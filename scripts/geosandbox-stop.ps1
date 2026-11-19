. "$PSScriptRoot\geosandbox-env.ps1"
$sandboxPidFile = Join-Path $env:GEOSANDBOX_DATA_DIR 'processes.json'
if (-not (Test-Path -LiteralPath $sandboxPidFile)) { Write-Output 'No launcher-managed services.'; exit }
$sandboxPids = Get-Content -LiteralPath $sandboxPidFile -Raw | ConvertFrom-Json
foreach ($entry in $sandboxPids.PSObject.Properties) {
    $pidValue = [int]$entry.Value.id
    $running = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $running) { continue }
    $recordedStart = ([datetime]$entry.Value.started).ToUniversalTime()
    if ($running.StartTime.ToUniversalTime().Ticks -ne $recordedStart.Ticks) { continue }
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue"
    if (($info.CommandLine -like "*$sandboxRoot*") -or ($info.ExecutablePath -like "$sandboxRoot\*")) { Stop-Process -Id $pidValue }
}
Write-Output 'Stopped GeoSandbox services recorded by this launcher.'
