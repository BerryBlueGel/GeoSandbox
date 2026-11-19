param([string]$Python = 'python', [string]$PipIndex = 'https://pypi.org/simple')
. "$PSScriptRoot\geosandbox-env.ps1"
Set-Location -LiteralPath $sandboxRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }
}
& .\.venv\Scripts\python.exe -m pip install --index-url $PipIndex -e 'backend/geolibre_server[sandbox,dev]'
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed.' }
node scripts/geosandbox-fixtures.mjs
if ($LASTEXITCODE -ne 0) { throw 'Model fixture generation failed.' }
& .\.venv\Scripts\python.exe scripts/geosandbox-fixtures.py
if ($LASTEXITCODE -ne 0) { throw 'GIS fixture generation failed.' }
& "$PSScriptRoot\geosandbox-build.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Production build failed.' }
