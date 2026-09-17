[CmdletBinding(DefaultParameterSetName='Archive')]
param(
    [Parameter(ParameterSetName='Archive',Mandatory=$true)][string]$ArchivePath,
    [Parameter(ParameterSetName='Archive',Mandatory=$true)][string]$Sha256,
    [Parameter(ParameterSetName='Download',Mandatory=$true)][string]$ArchiveUrl,
    [Parameter(ParameterSetName='Download',Mandatory=$true)][string]$ExpectedSha256,
    [Parameter(ParameterSetName='Rollback',Mandatory=$true)][switch]$Rollback,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\PrimeAgentWindows'),
    [string]$ManifestUrl,
    [string]$ExpectedCurrent,
    [string]$ExpectedVersion,
    [int]$ExpectedRevision,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432) {
    throw 'The Prime Agent Windows release requires a native x64 host.'
}

$ManagedMarkerName = '.windows-managed'
$ManagedMarkerValue = 'prime-agent-windows-v1'
$Distribution = 'prime-agent-windows'
$Platform = 'windows-x64-baseline'
$StateFileName = 'active.json'
$MaxExpandedBytes = 2GB

function Get-Property($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Assert-NotReparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing reparse point: $Path"
    }
}

function Assert-PathChainNotReparse([string]$Path) {
    $current = $Path
    while ($true) {
        if (Test-Path -LiteralPath $current) { Assert-NotReparse $current }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-SafeName([string]$Name, [string]$What) {
    if ($Name -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$' -or $Name.Contains('..')) {
        throw "Invalid $What recorded in state: $Name"
    }
}

function Read-ReleaseRecord($Record, [string]$What) {
    if ($null -eq $Record) { return $null }
    $directory = Get-Property $Record 'directory'
    $version = Get-Property $Record 'version'
    $revision = Get-Property $Record 'revision'
    $sha = Get-Property $Record 'sha256'
    Assert-SafeName ([string]$directory) "$What directory"
    if ([string]$version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "Invalid $What version recorded in state: $version"
    }
    if (-not ($revision -is [int] -or $revision -is [long]) -or $revision -lt 1 -or $revision -gt [int]::MaxValue) {
        throw "Invalid $What revision recorded in state."
    }
    if ([string]$sha -notmatch '^[0-9a-f]{64}$') {
        throw "Invalid $What sha256 recorded in state."
    }
    return @{ directory = [string]$directory; version = [string]$version; revision = [int]$revision; sha256 = [string]$sha }
}

function Read-ManagedState([string]$Root) {
    $statePath = Join-Path $Root $StateFileName
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    Assert-NotReparse $statePath
    try {
        $parsed = (Get-Content -LiteralPath $statePath -Raw) | ConvertFrom-Json
    } catch {
        throw "Managed state at $statePath is corrupt or foreign; refusing to continue."
    }
    if ($null -eq $parsed -or (Get-Property $parsed 'schema') -ne 1 -or (Get-Property $parsed 'distribution') -ne $Distribution) {
        throw "Managed state at $statePath is corrupt or foreign; refusing to continue."
    }
    $manifest = Get-Property $parsed 'manifestUrl'
    if ($null -ne $manifest) {
        $manifestUri = $manifest -as [uri]
        if ($null -eq $manifestUri -or $manifestUri.Scheme -ne 'https' -or $manifestUri.UserInfo) {
            throw "Managed state at $statePath records an invalid manifest URL."
        }
    }
    $current = Read-ReleaseRecord (Get-Property $parsed 'current') 'current release'
    if ($null -eq $current) { throw "Managed state at $statePath has no current release." }
    $previous = Read-ReleaseRecord (Get-Property $parsed 'previous') 'previous release'
    return @{
        schema = 1
        distribution = $Distribution
        manifestUrl = $manifest
        current = $current
        previous = $previous
    }
}

function Write-ManagedState([string]$Root, $State) {
    $target = Join-Path $Root $StateFileName
    Assert-NotReparseIfExists $target
    $temp = Join-Path $Root (".active-{0}.tmp" -f [guid]::NewGuid().ToString('N'))
    $json = $State | ConvertTo-Json -Depth 8 -Compress
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
    $stream = New-Object System.IO.FileStream($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    if (-not ('PrimeAgentManagedInstall.NativeMove' -as [type])) {
        Add-Type -Namespace PrimeAgentManagedInstall -Name NativeMove -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern bool MoveFileExW(string existing, string replacement, uint flags);
'@
    }
    try {
        if (-not [PrimeAgentManagedInstall.NativeMove]::MoveFileExW($temp, $target, 0x9)) {
            $win32Error = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "Failed to update $StateFileName atomically (Win32 error $win32Error)."
        }
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
}

function Assert-NotReparseIfExists([string]$Path) {
    if (Test-Path -LiteralPath $Path) { Assert-NotReparse $Path }
}

function Assert-HashArgument([string]$Hash, [string]$Name) {
    if ($Hash -notmatch '^[0-9a-f]{64}$') {
        throw "$Name must be exactly 64 lowercase hex characters."
    }
}

function Assert-VersionArgument([string]$Version, [string]$Name) {
    if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "$Name is not a valid version: $Version"
    }
}

function Compare-VersionBase([string]$Left, [string]$Right) {
    $lm = [regex]::Match($Left, '^\d+\.\d+\.\d+')
    $rm = [regex]::Match($Right, '^\d+\.\d+\.\d+')
    if (-not $lm.Success -or -not $rm.Success) { throw "Cannot compare versions '$Left' and '$Right'." }
    return ([version]$lm.Value).CompareTo([version]$rm.Value)
}

function Test-ReleaseDirectoryName([string]$Name) {
    return $Name -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-windows\.\d+-[0-9a-f]{32}$'
}

function Invoke-ExeProbe([string]$Exe, [string]$Arguments) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Exe
    $startInfo.Arguments = $Arguments
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
            throw "Probe '$Arguments' timed out for $Exe"
        }
        $stdout.Wait()
        $stderr.Wait()
        return @{ ExitCode = $process.ExitCode; Stdout = $stdout.Result; Stderr = $stderr.Result }
    } finally {
        $process.Dispose()
    }
}

