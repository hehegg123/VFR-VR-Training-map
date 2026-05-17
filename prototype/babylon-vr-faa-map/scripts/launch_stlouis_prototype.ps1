$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $appRoot
$url = "http://localhost:4173/babylon-vr-faa-map/?section=stlouis"

$existing = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
    Start-Process $url
    Write-Host "Prototype server already running on port 4173. Opened $url"
    return
}

$server = Start-Process -FilePath py -ArgumentList "-3", "-m", "http.server", "4173" -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
Start-Process $url

Write-Host "Started St. Louis desktop review server (PID $($server.Id))."
Write-Host "Opened $url"
Write-Host "2D companion is available at http://localhost:4173/faa-2d-map/?section=stlouis"
Write-Host "For headset/WebXR review, use .\\scripts\\launch_stlouis_hmd_demo.ps1 instead."
Write-Host "Use .\\scripts\\stop_stlouis_prototype.ps1 to stop it."
