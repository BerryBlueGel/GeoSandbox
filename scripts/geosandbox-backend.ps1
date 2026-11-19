. "$PSScriptRoot\geosandbox-env.ps1"
Set-Location -LiteralPath $sandboxRoot
& "$sandboxRoot\.venv\Scripts\python.exe" -m uvicorn geolibre_server.app.main:app --host 127.0.0.1 --port 8765