function Get-ReleaseArchive([string]$Url, [string]$Destination) {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [timespan]::FromMinutes(5)
    $cancel = New-Object System.Threading.CancellationTokenSource([timespan]::FromMinutes(10))
    try {
        $current = $Url
        for ($hop = 0; $hop -le 5; $hop++) {
            $uri = [uri]$current
            if ($uri.Scheme -ne 'https' -or $uri.UserInfo) {
                throw "Refusing non-HTTPS or credentialed archive URL: $current"
            }
            $response = $client.GetAsync($uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).Result
            try {
                $status = [int]$response.StatusCode
                if ($status -ge 300 -and $status -lt 400) {
                    $location = $response.Headers.Location
                    if ($null -eq $location) { throw "Archive download redirect ($status) had no Location header." }
                    $current = (New-Object System.Uri($uri, $location)).AbsoluteUri
                    continue
                }
                if (-not $response.IsSuccessStatusCode) {
                    throw "Archive download failed with HTTP $status."
                }
                $stream = $response.Content.ReadAsStreamAsync().Result
                try {
                    $file = [System.IO.File]::Create($Destination)
                    try {
                        $buffer = New-Object byte[] 65536
                        $total = [long]0
                        while ($true) {
                            $read = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).Result
                            if ($read -le 0) { break }
                            $total += $read
                            if ($total -gt $MaxExpandedBytes) { throw "Archive exceeds the 2GiB size limit." }
                            $file.Write($buffer, 0, $read)
                        }
                    } finally { $file.Dispose() }
                } finally { $stream.Dispose() }
                return
            } finally { $response.Dispose() }
        }
        throw 'Archive download exceeded the redirect limit.'
    } finally {
        $cancel.Dispose()
        $client.Dispose()
    }
}

$ReservedBaseNames = @('CON','PRN','AUX','NUL') + (1..9 | ForEach-Object { "COM$_"; "LPT$_" })

