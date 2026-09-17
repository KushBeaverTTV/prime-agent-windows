[CmdletBinding()]
param(
    [string]$OutputDir,
    [int]$Revision = 1,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $OutputDir) { $OutputDir = Join-Path $PSScriptRoot '..\artifacts\windows' }
if ($Revision -lt 1) { throw 'Revision must be a positive integer.' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432) {
    throw 'Windows release packaging requires a native x64 host.'
}

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageDir = Join-Path $root 'packages\coding-agent'
$binaryDir = Join-Path $packageDir 'binaries\windows-x64-baseline'
$outputRoot = [System.IO.Path]::GetFullPath($OutputDir)

$package = (Get-Content -LiteralPath (Join-Path $packageDir 'package.json') -Raw) | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Unexpected package version: $version"
}

$archiveName = "prime-agent-$version-windows-x64-baseline-$Revision.zip"
$archivePath = Join-Path $outputRoot $archiveName
if (Test-Path -LiteralPath $archivePath) {
    throw "Refusing to overwrite existing archive: $archivePath"
}

if (-not $SkipBuild.IsPresent) {
    & node (Join-Path $packageDir 'scripts\build-binary.mjs') --platform windows-x64-baseline
    if ($LASTEXITCODE -ne 0) { throw "build-binary.mjs exited with code $LASTEXITCODE" }
}

$exe = Join-Path $binaryDir 'prime-agent.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "No compiled binary at $exe; run without -SkipBuild first."
}

Copy-Item -LiteralPath (Join-Path $root 'install-windows.ps1') -Destination (Join-Path $binaryDir 'install-windows.ps1') -Force
Copy-Item -LiteralPath (Join-Path $root 'prime-agent.ps1') -Destination (Join-Path $binaryDir 'prime-agent.ps1') -Force

$commit = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'git rev-parse HEAD failed' }
$buildId = (& git -C $root describe --always --dirty).Trim()
if ($LASTEXITCODE -ne 0) { throw 'git describe failed' }

$metadata = [ordered]@{
    schema = 1
    distribution = 'prime-agent-windows'
    platform = 'windows-x64-baseline'
    version = $version
    revision = $Revision
    upstreamCommit = $commit
    buildId = $buildId
}
[System.IO.File]::WriteAllText(
    (Join-Path $binaryDir 'windows-release.json'),
    ($metadata | ConvertTo-Json -Compress),
    (New-Object System.Text.UTF8Encoding($false))
)

function Invoke-ExeProbe([string]$Path, [string]$Arguments, [string]$WorkingDirectory) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Path
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            try { $process.Kill() } catch {}
            throw "Probe '$Arguments' timed out for $Path"
        }
        $stdout.Wait(); $stderr.Wait()
        return @{ ExitCode = $process.ExitCode; Stdout = $stdout.Result; Stderr = $stderr.Result }
    } finally {
        $process.Dispose()
    }
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$versionProbe = Invoke-ExeProbe $exe '--version' $outputRoot
if ($versionProbe.ExitCode -ne 0 -or $versionProbe.Stdout.Trim() -ne $version) {
    throw "prime-agent.exe --version reported '$($versionProbe.Stdout.Trim())', expected '$version'. $($versionProbe.Stderr.Trim())"
}
$helpProbe = Invoke-ExeProbe $exe '--help' $outputRoot
if ($helpProbe.ExitCode -ne 0) {
    throw "prime-agent.exe --help failed: $($helpProbe.Stderr.Trim())"
}
$nativeProbe = Invoke-ExeProbe $exe '--windows-runtime-probe' $outputRoot
if ($nativeProbe.ExitCode -ne 0 -or $nativeProbe.Stdout.Trim() -ne 'windows-runtime-ok') {
    throw "prime-agent.exe --windows-runtime-probe failed: $($nativeProbe.Stderr.Trim())"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($binaryDir, $archivePath, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()

$manifest = [ordered]@{
    schema = 1
    distribution = 'prime-agent-windows'
    platform = 'windows-x64-baseline'
    version = $version
    revision = $Revision
    file = $archiveName
    sha256 = $sha256
}
[System.IO.File]::WriteAllText(
    (Join-Path $outputRoot 'windows.json'),
    ($manifest | ConvertTo-Json -Compress),
    (New-Object System.Text.UTF8Encoding($false))
)
Copy-Item -LiteralPath (Join-Path $root 'install-windows.ps1') -Destination (Join-Path $outputRoot 'install-windows.ps1') -Force
$installerSha256 = (Get-FileHash -LiteralPath (Join-Path $outputRoot 'install-windows.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(
    (Join-Path $outputRoot 'SHA256SUMS'),
    "$sha256  $archiveName`n$installerSha256  install-windows.ps1`n",
    (New-Object System.Text.ASCIIEncoding)
)

Write-Output "Binary directory: $binaryDir"
Write-Output "Archive: $archivePath"
Write-Output "SHA256: $sha256"
