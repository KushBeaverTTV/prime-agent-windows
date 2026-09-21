<#
.SYNOPSIS
    Offline fixture tests for scripts/sync-upstream.ps1.

.DESCRIPTION
    Builds temporary git repos (bare "upstream" + bare "fork" + working port
    repo) and exercises the sync pipeline end to end without touching the real
    repo, the real GitHub remotes, or the real install root.

    Case 6 uses the real prime-agent.cmd -p for the agent conflict tier; it
    costs a few model tokens but never installs or pushes anywhere real.
#>
[CmdletBinding()]
param(
    [switch]$SkipAgentCase
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$syncScript = Join-Path $repoRoot 'scripts\sync-upstream.ps1'
$failures = [System.Collections.Generic.List[string]]::new()
$passes = 0

$env:GIT_AUTHOR_NAME = 'sync-test'
$env:GIT_AUTHOR_EMAIL = 'sync-test@example.invalid'
$env:GIT_COMMITTER_NAME = 'sync-test'
$env:GIT_COMMITTER_EMAIL = 'sync-test@example.invalid'

function Invoke-FixtureGit([string]$Cwd, [string[]]$GitArgs) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $Cwd @GitArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($code -ne 0) { throw "git $($GitArgs -join ' ') in $Cwd failed: $out" }
    return $out
}

