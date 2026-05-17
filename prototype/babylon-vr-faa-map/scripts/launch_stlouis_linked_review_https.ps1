param(
    [int]$Port = 4443,
    [switch]$OpenDesktopPreview,
    [switch]$TrustCurrentUser
)

$ErrorActionPreference = "Stop"

function Get-ListeningProcessIdsForPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $lines = netstat -ano -p tcp | Select-String "LISTENING"
    $processIds = @()
    foreach ($line in $lines) {
        $text = ($line.ToString() -replace "\s+", " ").Trim()
        if ($text -match "TCP\s+[^ ]+:$Port\s+[^ ]+\s+LISTENING\s+(\d+)$") {
            $processIds += [int]$matches[1]
        }
    }
    return @($processIds | Sort-Object -Unique)
}

function Get-PrimaryIPv4Address {
    $socket = [System.Net.Sockets.Socket]::new(
        [System.Net.Sockets.AddressFamily]::InterNetwork,
        [System.Net.Sockets.SocketType]::Dgram,
        [System.Net.Sockets.ProtocolType]::Udp
    )
    try {
        $socket.Connect("8.8.8.8", 53)
        return ([System.Net.IPEndPoint]$socket.LocalEndPoint).Address.ToString()
    } catch {
        $fallback = [System.Net.Dns]::GetHostEntry([System.Net.Dns]::GetHostName()).AddressList |
            Where-Object {
                $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                -not $_.IPAddressToString.StartsWith("127.")
            } |
            Select-Object -First 1
        if ($fallback) {
            return $fallback.IPAddressToString
        }
        throw "Could not determine a LAN IPv4 address for HTTPS linked review."
    } finally {
        $socket.Dispose()
    }
}

$appRoot = Split-Path -Parent $PSScriptRoot
$prototypeRoot = Split-Path -Parent $appRoot
$certRoot = Join-Path $appRoot ".dev-certs"
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$computerName = $env:COMPUTERNAME
$lanIp = Get-PrimaryIPv4Address
$certInfo = & (Join-Path $PSScriptRoot "ensure_stlouis_dev_cert.ps1") `
    -OutputDirectory $certRoot `
    -HostNames @("localhost", $computerName) `
    -IpAddresses @("127.0.0.1", $lanIp) `
    -TrustCurrentUser:$TrustCurrentUser

$vrLocalUrl = "https://localhost:$Port/babylon-vr-faa-map/?section=stlouis"
$desktopLocalUrl = "https://localhost:$Port/faa-2d-map/?section=stlouis"
$vrLanUrl = "https://$lanIp`:$Port/babylon-vr-faa-map/?section=stlouis"
$desktopLanUrl = "https://$lanIp`:$Port/faa-2d-map/?section=stlouis"

$existingPids = Get-ListeningProcessIdsForPort -Port $Port
if ($existingPids.Count -gt 0) {
    throw "Port $Port is already in use by process ID(s): $($existingPids -join ', '). Stop that listener first."
}

if ($OpenDesktopPreview) {
    Start-Process $vrLocalUrl
    Start-Process $desktopLocalUrl
}

Write-Host "Starting linked St. Louis review on the foreground HTTPS server."
Write-Host "Keep this PowerShell window open while the browser/headset is using the demo."
Write-Host "Press Ctrl+C here when you want to stop it."
Write-Host ""
Write-Host "Local VR URL:      $vrLocalUrl"
Write-Host "Local 2D URL:      $desktopLocalUrl"
Write-Host "LAN VR URL:        $vrLanUrl"
Write-Host "LAN 2D URL:        $desktopLanUrl"
Write-Host "Certificate bundle:"
Write-Host "  PFX file: $($certInfo.CertificatePfx)"
Write-Host "  CER file: $($certInfo.CertificateCer)"
Write-Host ""
Write-Host "If the desktop or headset does not trust the certificate yet, install the CER file first."
Write-Host "Start Link in both apps with the same session ID after the pages load."
Write-Host ""

$directArgs = @(
    (Join-Path $appRoot "tools\\serve_https.cjs"),
    "--host", "0.0.0.0",
    "--port", "$Port",
    "--directory", $prototypeRoot,
    "--pfxfile", $certInfo.CertificatePfx,
    "--passphrase", $certInfo.PfxPassword
)

& $nodeExe @directArgs
