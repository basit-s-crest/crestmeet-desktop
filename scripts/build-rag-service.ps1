# scripts/build-rag-service.ps1
# Compiles services/rag_service into a standalone sidecar binary for production packaging.
# Output: frontend/src-tauri/binaries/crestmeet-rag-service-x86_64-pc-windows-msvc.exe

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$RagDir = Join-Path $RootDir "services\rag_service"
$BinDir = Join-Path $RootDir "frontend\src-tauri\binaries"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "📦 Building CrestMeet Python RAG Sidecar for Production" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

$TargetBinary = Join-Path $BinDir "crestmeet-rag-service-x86_64-pc-windows-msvc.exe"

# Use virtualenv Python if present, otherwise system uv / python
$VenvPython = Join-Path $RagDir ".venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
    $PythonCmd = $VenvPython
} else {
    $PythonCmd = "python"
}

Write-Host "Checking for pyinstaller..." -ForegroundColor Yellow
& $PythonCmd -m pip show pyinstaller 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing pyinstaller in environment..." -ForegroundColor Yellow
    & $PythonCmd -m pip install pyinstaller
}

Write-Host "Running PyInstaller on run_server.py..." -ForegroundColor Green
Push-Location $RagDir
try {
    & $PythonCmd -m PyInstaller `
        --name "crestmeet-rag-service-x86_64-pc-windows-msvc" `
        --onefile `
        --noconsole `
        --clean `
        --distpath $BinDir `
        --workpath "$RagDir\build" `
        --specpath "$RagDir" `
        --add-data "src;crestmeet_rag" `
        run_server.py

    if (Test-Path $TargetBinary) {
        $FileSizeMB = [math]::Round((Get-Item $TargetBinary).Length / 1MB, 2)
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host "✅ Standalone RAG sidecar successfully compiled!" -ForegroundColor Green
        Write-Host "📁 Output: $TargetBinary ($FileSizeMB MB)" -ForegroundColor Green
        Write-Host "============================================================" -ForegroundColor Green
    } else {
        Write-Error "Binary was not created at expected path: $TargetBinary"
    }
} finally {
    Pop-Location
}