function Expand-ReleaseArchive([string]$Archive, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    $seen = @{}
    $expandedTotal = [long]0
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ($name.IndexOf([char]0) -ge 0) { throw "Archive entry contains a NUL byte: $name" }
            $isDirectory = $name.EndsWith('/') -or $name.EndsWith('\')
            $normalized = $name.Replace('\', '/').TrimEnd('/')
            if ($normalized -eq '' -or $normalized.StartsWith('/')) {
                throw "Archive entry has an invalid root path: $name"
            }
            $components = $normalized -split '/'
            foreach ($component in $components) {
                if ($component -eq '' -or $component -eq '.' -or $component -eq '..') {
                    throw "Archive entry has an unsafe path component: $name"
                }
                if ($component.Contains(':')) {
                    throw "Archive entry contains a drive or stream specifier: $name"
                }
                if ($component.EndsWith('.') -or $component.EndsWith(' ')) {
                    throw "Archive entry has a trailing dot or space component: $name"
                }
                $stem = ($component -split '\.')[0]
                if ($ReservedBaseNames -contains $stem.ToUpperInvariant()) {
                    throw "Archive entry uses a reserved device name: $name"
                }
            }
            $key = $normalized.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { throw "Archive contains duplicate entries differing only by case: $name" }
            $seen[$key] = $true
            if ($entry.ExternalAttributes -band 0x400) {
                throw "Archive entry declares a reparse point: $name"
            }
            $unixMode = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if ($unixMode -ne 0 -and $unixMode -ne 0x8000 -and $unixMode -ne 0x4000) {
                throw "Archive entry declares a symlink or device file: $name"
            }
            if ($isDirectory) {
                New-Item -ItemType Directory -Path (Join-Path $Destination $normalized) -Force | Out-Null
                continue
            }
            $expandedTotal += $entry.Length
            if ($expandedTotal -gt $MaxExpandedBytes) { throw 'Archive expands beyond the 2GiB limit.' }
            $targetPath = Join-Path $Destination $normalized
            $parentPath = [System.IO.Path]::GetDirectoryName($targetPath)
            if (-not (Test-Path -LiteralPath $parentPath)) {
                New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
            }
            $entryStream = $entry.Open()
            try {
                $fileStream = New-Object System.IO.FileStream($targetPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                try {
                    $entryStream.CopyTo($fileStream)
                } finally {
                    $fileStream.Dispose()
                }
            } finally {
                $entryStream.Dispose()
            }
        }
    } finally {
        $zip.Dispose()
    }
}

function Read-ReleaseMetadata([string]$Directory) {
    $markerPath = Join-Path $Directory 'windows-release.json'
    Assert-NotReparse $markerPath
    $marker = (Get-Content -LiteralPath $markerPath -Raw) | ConvertFrom-Json
    if ((Get-Property $marker 'schema') -ne 1 -or
        (Get-Property $marker 'distribution') -ne $Distribution -or
        (Get-Property $marker 'platform') -ne $Platform) {
        throw "Release marker at $markerPath has an unexpected schema, distribution, or platform."
    }
    $version = [string](Get-Property $marker 'version')
    $revision = Get-Property $marker 'revision'
    Assert-VersionArgument $version 'windows-release.json version'
    if (-not ($revision -is [int] -or $revision -is [long]) -or $revision -lt 1 -or $revision -gt [int]::MaxValue) {
        throw 'windows-release.json revision must be a positive integer.'
    }
    return @{ version = $version; revision = [int]$revision }
}

function Assert-ReleaseContents([string]$Directory, $Metadata) {
    Assert-NotReparse $Directory
    $required = @(
        'prime-agent.exe',
        'package.json',
        'windows-release.json',
        'install-windows.ps1',
        'prime-agent.ps1',
        'prime-agent-runtime\pyproject.toml',
        'prime-agent-runtime\src\rlm\repl.py',
        'prime-agent-runtime\src\rlm\bash.py',
        'theme\prime.json',
        'export-html\template.html',
        'photon_rs_bg.wasm',
        'native\koffi\package.json',
        'native\koffi\build\koffi\win32_x64\koffi.node'
    )
    foreach ($name in $required) {
        $path = Join-Path $Directory $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Release archive is missing a required file: $name"
        }
        Assert-NotReparse $path
        $ancestor = [System.IO.Path]::GetDirectoryName($path)
        while ($ancestor -and $ancestor -ne $Directory) {
            Assert-NotReparse $ancestor
            $ancestor = [System.IO.Path]::GetDirectoryName($ancestor)
        }
    }
    $package = (Get-Content -LiteralPath (Join-Path $Directory 'package.json') -Raw) | ConvertFrom-Json
    if ([string](Get-Property $package 'version') -ne $Metadata.version) {
        throw "Release package.json version does not match windows-release.json."
    }
}

function Assert-ReleaseProbe([string]$Directory, [string]$Version) {
    $exe = Join-Path $Directory 'prime-agent.exe'
    $versionProbe = Invoke-ExeProbe $exe '--version'
    if ($versionProbe.ExitCode -ne 0 -or $versionProbe.Stdout.Trim() -ne $Version) {
        throw "Release executable failed its version probe: $($versionProbe.Stderr.Trim())"
    }
    $helpProbe = Invoke-ExeProbe $exe '--help'
    if ($helpProbe.ExitCode -ne 0) {
        throw "Release executable failed its help probe: $($helpProbe.Stderr.Trim())"
    }
    $nativeProbe = Invoke-ExeProbe $exe '--windows-runtime-probe'
    if ($nativeProbe.ExitCode -ne 0 -or $nativeProbe.Stdout.Trim() -ne 'windows-runtime-ok') {
        throw "Release executable failed its native runtime probe: $($nativeProbe.Stderr.Trim())"
    }
}

