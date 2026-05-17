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

$ports = @(4173, 4443)
$pids = foreach ($port in $ports) {
    Get-ListeningProcessIdsForPort -Port $port
}

if (-not $pids) {
    Write-Host "No St. Louis demo server is listening on ports $($ports -join ', ')."
    return
}

foreach ($processId in ($pids | Sort-Object -Unique)) {
    Stop-Process -Id $processId -Force
    Write-Host "Stopped prototype server process $processId."
}
