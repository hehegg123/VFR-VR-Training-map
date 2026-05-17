$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $appRoot
$vrUrl = "http://localhost:4173/babylon-vr-faa-map/?section=stlouis"
$desktopUrl = "http://localhost:4173/faa-2d-map/?section=stlouis"

$existing = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $existing) {
    $server = Start-Process -FilePath py -ArgumentList "-3", "-m", "http.server", "4173" -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    Write-Host "Started linked review server (PID $($server.Id))."
} else {
    Write-Host "Linked review server already running on port 4173."
}

Start-Process $vrUrl
Start-Process $desktopUrl

Write-Host "Opened VR viewer: $vrUrl"
Write-Host "Opened 2D companion: $desktopUrl"
Write-Host "Start Link in both apps with the same session ID to sync selections."
Write-Host "Use .\\scripts\\stop_stlouis_prototype.ps1 to stop the server."