function Assert-ManagedRoot([string]$Root) {
    Assert-PathChainNotReparse $Root
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $markerPath = Join-Path $Root $ManagedMarkerName
    if (Test-Path -LiteralPath $markerPath) {
        Assert-NotReparse $markerPath
        $marker = (Get-Content -LiteralPath $markerPath -Raw).Trim()
        if ($marker -ne $ManagedMarkerValue) {
            throw "The directory $Root contains an unrecognized $ManagedMarkerName marker; refusing to continue."
        }
        return
    }
    $children = @(Get-ChildItem -LiteralPath $Root -Force)
    if ($children.Count -gt 0) {
        throw "The directory $Root is not empty and is not a managed Prime Agent installation. Choose an empty -InstallDir or remove the directory contents."
    }
}

$rootPath = [System.IO.Path]::GetFullPath($InstallDir)
Assert-ManagedRoot $rootPath

if ($PsCmdlet.ParameterSetName -eq 'Archive') {
    Assert-HashArgument $Sha256 'Sha256'
}
if ($PsCmdlet.ParameterSetName -eq 'Download') {
    Assert-HashArgument $ExpectedSha256 'ExpectedSha256'
    $initialUri = $ArchiveUrl -as [uri]
    if ($null -eq $initialUri -or $initialUri.Scheme -ne 'https' -or $initialUri.UserInfo) {
        throw 'ArchiveUrl must be an HTTPS URL without credentials.'
    }
}
if ($ManifestUrl) {
    $manifestUri = $ManifestUrl -as [uri]
    if ($null -eq $manifestUri -or $manifestUri.Scheme -ne 'https' -or $manifestUri.UserInfo) {
        throw 'ManifestUrl must be an HTTPS URL without credentials.'
    }
}
if ($ExpectedVersion) { Assert-VersionArgument $ExpectedVersion 'ExpectedVersion' }
if ($ExpectedRevision -lt 0) { throw 'ExpectedRevision must be a positive integer.' }

if (-not (Test-Path -LiteralPath $rootPath)) {
    New-Item -ItemType Directory -Path $rootPath -Force | Out-Null
}

