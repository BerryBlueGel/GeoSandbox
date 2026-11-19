param([switch]$Build)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\geosandbox-env.ps1"
Set-Location -LiteralPath $sandboxRoot
$acceptanceLogs = Join-Path $sandboxRoot '.geosandbox\logs'
New-Item -ItemType Directory -Path $acceptanceLogs -Force | Out-Null
$steps = @()

function Run-Check([string]$Name, [scriptblock]$Action) {
    $checkLog = Join-Path $acceptanceLogs "accept-$Name.log"
    & $Action *> $checkLog
    $passed = $LASTEXITCODE -eq 0
    $script:steps += @{ name = $Name; passed = $passed; log = $checkLog }
    if (-not $passed) { Get-Content -LiteralPath $checkLog -Tail 20; throw "Acceptance failed: $Name" }
    Write-Output "PASS $Name"
}

try {
    Run-Check 'frontend' { node --import tsx --test tests/geosandbox-*.test.ts tests/local-gltf.test.ts tests/geopackage-writer.test.ts tests/shapefile-writer.test.ts }
    Run-Check 'backend' { & "$sandboxRoot\.venv\Scripts\python.exe" -m pytest backend/geolibre_server/tests/test_sandbox.py backend/geolibre_server/tests/test_sandbox_native_jobs.py backend/geolibre_server/tests/test_sandbox_maintenance.py backend/geolibre_server/tests/test_conversion.py backend/geolibre_server/tests/test_raster.py backend/geolibre_server/tests/test_vector_golden.py -q }
    Run-Check 'artifacts' { & "$sandboxRoot\.venv\Scripts\python.exe" scripts/geosandbox-verify-artifacts.py examples/GeoSandbox完整流程验收.geosandbox examples/GeoSandbox组合装配.glb examples/GeoSandbox组合装配.geo.json }
    if ($Build) { Run-Check 'build' { & "$PSScriptRoot\geosandbox-build.ps1" } }
} finally {
    @{ completedAt = [DateTime]::UtcNow.ToString('o'); steps = $steps; manualBrowserAndRealDataNotCovered = $true } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $acceptanceLogs 'acceptance-latest.json') -Encoding utf8
}
