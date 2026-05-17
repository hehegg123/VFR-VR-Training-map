param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string[]]$HostNames = @("localhost"),
    [string[]]$IpAddresses = @("127.0.0.1"),
    [string]$BaseName = "stlouis-demo-dev",
    [switch]$Force,
    [switch]$TrustCurrentUser
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Security

$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

$pfxPath = Join-Path $OutputDirectory "$BaseName.pfx"
$cerPath = Join-Path $OutputDirectory "$BaseName.cer"
$metaPath = Join-Path $OutputDirectory "$BaseName.json"

$normalizedHosts = @($HostNames | Where-Object { $_ } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique)
$normalizedIps = @($IpAddresses | Where-Object { $_ } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique)

$desiredMeta = [ordered]@{
    hostNames = $normalizedHosts
    ipAddresses = $normalizedIps
}

$needsRefresh = $Force.IsPresent -or -not (
    (Test-Path $pfxPath) -and
    (Test-Path $cerPath) -and
    (Test-Path $metaPath)
)

$pfxPassword = $null
if (-not $needsRefresh) {
    try {
        $existingMeta = Get-Content $metaPath -Raw | ConvertFrom-Json
        $existingHosts = @($existingMeta.hostNames | Sort-Object -Unique)
        $existingIps = @($existingMeta.ipAddresses | Sort-Object -Unique)
        $pfxPassword = $existingMeta.pfxPassword
        if (
            (@($existingHosts) -join "|") -ne (@($normalizedHosts) -join "|") -or
            (@($existingIps) -join "|") -ne (@($normalizedIps) -join "|") -or
            -not $pfxPassword
        ) {
            $needsRefresh = $true
        }
    } catch {
        $needsRefresh = $true
    }
}

if ($needsRefresh) {
    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    try {
        $subject = "CN=$($normalizedHosts[0])"
        $dn = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($subject)
        $hashAlgorithm = [System.Security.Cryptography.HashAlgorithmName]::SHA256
        $padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new($dn, $rsa, $hashAlgorithm, $padding)

        $request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $false)
        )
        $request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
                [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
                $false
            )
        )
        $request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false)
        )

        $sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        foreach ($name in $normalizedHosts) {
            $sanBuilder.AddDnsName($name)
        }
        foreach ($ipText in $normalizedIps) {
            $ipAddress = [System.Net.IPAddress]::Parse($ipText)
            $sanBuilder.AddIpAddress($ipAddress)
        }
        $request.CertificateExtensions.Add($sanBuilder.Build())

        $notBefore = [System.DateTimeOffset]::UtcNow.AddDays(-1)
        $notAfter = [System.DateTimeOffset]::UtcNow.AddYears(2)
        $certificate = $request.CreateSelfSigned($notBefore, $notAfter)
        $pfxPassword = [Guid]::NewGuid().ToString("N")
        [System.IO.File]::WriteAllBytes(
            $pfxPath,
            $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pfxPassword)
        )
        [System.IO.File]::WriteAllBytes($cerPath, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
        $meta = [ordered]@{
            hostNames = $normalizedHosts
            ipAddresses = $normalizedIps
            pfxPassword = $pfxPassword
        }
        $meta | ConvertTo-Json | Set-Content -Path $metaPath -Encoding UTF8
    } finally {
        $rsa.Dispose()
    }
}

if ($TrustCurrentUser) {
    Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
}

[PSCustomObject]@{
    CertificatePfx = $pfxPath
    PfxPassword = $pfxPassword
    CertificateCer = $cerPath
    MetadataPath = $metaPath
    HostNames = $normalizedHosts
    IpAddresses = $normalizedIps
}