$lockPath = Join-Path $rootPath '.install-lock'
Assert-NotReparseIfExists $lockPath
try {
    $lock = New-Object System.IO.FileStream($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
    throw "Another Prime Agent install or update is in progress (the lock $lockPath is held). Wait for it to finish, then retry."
}

$stagingPath = $null
$downloadPath = $null
try {
    $markerPath = Join-Path $rootPath $ManagedMarkerName
    Assert-NotReparseIfExists $markerPath
    if (-not (Test-Path -LiteralPath $markerPath)) {
        [System.IO.File]::WriteAllText($markerPath, $ManagedMarkerValue, (New-Object System.Text.UTF8Encoding($false)))
    }
    $state = Read-ManagedState $rootPath

    if ($ExpectedCurrent) {
        if ($null -eq $state -or $state.current.directory -ne $ExpectedCurrent) {
            throw "The active release no longer matches the expected current release ($ExpectedCurrent). Another update may have already run; check the installation and retry."
        }
    }

    if ($Rollback.IsPresent) {
        if ($null -eq $state -or $null -eq $state.previous) {
            throw 'No previous managed release is available to roll back to.'
        }
        $previousDir = Join-Path $rootPath ('releases\' + $state.previous.directory)
        if (-not (Test-Path -LiteralPath $previousDir -PathType Container)) {
            throw "The previous release directory $($state.previous.directory) is missing."
        }
        $previousMetadata = Read-ReleaseMetadata $previousDir
        if ($previousMetadata.version -ne $state.previous.version -or $previousMetadata.revision -ne $state.previous.revision) {
            throw 'The previous release directory metadata does not match the recorded state.'
        }
        Assert-ReleaseContents $previousDir $previousMetadata
        Assert-ReleaseProbe $previousDir $state.previous.version
        $rolledBack = @{
            schema = 1
            distribution = $Distribution
            manifestUrl = $state.manifestUrl
            current = $state.previous
            previous = $state.current
        }
        Write-ManagedState $rootPath $rolledBack
        Write-Output "Rolled back to Prime Agent $($state.previous.version) (revision $($state.previous.revision))."
        return
    }

    if ($PsCmdlet.ParameterSetName -eq 'Download') {
        $downloadPath = Join-Path $rootPath (".download-{0}.zip" -f [guid]::NewGuid().ToString('N'))
        Get-ReleaseArchive $ArchiveUrl $downloadPath
        $ArchivePath = $downloadPath
        $Sha256 = $ExpectedSha256
    }
    Assert-NotReparse $ArchivePath
    $ArchivePath = (Get-Item -LiteralPath $ArchivePath).FullName
    $actualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $Sha256.ToLowerInvariant()) {
        throw "Archive checksum mismatch: expected $Sha256, got $actualHash."
    }

    $stagingPath = Join-Path $rootPath (".staging-{0}" -f [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stagingPath | Out-Null
    Expand-ReleaseArchive $ArchivePath $stagingPath

    $metadata = Read-ReleaseMetadata $stagingPath
    if ($ExpectedVersion -and $metadata.version -ne $ExpectedVersion) {
        throw "Release version $($metadata.version) does not match the expected version $ExpectedVersion."
    }
    if ($ExpectedRevision -gt 0 -and $metadata.revision -ne $ExpectedRevision) {
        throw "Release revision $($metadata.revision) does not match the expected revision $ExpectedRevision."
    }
    Assert-ReleaseContents $stagingPath $metadata

    if ($null -ne $state) {
        $baseComparison = Compare-VersionBase $metadata.version $state.current.version
        if ($baseComparison -lt 0) {
            throw "Refusing to install $($metadata.version) over the newer $($state.current.version). Use -Rollback to restore the previous release."
        }
        if ($baseComparison -eq 0) {
            if ($metadata.revision -lt $state.current.revision) {
                throw "Refusing to install revision $($metadata.revision) over the newer revision $($state.current.revision). Use -Rollback to restore the previous release."
            }
            if ($metadata.revision -eq $state.current.revision -and -not $Force.IsPresent) {
                Write-Output "Prime Agent $($metadata.version) (revision $($metadata.revision)) is already installed."
                return
            }
        }
    }

    $releasesRoot = Join-Path $rootPath 'releases'
    Assert-NotReparseIfExists $releasesRoot
    if (-not (Test-Path -LiteralPath $releasesRoot)) {
        New-Item -ItemType Directory -Path $releasesRoot | Out-Null
    }
    $releaseName = '{0}-windows.{1}-{2}' -f $metadata.version, $metadata.revision, ([guid]::NewGuid().ToString('N'))
    if (-not (Test-ReleaseDirectoryName $releaseName)) {
        throw 'Generated release directory name failed validation.'
    }
    $finalDir = Join-Path $releasesRoot $releaseName
    Move-Item -LiteralPath $stagingPath -Destination $finalDir
    $stagingPath = $null

    $ps1Launcher = Join-Path $rootPath 'prime-agent.ps1'
    $cmdLauncher = Join-Path $rootPath 'prime-agent.cmd'
    Assert-NotReparseIfExists $ps1Launcher
    Assert-NotReparseIfExists $cmdLauncher
    if (-not (Test-Path -LiteralPath $ps1Launcher)) {
        Copy-Item -LiteralPath (Join-Path $finalDir 'prime-agent.ps1') -Destination $ps1Launcher
    }
    if (-not (Test-Path -LiteralPath $cmdLauncher)) {
        $cmdContents = "@echo off`r`n`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoLogo -NoProfile -File `"%~dp0prime-agent.ps1`" %*`r`nexit /b %errorlevel%`r`n"
        [System.IO.File]::WriteAllText($cmdLauncher, $cmdContents, (New-Object System.Text.ASCIIEncoding))
    }

    Assert-ReleaseProbe $finalDir $metadata.version

    $manifestToPersist = $null
    if ($null -ne $state) { $manifestToPersist = $state.manifestUrl }
    if ($ManifestUrl) { $manifestToPersist = $ManifestUrl }
    $newState = @{
        schema = 1
        distribution = $Distribution
        manifestUrl = $manifestToPersist
        current = @{
            directory = $releaseName
            version = $metadata.version
            revision = $metadata.revision
            sha256 = $actualHash
        }
        previous = $(if ($null -ne $state) { $state.current } else { $null })
    }
    Write-ManagedState $rootPath $newState
    Write-Output "Installed Prime Agent $($metadata.version) (revision $($metadata.revision)) to $finalDir."
} finally {
    if ($null -ne $stagingPath -and (Test-Path -LiteralPath $stagingPath)) {
        Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $downloadPath -and (Test-Path -LiteralPath $downloadPath)) {
        Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
    }
    $lock.Dispose()
}
