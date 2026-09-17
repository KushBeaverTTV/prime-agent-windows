$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$state = Get-Content -LiteralPath (Join-Path $root 'active.json') -Raw | ConvertFrom-Json
if ($state.schema -ne 1 -or $state.distribution -ne 'prime-agent-windows') {
    throw 'This installation is damaged: active.json has an unexpected schema or distribution.'
}
$directory = [string]$state.current.directory
if ($directory -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$' -or $directory.Contains('..')) {
    throw 'This installation is damaged: active.json records an unsafe release directory.'
}
$releaseDir = Join-Path $root ('releases\' + $directory)
foreach ($path in @((Join-Path $root 'releases'), $releaseDir)) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "This installation is damaged: $path is a reparse point."
    }
}
$exe = Join-Path $releaseDir 'prime-agent.exe'
$item = Get-Item -LiteralPath $exe -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "This installation is damaged: $exe is a reparse point."
}
$env:PRIME_AGENT_WINDOWS_INSTALL_DIR = $root
$env:PRIME_AGENT_LAUNCHER_PATH = Join-Path $root 'prime-agent.cmd'
& $exe @args
exit $LASTEXITCODE
