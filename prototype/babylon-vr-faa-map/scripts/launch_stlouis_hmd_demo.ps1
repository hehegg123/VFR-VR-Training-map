param(
    [int]$Port = 4443,
    [switch]$OpenDesktopPreview,
    [switch]$TrustCurrentUser
)

$ErrorActionPreference = "Stop"

function Resolve-NodeExecutable {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        return $command.Source
    }

    $candidates = @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        (Join-Path $env:LocalAppData "Programs\nodejs\node.exe")
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    throw @"
Node.js was not found on this PC.

Install the Windows LTS version of Node.js from:
https://nodejs.org/

Then rerun the headset demo launcher.
"@
}

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
        throw "Could not determine a LAN IPv4 address for headset access."
    } finally {
        $socket.Dispose()
    }
}

$appRoot = Split-Path -Parent $PSScriptRoot
$prototypeRoot = Split-Path -Parent $appRoot
$certRoot = Join-Path $appRoot ".dev-certs"
$nodeExe = Resolve-NodeExecutable
$computerName = $env:COMPUTERNAME
$lanIp = Get-PrimaryIPv4Address
$certInfo = & (Join-Path $PSScriptRoot "ensure_stlouis_dev_cert.ps1") `
    -OutputDirectory $certRoot `
    -HostNames @("localhost", $computerName) `
    -IpAddresses @("127.0.0.1", $lanIp) `
    -TrustCurrentUser:$TrustCurrentUser

$localUrl = "https://localhost:$Port/babylon-vr-faa-map/"
$lanUrl = "https://$lanIp`:$Port/babylon-vr-faa-map/"
$hostUrl = "https://$computerName`:$Port/babylon-vr-faa-map/"

$existingPids = Get-ListeningProcessIdsForPort -Port $Port
if ($existingPids.Count -gt 0) {
    throw "Port $Port is already in use by process ID(s): $($existingPids -join ', '). Stop that listener first."
}

if ($OpenDesktopPreview) {
    Start-Process $localUrl
}

Write-Host "Starting St. Louis headset demo on the foreground HTTPS server."
Write-Host "Keep this PowerShell window open while the headset is using the demo."
Write-Host "Press Ctrl+C here when you want to stop it."
Write-Host ""
Write-Host "Local review URL: $localUrl"
Write-Host "LAN headset URL:  $lanUrl"
Write-Host "Hostname URL:     $hostUrl"
Write-Host "Certificate bundle:"
Write-Host "  PFX file: $($certInfo.CertificatePfx)"
Write-Host "  CER file: $($certInfo.CertificateCer)"
Write-Host ""
Write-Host "If the headset does not trust the certificate yet, install the CER file first."
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
