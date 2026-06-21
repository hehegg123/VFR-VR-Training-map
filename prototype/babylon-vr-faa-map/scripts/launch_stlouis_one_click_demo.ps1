$ErrorActionPreference = "Stop"
$HttpsPort = 4443

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

Then reopen the launcher and try again.
"@
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
        return $null
    } finally {
        $socket.Dispose()
    }
}

function Find-AvailableStatusPort {
    param(
        [int]$PreferredPort = 4174
    )

    for ($port = $PreferredPort; $port -lt ($PreferredPort + 25); $port++) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        try {
            $listener.Start()
            return $port
        } catch {
            continue
        } finally {
            try { $listener.Stop() } catch {}
        }
    }

    throw "Could not find an available localhost status port."
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

function Quote-ProcessArgument {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    if ($null -eq $Value -or $Value -eq "") {
        return '""'
    }

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    $escaped = $Value `
        -replace '([\\]*)"', '$1$1\\"' `
        -replace '([\\]+)$', '$1$1'

    return '"' + $escaped + '"'
}

function Start-HttpsLinkedReviewServer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NodeExe,
        [Parameter(Mandatory = $true)]
        [string]$ServerScript,
        [Parameter(Mandatory = $true)]
        [string]$PrototypeRoot,
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [Parameter(Mandatory = $true)]
        [string]$PfxFile,
        [Parameter(Mandatory = $true)]
        [string]$Passphrase
    )

    $args = @(
        $ServerScript,
        "--host", "0.0.0.0",
        "--port", "$Port",
        "--directory", $PrototypeRoot,
        "--pfxfile", $PfxFile,
        "--passphrase", $Passphrase
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $NodeExe
    $startInfo.WorkingDirectory = $PrototypeRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.Arguments = ($args | ForEach-Object { Quote-ProcessArgument $_ }) -join " "

    return [System.Diagnostics.Process]::Start($startInfo)
}

function Start-NodeBackgroundProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NodeExe,
        [Parameter(Mandatory = $true)]
        [string]$PrototypeRoot,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $NodeExe
    $startInfo.WorkingDirectory = $PrototypeRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.Arguments = ($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " "

    return [System.Diagnostics.Process]::Start($startInfo)
}

function Wait-ForTcpPort {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address,
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$TimeoutSeconds = 12
    )

    $deadline = [System.DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([System.DateTime]::UtcNow -lt $deadline) {
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $async = $client.BeginConnect($Address, $Port, $null, $null)
            if ($async.AsyncWaitHandle.WaitOne(600) -and $client.Connected) {
                $client.EndConnect($async)
                return $true
            }
        } catch {
        } finally {
            $client.Dispose()
        }

        Start-Sleep -Milliseconds 250
    }

    return $false
}

$appRoot = Split-Path -Parent $PSScriptRoot
$prototypeRoot = Split-Path -Parent $appRoot
$certRoot = Join-Path $appRoot ".dev-certs"
$logsRoot = Join-Path $appRoot ".logs"
[System.IO.Directory]::CreateDirectory($logsRoot) | Out-Null
$launchLogPath = Join-Path $logsRoot "one-click-demo-launch.log"
$nodeExe = Resolve-NodeExecutable
$computerName = $env:COMPUTERNAME
$lanIp = Get-PrimaryIPv4Address
$certInfo = & (Join-Path $PSScriptRoot "ensure_stlouis_dev_cert.ps1") `
    -OutputDirectory $certRoot `
    -HostNames @("localhost", $computerName) `
    -IpAddresses @("127.0.0.1", $lanIp)

$vrLanUrl = if ($lanIp) { "https://$lanIp`:$HttpsPort/babylon-vr-faa-map/" } else { $null }
$desktopLanUrl = if ($lanIp) { "https://$lanIp`:$HttpsPort/faa-2d-map/" } else { $null }
$statusPort = Find-AvailableStatusPort
$statusUrl = "http://localhost:$statusPort/"

$existing = Get-ListeningProcessIdsForPort -Port $HttpsPort
if (-not $existing.Count) {
    $httpsServerScript = Join-Path $appRoot "tools\serve_https.cjs"
    $server = Start-HttpsLinkedReviewServer `
        -NodeExe $nodeExe `
        -ServerScript $httpsServerScript `
        -PrototypeRoot $prototypeRoot `
        -Port $HttpsPort `
        -PfxFile $certInfo.CertificatePfx `
        -Passphrase $certInfo.PfxPassword

    if (-not (Wait-ForTcpPort -Address "127.0.0.1" -Port $HttpsPort -TimeoutSeconds 12)) {
        if ($server -and -not $server.HasExited) {
            try { $server.Kill() } catch {}
        }

        throw "HTTPS linked review server did not become ready on port $HttpsPort."
    }

    Write-Host "Started HTTPS linked review server (PID $($server.Id))."
} else {
    if (-not (Wait-ForTcpPort -Address "127.0.0.1" -Port $HttpsPort -TimeoutSeconds 3)) {
        throw "Port $HttpsPort is already listening, but the HTTPS session did not become reachable."
    }

    Write-Host "HTTPS linked review server already running on port $HttpsPort."
}

$statusServerScript = Join-Path $appRoot "tools\serve_session_status.cjs"
$stopScript = Join-Path $PSScriptRoot "stop_stlouis_prototype.ps1"
$statusArgs = @(
    $statusServerScript,
    "--port", "$statusPort",
    "--vrUrl", $vrLanUrl,
    "--desktopUrl", $desktopLanUrl,
    "--stopScript", $stopScript
)
$statusServer = Start-NodeBackgroundProcess `
    -NodeExe $nodeExe `
    -PrototypeRoot $prototypeRoot `
    -Arguments $statusArgs

if (-not (Wait-ForTcpPort -Address "127.0.0.1" -Port $statusPort -TimeoutSeconds 12)) {
    if ($statusServer -and -not $statusServer.HasExited) {
        try { $statusServer.Kill() } catch {}
    }

    throw "Session status page did not become ready on port $statusPort."
}

Start-Process $statusUrl

Write-Host "Opened one-click St. Louis demo status page at $statusUrl"
Write-Host "LAN VR URL: $vrLanUrl"
Write-Host "LAN Desktop URL: $desktopLanUrl"
Write-Host "Certificate CER: $($certInfo.CertificateCer)"
Write-Host "Use the status page Stop Session button, or close with .\prototype\babylon-vr-faa-map\scripts\stop_stlouis_prototype.ps1"

@(
    "Status URL: $statusUrl"
    "LAN VR URL: $vrLanUrl"
    "LAN Desktop URL: $desktopLanUrl"
    "Certificate CER: $($certInfo.CertificateCer)"
    "Generated: $(Get-Date -Format o)"
) | Set-Content -LiteralPath $launchLogPath -Encoding UTF8
