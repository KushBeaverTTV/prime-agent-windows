[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [Parameter(Mandatory=$true)][string]$Sha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PS51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PS51 -PathType Leaf)) { throw "Windows PowerShell 5.1 not found at $PS51" }
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $RepoRoot 'install-windows.ps1'
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "Installer not found at $Installer" }
$ArchivePath = (Get-Item -LiteralPath $ArchivePath).FullName
if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Sha256 must be 64 hex characters.' }
$Sha256 = $Sha256.ToLowerInvariant()
if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
    throw 'The supplied archive does not match the supplied Sha256.'
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Read-ArchiveMarker([string]$ZipPath) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq 'windows-release.json' } | Select-Object -First 1
        if ($null -eq $entry) { throw "Archive $ZipPath has no windows-release.json marker." }
        $stream = $entry.Open()
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
    } finally { $zip.Dispose() }
}

$marker = Read-ArchiveMarker $ArchivePath
$baseVersion = [string]$marker.version
$baseRevision = [int]$marker.revision
if ($baseVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or $baseRevision -lt 1) {
    throw "Archive marker has an invalid baseline version or revision: $baseVersion/$baseRevision"
}

$script:Pass = 0
$script:Fail = 0
function Record([string]$Name, [bool]$Ok) {
    if ($Ok) { Write-Output "PASS  $Name"; $script:Pass++ } else { Write-Output "FAIL  $Name"; $script:Fail++ }
}
function Invoke-Native([string]$File, [string[]]$CmdArgs) {
    $ErrorActionPreference = 'Continue'
    $output = & $File @CmdArgs 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Text = $output }
}
function Invoke-Installer([string[]]$CmdArgs) {
    return Invoke-Native $PS51 (@('-NoProfile', '-File', $Installer) + $CmdArgs)
}
function Invoke-CmdLauncher([string]$Root, [string[]]$CmdArgs) {
    return Invoke-Native (Join-Path $Root 'prime-agent.cmd') $CmdArgs
}
function Invoke-Ps1Launcher([string]$Root, [string[]]$CmdArgs) {
    return Invoke-Native $PS51 (@('-NoProfile', '-File', (Join-Path $Root 'prime-agent.ps1')) + $CmdArgs)
}
function Read-State([string]$Root) {
    return (Get-Content -LiteralPath (Join-Path $Root 'active.json') -Raw) | ConvertFrom-Json
}
function New-ZipFromDirectory([string]$Source, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination)
}
function Write-ZipEntry($Zip, [string]$Name, [string]$Content, [int]$ExternalAttributes = 0) {
    $entry = $Zip.CreateEntry($Name)
    if ($ExternalAttributes -ne 0) { $entry.ExternalAttributes = $ExternalAttributes }
    $entryStream = $entry.Open()
    try {
        $writer = New-Object System.IO.StreamWriter($entryStream)
        try { $writer.Write($Content) } finally { $writer.Dispose() }
    } finally { $entryStream.Dispose() }
}
function New-CraftedZip([string]$Destination, [scriptblock]$Populate) {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    $stream = [System.IO.File]::Create($Destination)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try { & $Populate $zip } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
}
function Hash-Of([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$envBefore = @{ PRIME_AGENT_WINDOWS_INSTALL_DIR = $env:PRIME_AGENT_WINDOWS_INSTALL_DIR; PRIME_AGENT_LAUNCHER_PATH = $env:PRIME_AGENT_LAUNCHER_PATH; PRIME_AGENT_WINDOWS_DESKTOP_DIR = $env:PRIME_AGENT_WINDOWS_DESKTOP_DIR }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("prime-install-test-{0}" -f [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$root = Join-Path $work 'install root ünïcodé'
New-Item -ItemType Directory -Path $root | Out-Null
$root2 = Join-Path $work 'second root'
New-Item -ItemType Directory -Path $root2 | Out-Null
$desktop = Join-Path $work 'desktop'
New-Item -ItemType Directory -Path $desktop | Out-Null

function Read-Shortcut([string]$LinkPath) {
    $shell = New-Object -ComObject WScript.Shell
    return $shell.CreateShortcut($LinkPath)
}

try {
    $env:PRIME_AGENT_WINDOWS_DESKTOP_DIR = $desktop
    $result = Invoke-Installer @('-ArchivePath', $ArchivePath, '-Sha256', $Sha256, '-InstallDir', $root)
    Record 'initial install exits zero' ($result.Code -eq 0)
    $state = Read-State $root
    Record 'state has schema 1 and windows distribution' ($state.schema -eq 1 -and $state.distribution -eq 'prime-agent-windows')
    Record "initial current is version $baseVersion revision $baseRevision" ($state.current.version -eq $baseVersion -and $state.current.revision -eq $baseRevision)
    Record 'initial previous is null' ($null -eq $state.previous)
    $rev1Dir = $state.current.directory
    Record 'release directory exists' (Test-Path -LiteralPath (Join-Path $root "releases\$rev1Dir") -PathType Container)
    Record 'managed marker written' ((Get-Content -LiteralPath (Join-Path $root '.windows-managed') -Raw).Trim() -eq 'prime-agent-windows-v1')

    $cmdLauncher = Join-Path $root 'prime-agent.cmd'
    $ps1Launcher = Join-Path $root 'prime-agent.ps1'
    Record 'cmd launcher exists' (Test-Path -LiteralPath $cmdLauncher -PathType Leaf)
    Record 'ps1 launcher exists' (Test-Path -LiteralPath $ps1Launcher -PathType Leaf)
    $versionResult = Invoke-CmdLauncher $root @('--version')
    Record "cmd launcher --version reports $baseVersion" ($versionResult.Code -eq 0 -and $versionResult.Text.Trim() -eq $baseVersion)
    $helpResult = Invoke-CmdLauncher $root @('--help')
    Record 'cmd launcher --help exits zero with usage' ($helpResult.Code -eq 0 -and $helpResult.Text -match 'Usage')
    $ps1VersionResult = Invoke-Ps1Launcher $root @('--version')
    Record "ps1 launcher --version reports $baseVersion" ($ps1VersionResult.Code -eq 0 -and $ps1VersionResult.Text.Trim() -eq $baseVersion)

    Record 'prime-agent.ico copied to install root' (Test-Path -LiteralPath (Join-Path $root 'prime-agent.ico') -PathType Leaf)
    Record 'prime-agent-dashboard.ico copied to install root' (Test-Path -LiteralPath (Join-Path $root 'prime-agent-dashboard.ico') -PathType Leaf)
    $mainShortcutPath = Join-Path $desktop 'Prime Agent.lnk'
    $dashboardShortcutPath = Join-Path $desktop 'Prime Agent Dashboard.lnk'
    Record 'Prime Agent desktop shortcut created' (Test-Path -LiteralPath $mainShortcutPath -PathType Leaf)
    Record 'Prime Agent Dashboard desktop shortcut created' (Test-Path -LiteralPath $dashboardShortcutPath -PathType Leaf)
    $dashboardShortcut = Read-Shortcut $dashboardShortcutPath
    Record 'dashboard shortcut invokes prime-agent.ps1 agents' ($dashboardShortcut.Arguments -match 'prime-agent\.ps1" agents$')
    Record 'dashboard shortcut uses the dashboard icon' ($dashboardShortcut.IconLocation -like "*prime-agent-dashboard.ico*")

    $sentinelRoot = Join-Path $root 'preexisting user file ünïcodé.txt'
    [System.IO.File]::WriteAllText($sentinelRoot, 'keep me')
    $sentinelRelease = Join-Path $root "releases\$rev1Dir\preexisting-release-file.txt"
    [System.IO.File]::WriteAllText($sentinelRelease, 'keep me')
    $cmdHashBefore = Hash-Of $cmdLauncher
    $activeBefore = [System.IO.File]::ReadAllText((Join-Path $root 'active.json'))

    $result = Invoke-Installer @('-ArchivePath', $ArchivePath, '-Sha256', ('0' * 64), '-InstallDir', $root)
    Record 'corrupt hash rejected with nonzero exit' ($result.Code -ne 0 -and $result.Text -match 'checksum mismatch')

    $traversalZip = Join-Path $work 'traversal.zip'
    New-CraftedZip $traversalZip {
        param($zip)
        Write-ZipEntry $zip '..\escape.txt' 'x'
        Write-ZipEntry $zip 'windows-release.json' ('{"schema":1,"distribution":"prime-agent-windows","platform":"windows-x64-baseline","version":"' + $baseVersion + '","revision":' + ($baseRevision + 1) + '}')
    }.GetNewClosure()
    $result = Invoke-Installer @('-ArchivePath', $traversalZip, '-Sha256', (Hash-Of $traversalZip), '-InstallDir', $root)
    Record 'traversal archive rejected with nonzero exit' ($result.Code -ne 0 -and $result.Text -match 'unsafe path component')
    Record 'traversal did not write outside staging' (-not (Test-Path -LiteralPath (Join-Path $root 'escape.txt')))

    $duplicateZip = Join-Path $work 'duplicate.zip'
    New-CraftedZip $duplicateZip {
        param($zip)
        Write-ZipEntry $zip 'a/b.txt' 'x'
        Write-ZipEntry $zip 'a\b.txt' 'y'
    }.GetNewClosure()
    $result = Invoke-Installer @('-ArchivePath', $duplicateZip, '-Sha256', (Hash-Of $duplicateZip), '-InstallDir', $root)
    Record 'duplicate slash/backslash archive rejected' ($result.Code -ne 0 -and $result.Text -match 'duplicate')

    $reparseZip = Join-Path $work 'reparse.zip'
    New-CraftedZip $reparseZip {
        param($zip)
        Write-ZipEntry $zip 'evil.txt' 'x' 0x400
    }.GetNewClosure()
    $result = Invoke-Installer @('-ArchivePath', $reparseZip, '-Sha256', (Hash-Of $reparseZip), '-InstallDir', $root)
    Record 'DOS reparse attribute archive rejected' ($result.Code -ne 0 -and $result.Text -match 'reparse')

    $adsZip = Join-Path $work 'ads.zip'
    New-CraftedZip $adsZip {
        param($zip)
        Write-ZipEntry $zip 'file.txt:hidden' 'x'
    }.GetNewClosure()
    $result = Invoke-Installer @('-ArchivePath', $adsZip, '-Sha256', (Hash-Of $adsZip), '-InstallDir', $root)
    Record 'alternate-stream archive rejected' ($result.Code -ne 0 -and $result.Text -match 'stream specifier')

    $reservedZip = Join-Path $work 'reserved.zip'
    New-CraftedZip $reservedZip {
        param($zip)
        Write-ZipEntry $zip 'aux.txt' 'x'
    }.GetNewClosure()
    $result = Invoke-Installer @('-ArchivePath', $reservedZip, '-Sha256', (Hash-Of $reservedZip), '-InstallDir', $root)
    Record 'reserved device name archive rejected' ($result.Code -ne 0 -and $result.Text -match 'reserved device name')

    $symlinkModeZip = Join-Path $work 'symlinkmode.zip'
    New-CraftedZip $symlinkModeZip {
        param($zip)
        Write-ZipEntry $zip 'link.txt' 'x' (0xA000 -shl 16)
    }.GetNewClosure()
    $result = Invoke-Installer @('-ArchivePath', $symlinkModeZip, '-Sha256', (Hash-Of $symlinkModeZip), '-InstallDir', $root)
    Record 'unix symlink mode archive rejected' ($result.Code -ne 0 -and $result.Text -match 'symlink or device')

    $wrongMeta = Join-Path $work 'wrongmeta-src'
    New-Item -ItemType Directory -Path $wrongMeta | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $wrongMeta 'windows-release.json'), ('{"schema":1,"distribution":"other-dist","platform":"windows-x64-baseline","version":"' + $baseVersion + '","revision":' + ($baseRevision + 1) + '}'))
    $wrongMetaZip = Join-Path $work 'wrongmeta.zip'
    New-ZipFromDirectory $wrongMeta $wrongMetaZip
    $result = Invoke-Installer @('-ArchivePath', $wrongMetaZip, '-Sha256', (Hash-Of $wrongMetaZip), '-InstallDir', $root)
    Record 'wrong metadata rejected with nonzero exit' ($result.Code -ne 0 -and $result.Text -match 'distribution')

    $missingFile = Join-Path $work 'missing-src'
    New-Item -ItemType Directory -Path $missingFile | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $missingFile 'windows-release.json'), ('{"schema":1,"distribution":"prime-agent-windows","platform":"windows-x64-baseline","version":"' + $baseVersion + '","revision":' + ($baseRevision + 1) + '}'))
    [System.IO.File]::WriteAllText((Join-Path $missingFile 'package.json'), ('{"name":"prime-agent","version":"' + $baseVersion + '"}'))
    Copy-Item -LiteralPath $Installer -Destination (Join-Path $missingFile 'install-windows.ps1')
    Copy-Item -LiteralPath $ps1Launcher -Destination (Join-Path $missingFile 'prime-agent.ps1')
    $missingZip = Join-Path $work 'missing.zip'
    New-ZipFromDirectory $missingFile $missingZip
    $result = Invoke-Installer @('-ArchivePath', $missingZip, '-Sha256', (Hash-Of $missingZip), '-InstallDir', $root)
    Record 'missing required file rejected with nonzero exit' ($result.Code -ne 0 -and $result.Text -match 'missing a required file')

    $result = Invoke-Installer @('-ArchivePath', $ArchivePath, '-Sha256', $Sha256, '-InstallDir', $root, '-ExpectedCurrent', '0.0.0-windows.1-00000000000000000000000000000000')
    Record 'stale ExpectedCurrent rejected with nonzero exit' ($result.Code -ne 0 -and $result.Text -match 'expected current')

    $lockPath = Join-Path $root '.install-lock'
    $heldLock = New-Object System.IO.FileStream($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
        $result = Invoke-Installer @('-ArchivePath', $ArchivePath, '-Sha256', $Sha256, '-InstallDir', $root)
        Record 'externally held lock rejected with nonzero exit' ($result.Code -ne 0 -and $result.Text -match 'lock')
    } finally {
        $heldLock.Dispose()
    }

    Record 'active.json unchanged after failures' ([System.IO.File]::ReadAllText((Join-Path $root 'active.json')) -eq $activeBefore)
    Record 'no staging leftovers after failures' (@(Get-ChildItem -LiteralPath $root -Force -Filter '.staging-*').Count -eq 0)
    Record 'preexisting root file preserved' ([System.IO.File]::ReadAllText($sentinelRoot) -eq 'keep me')
    Record 'preexisting release file preserved' ([System.IO.File]::ReadAllText($sentinelRelease) -eq 'keep me')

    $rev2Src = Join-Path $work 'rev2-src'
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $rev2Src)
    $markerFile = Join-Path $rev2Src 'windows-release.json'
    $rev2Marker = (Get-Content -LiteralPath $markerFile -Raw) | ConvertFrom-Json
    $rev2Marker.revision = $baseRevision + 1
    [System.IO.File]::WriteAllText($markerFile, ($rev2Marker | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $rev2Zip = Join-Path $work 'rev2.zip'
    New-ZipFromDirectory $rev2Src $rev2Zip
    $rev2Hash = Hash-Of $rev2Zip
    $result = Invoke-Installer @('-ArchivePath', $rev2Zip, '-Sha256', $rev2Hash, '-InstallDir', $root, '-ExpectedVersion', $baseVersion, '-ExpectedRevision', ($baseRevision + 1))
    Record 'second revision install exits zero' ($result.Code -eq 0)
    $state = Read-State $root
    Record 'current is now the new revision' ($state.current.revision -eq ($baseRevision + 1))
    Record 'previous records the baseline directory' ($state.previous.directory -eq $rev1Dir -and $state.previous.revision -eq $baseRevision)
    $rev2Dir = $state.current.directory
    Record 'new revision directory differs and exists' ($rev2Dir -ne $rev1Dir -and (Test-Path -LiteralPath (Join-Path $root "releases\$rev2Dir") -PathType Container))
    Record 'stable cmd launcher not rewritten' ((Hash-Of $cmdLauncher) -eq $cmdHashBefore)
    Record 'sentinel files still preserved after update' ((Test-Path -LiteralPath $sentinelRoot) -and (Test-Path -LiteralPath $sentinelRelease))

    $result = Invoke-Installer @('-ArchivePath', $rev2Zip, '-Sha256', $rev2Hash, '-InstallDir', $root)
    Record 'same revision reinstall is a no-op' ($result.Code -eq 0 -and $result.Text -match 'already installed')

    $junctionOutside = Join-Path $work 'junction-target'
    New-Item -ItemType Directory -Path (Join-Path $junctionOutside 'koffi\build\koffi\win32_x64') -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $junctionOutside 'koffi\package.json'), '{}')
    [System.IO.File]::WriteAllText((Join-Path $junctionOutside 'koffi\build\koffi\win32_x64\koffi.node'), 'MZ')
    $junctionPath = Join-Path $root "releases\$rev1Dir\native"
    Move-Item -LiteralPath $junctionPath -Destination (Join-Path $work 'native-backup')
    New-Item -ItemType Junction -Path $junctionPath -Target $junctionOutside | Out-Null
    $result = Invoke-Installer @('-Rollback', '-InstallDir', $root)
    Record 'rollback over nested junction rejected' ($result.Code -ne 0 -and $result.Text -match 'reparse')
    $state = Read-State $root
    Record 'state unchanged after junction rollback failure' ($state.current.directory -eq $rev2Dir)
    [System.IO.Directory]::Delete($junctionPath)
    Move-Item -LiteralPath (Join-Path $work 'native-backup') -Destination $junctionPath

    $result = Invoke-Installer @('-Rollback', '-InstallDir', $root)
    Record 'first rollback exits zero' ($result.Code -eq 0)
    $state = Read-State $root
    Record 'first rollback restores baseline as current' ($state.current.revision -eq $baseRevision -and $state.current.directory -eq $rev1Dir)
    Record 'first rollback demotes new revision to previous' ($state.previous.revision -eq ($baseRevision + 1) -and $state.previous.directory -eq $rev2Dir)

    $result = Invoke-Installer @('-Rollback', '-InstallDir', $root)
    Record 'second rollback exits zero' ($result.Code -eq 0)
    $state = Read-State $root
    Record 'second rollback restores new revision as current' ($state.current.revision -eq ($baseRevision + 1) -and $state.current.directory -eq $rev2Dir)
    Record 'second rollback demotes baseline to previous' ($state.previous.revision -eq $baseRevision -and $state.previous.directory -eq $rev1Dir)
    Record 'icons still present after rollbacks' ((Test-Path -LiteralPath (Join-Path $root 'prime-agent.ico') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $root 'prime-agent-dashboard.ico') -PathType Leaf))
    Record 'shortcuts still present after rollbacks' ((Test-Path -LiteralPath $mainShortcutPath -PathType Leaf) -and (Test-Path -LiteralPath $dashboardShortcutPath -PathType Leaf))

    $versionResult = Invoke-CmdLauncher $root @('--version')
    Record "launcher still reports $baseVersion after rollbacks" ($versionResult.Code -eq 0 -and $versionResult.Text.Trim() -eq $baseVersion)

    [System.IO.File]::WriteAllText((Join-Path $root2 'unrelated.txt'), 'not managed')
    $result = Invoke-Installer @('-ArchivePath', $ArchivePath, '-Sha256', $Sha256, '-InstallDir', $root2)
    Record 'nonempty unmanaged root refused' ($result.Code -ne 0 -and $result.Text -match 'not a managed')
    Record 'unrelated file left in place' ([System.IO.File]::ReadAllText((Join-Path $root2 'unrelated.txt')) -eq 'not managed')

    Remove-Item -LiteralPath (Join-Path $root2 'unrelated.txt') -Force
    $result = Invoke-Installer @('-ArchivePath', $ArchivePath, '-Sha256', $Sha256, '-InstallDir', $root2)
    Record 'install into emptied root exits zero' ($result.Code -eq 0)
    $result = Invoke-Installer @('-Rollback', '-InstallDir', $root2)
    Record 'rollback with no previous release refused' ($result.Code -ne 0 -and $result.Text -match 'previous')
} finally {
    $env:PRIME_AGENT_WINDOWS_DESKTOP_DIR = $envBefore.PRIME_AGENT_WINDOWS_DESKTOP_DIR
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Record 'caller environment unchanged' ($env:PRIME_AGENT_WINDOWS_INSTALL_DIR -eq $envBefore.PRIME_AGENT_WINDOWS_INSTALL_DIR -and $env:PRIME_AGENT_LAUNCHER_PATH -eq $envBefore.PRIME_AGENT_LAUNCHER_PATH -and $env:PRIME_AGENT_WINDOWS_DESKTOP_DIR -eq $envBefore.PRIME_AGENT_WINDOWS_DESKTOP_DIR)
Record 'test root removed' (-not (Test-Path -LiteralPath $work))

Write-Output ""
Write-Output "$script:Pass passed, $script:Fail failed"
if ($script:Fail -gt 0) { exit 1 }