function Write-File([string]$Path, [string]$Content) {
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function New-Fixture([string]$Root, [bool]$WithPyConflict) {
    # Layout: $Root\upstream.git (bare), $Root\fork.git (bare), $Root\repo, $Root\upwork
    $up = Join-Path $Root 'upstream.git'
    $fork = Join-Path $Root 'fork.git'
    $repo = Join-Path $Root 'repo'
    $upwork = Join-Path $Root 'upwork'
    & git init --bare $up | Out-Null
    & git init --bare $fork | Out-Null
    & git init -b windows-native $repo | Out-Null

    Write-File (Join-Path $repo '.gitignore') "artifacts/`nnode_modules/`n"
    Write-File (Join-Path $repo 'packages\coding-agent\package.json') '{"name":"fixture","version":"0.0.1"}'
    Write-File (Join-Path $repo 'packages\coding-agent\CHANGELOG.md') "# Changelog`n`n## [0.0.1]`n`n- base entry`n"
    Write-File (Join-Path $repo 'src\tool.py') @'
def compute(values):
    total = 0
    for v in values:
        total += v
    return total
'@
    Invoke-FixtureGit $repo @('add', '-A') | Out-Null
    Invoke-FixtureGit $repo @('commit', '-m', 'base') | Out-Null
    Invoke-FixtureGit $repo @('remote', 'add', 'origin', $up) | Out-Null
    Invoke-FixtureGit $repo @('remote', 'add', 'windows', $fork) | Out-Null
    Invoke-FixtureGit $repo @('push', 'origin', 'windows-native:refs/heads/main') | Out-Null
    Invoke-FixtureGit $repo @('push', 'windows', 'windows-native') | Out-Null

    # upstream clone: change the same changelog line, add its own fragment,
    # rename a variable in tool.py
    & git clone $up $upwork | Out-Null
    Invoke-FixtureGit $upwork @('checkout', 'main') | Out-Null
    Write-File (Join-Path $upwork 'packages\coding-agent\CHANGELOG.md') "# Changelog`n`n## [0.0.1]`n`n- upstream entry`n"
    Write-File (Join-Path $upwork 'packages\coding-agent\.changes\upstream-bit.md') "- Added upstream thing.`n"
    if ($WithPyConflict) {
        Write-File (Join-Path $upwork 'src\tool.py') @'
def compute(values):
    sum_total = 0
    for v in values:
        sum_total += v
    return sum_total
'@
    }
    Invoke-FixtureGit $upwork @('add', '-A') | Out-Null
    Invoke-FixtureGit $upwork @('commit', '-m', 'upstream change') | Out-Null
    Invoke-FixtureGit $upwork @('push', 'origin', 'main') | Out-Null

    # port side: change the same changelog line, add its own fragment,
    # touch the same python lines (guaranteed overlap with the rename)
    Write-File (Join-Path $repo 'packages\coding-agent\CHANGELOG.md') "# Changelog`n`n## [0.0.1]`n`n- port entry`n"
    Write-File (Join-Path $repo 'packages\coding-agent\.changes\port-bit.md') "- Added port thing.`n"
    if ($WithPyConflict) {
        Write-File (Join-Path $repo 'src\tool.py') @'
def compute(values):
    total = 0
    for v in values:
        total += v * 2
    return total
'@
    }
    Invoke-FixtureGit $repo @('add', '-A') | Out-Null
    Invoke-FixtureGit $repo @('commit', '-m', 'port change') | Out-Null
    Invoke-FixtureGit $repo @('push', 'windows', 'windows-native') | Out-Null

    return @{ Repo = $repo; Up = $up; Fork = $fork }
}

function Invoke-Sync([string]$Repo, [string]$InstallRoot, [string[]]$Extra) {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncScript `
        -RepoRoot $Repo -UpstreamRef 'origin/main' -PortBranch 'windows-native' `
        -ForkRemote 'windows' -NoGitHub -InstallRoot $InstallRoot @Extra 2>&1
    return @{ Code = $LASTEXITCODE; Out = @($out) }
}

function Assert([bool]$Cond, [string]$What) {
    if ($Cond) { $script:passes++; Write-Host "  ok: $What" }
    else { $script:failures.Add($What); Write-Host "  FAIL: $What" }
}

# %TEMP% trips Windows Defender races on git's push quarantine (second push to a
# bare repo fails with "unable to migrate objects to permanent storage"); build
# fixtures under the repo-adjacent scratch dir instead.
$scratch = 'C:\Cornerstone\scratch'
if (-not (Test-Path $scratch)) { $scratch = $env:TEMP }
$root = Join-Path $scratch "sync-fixture-$([guid]::NewGuid().Guid)"
New-Item -ItemType Directory -Path $root -Force | Out-Null
$fakeInstall = Join-Path $root 'install'
New-Item -ItemType Directory -Path $fakeInstall -Force | Out-Null
Write-Host "fixture root: $root"

try {

# ---------------------------------------------------------- case 1: conflicts -> exit 2
Write-Host 'case 1: unresolved conflict -> exit 2, worktree kept'
$fx = New-Fixture (Join-Path $root 'case1') $true
$r = Invoke-Sync $fx.Repo $fakeInstall @('-Gates', 'none', '-NoAgent', '-NoInstall', '-NoPush')
Assert ($r.Code -eq 2) "case1 exit code 2 (got $($r.Code))"
$wt = Join-Path $fx.Repo 'artifacts\upstream-sync\wt'
Assert (Test-Path $wt) 'case1 worktree left in place'
$report = Get-ChildItem (Join-Path $fx.Repo 'artifacts\upstream-sync\reports') -Filter '*.md' |
    Sort-Object LastWriteTime | Select-Object -Last 1
Assert ($null -ne $report) 'case1 report written'
$reportText = Get-Content $report.FullName -Raw
Assert ($reportText -match 'src/tool\.py') 'case1 report lists the .py as unresolved'
Assert ($reportText -match 'CHANGELOG\.md') 'case1 report mentions changelog auto-resolution'
$lr = Get-Content (Join-Path $fx.Repo 'artifacts\upstream-sync\last-run.json') -Raw | ConvertFrom-Json
Assert ($lr.result -eq 'conflicts') "case1 last-run result 'conflicts' (got '$($lr.result)')"

# ---------------------------------------------------------- case 2: clean fixture -> landed
Write-Host 'case 2: auto-resolvable only -> exit 0, merge + tag pushed'
$fx2 = New-Fixture (Join-Path $root 'case2') $false
$r = Invoke-Sync $fx2.Repo $fakeInstall @('-Gates', 'none', '-NoAgent', '-NoInstall')
Assert ($r.Code -eq 0) "case2 exit code 0 (got $($r.Code): $(($r.Out | Select-Object -Last 3) -join ' | '))"
Assert (-not (Test-Path (Join-Path $fx2.Repo 'artifacts\upstream-sync\wt'))) 'case2 worktree removed'
$head2 = Invoke-FixtureGit $fx2.Repo @('rev-list', '--parents', '-n', '1', 'HEAD')
$parents = ($head2 -split '\s+').Count - 1
Assert ($parents -eq 2) "case2 HEAD is a merge commit ($parents parents)"
$forkTags = & git --git-dir=$($fx2.Fork) tag -l 'windows-v*'
Assert (@($forkTags) -contains 'windows-v0.0.1-r1') "case2 tag pushed to fork (got: $($forkTags -join ','))"
$lr2 = Get-Content (Join-Path $fx2.Repo 'artifacts\upstream-sync\last-run.json') -Raw | ConvertFrom-Json
Assert ($lr2.result -eq 'landed') "case2 last-run 'landed' (got '$($lr2.result)')"

# ---------------------------------------------------------- case 3: rerun -> up-to-date
Write-Host 'case 3: rerun -> up-to-date'
$r = Invoke-Sync $fx2.Repo $fakeInstall @('-Gates', 'none', '-NoAgent', '-NoInstall')
Assert ($r.Code -eq 0) "case3 exit code 0 (got $($r.Code))"
$lr3 = Get-Content (Join-Path $fx2.Repo 'artifacts\upstream-sync\last-run.json') -Raw | ConvertFrom-Json
Assert ($lr3.result -eq 'up-to-date') "case3 last-run 'up-to-date' (got '$($lr3.result)')"

# ---------------------------------------------------------- case 4: dirty -> exit 4
Write-Host 'case 4: dirty worktree -> exit 4'
'dirty' | Out-File -Append -Encoding utf8 (Join-Path $fx2.Repo 'packages\coding-agent\CHANGELOG.md')
$r = Invoke-Sync $fx2.Repo $fakeInstall @('-Gates', 'none', '-NoAgent', '-NoInstall')
Assert ($r.Code -eq 4) "case4 exit code 4 (got $($r.Code))"
Invoke-FixtureGit $fx2.Repo @('checkout', '--', 'packages/coding-agent/CHANGELOG.md') | Out-Null

# ---------------------------------------------------------- case 5: DryRun -> nothing lands
Write-Host 'case 5: -DryRun -> exit 0, no commit/tag, worktree removed'
$fx5 = New-Fixture (Join-Path $root 'case5') $false
$before = Invoke-FixtureGit $fx5.Repo @('rev-parse', 'HEAD')
$r = Invoke-Sync $fx5.Repo $fakeInstall @('-Gates', 'none', '-NoAgent', '-NoInstall', '-DryRun')
Assert ($r.Code -eq 0) "case5 exit code 0 (got $($r.Code))"
$after = Invoke-FixtureGit $fx5.Repo @('rev-parse', 'HEAD')
Assert ($before -eq $after) 'case5 HEAD unchanged'
$forkTags5 = & git --git-dir=$($fx5.Fork) tag -l 'windows-v*'
Assert (@($forkTags5).Count -eq 0) 'case5 no tag pushed'
Assert (-not (Test-Path (Join-Path $fx5.Repo 'artifacts\upstream-sync\wt'))) 'case5 worktree removed'

# ---------------------------------------------------------- case 6: real agent tier
if (-not $SkipAgentCase) {
    Write-Host 'case 6: agent tier resolves the .py conflict (real prime-agent -p)'
    $fx6 = New-Fixture (Join-Path $root 'case6') $true
    $realInstall = "$env:LOCALAPPDATA\Programs\PrimeAgentWindows"
    $r = Invoke-Sync $fx6.Repo $realInstall @('-Gates', 'none', '-NoInstall')
    Assert ($r.Code -eq 0) "case6 exit code 0 (got $($r.Code))"
    $lr6path = Join-Path $fx6.Repo 'artifacts\upstream-sync\last-run.json'
    if (Test-Path $lr6path) {
        $lr6 = Get-Content $lr6path -Raw | ConvertFrom-Json
        Assert (@($lr6.conflicts.agent) -contains 'src/tool.py') 'case6 agent resolved src/tool.py'
    } else {
        Assert $false 'case6 last-run.json missing'
    }
    $resolvedPy = Get-Content (Join-Path $fx6.Repo 'src\tool.py') -Raw
    Assert ($resolvedPy -notmatch '(?m)^<{7} |^={7}$|^>{7} ') 'case6 no conflict markers remain'
} else {
    Write-Host 'case 6 skipped (-SkipAgentCase)'
}

} finally {
    Write-Host ''
    Write-Host "fixture root kept for inspection: $root"
}

Write-Host ''
Write-Host "$passes assertions passed, $($failures.Count) failed"
if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Host "  FAIL: $_" }
    exit 1
}
Write-Host 'ALL SYNC-UPSTREAM TESTS PASSED'
exit 0
