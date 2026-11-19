$ErrorActionPreference = 'Stop'
$sandboxRoot = Split-Path -Parent $PSScriptRoot
$sandboxCache = Join-Path (Split-Path -Parent $sandboxRoot) '.geosandbox-cache'
foreach ($folder in @('temp','npm','pip','runtime','playwright','uv','uv-python')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $sandboxCache $folder) | Out-Null
}
$env:TEMP = Join-Path $sandboxCache 'temp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $sandboxCache 'npm'
$env:PIP_CACHE_DIR = Join-Path $sandboxCache 'pip'
$env:UV_CACHE_DIR = Join-Path $sandboxCache 'uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $sandboxCache 'uv-python'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $sandboxCache 'playwright'
$env:GEOLIBRE_RUNTIME_DIR = Join-Path $sandboxCache 'runtime'
$env:GEOSANDBOX_DATA_DIR = Join-Path $sandboxRoot '.geosandbox'
$env:GEOLIBRE_CONVERSION_PYTHON = Join-Path $sandboxRoot '.venv\Scripts\python.exe'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:GEOLIBRE_AI_URL = '/ai'
$env:GEOLIBRE_AI_MODEL = 'deepseek-flash'
