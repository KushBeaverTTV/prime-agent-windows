<#
.SYNOPSIS
    Automated upstream sync for the Windows-native port branch.

.DESCRIPTION
    Merges origin/main into windows-native inside a scratch worktree, resolves
    conflicts in three tiers (auto / prime-agent -p / stop), runs the full
    Windows CI gate list, lands the merge on the port branch, tags
    windows-v<version>-r<N>, pushes to the fork, and installs the CI-published
    release via the in-app updater.

    Exit codes: 0 landed/up-to-date, 2 stopped on conflicts, 3 gate failure,
    4 preflight failure, 5 install failed after a successful land.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$UpstreamRef = 'origin/main',
    [string]$PortBranch = 'windows-native',
    [string]$ForkRemote = 'windows',
    [switch]$DryRun,
    [switch]$NoPush,
    [switch]$NoInstall,
    [switch]$NoAgent,
    [switch]$ForceRelease,
    [ValidateSet('all', 'none')][string]$Gates = 'all',
    [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\PrimeAgentWindows",
    # Test-only: never call gh; fork remote may be a local path.
    [switch]$NoGitHub
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$UpstreamRemote = ($UpstreamRef -split '/')[0]

$stateDir = Join-Path $RepoRoot 'artifacts\upstream-sync'
$wtDir = Join-Path $stateDir 'wt'
$lockFile = Join-Path $stateDir 'lock'
$lastRunFile = Join-Path $stateDir 'last-run.json'
$reportsDir = Join-Path $stateDir 'reports'
$logsDir = Join-Path $stateDir 'logs'
foreach ($d in @($stateDir, $reportsDir, $logsDir)) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
}

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logsDir "$ts.log"
$reportFile = Join-Path $reportsDir "$ts.md"
$startTime = Get-Date

$script:gateResults = [ordered]@{}
$script:autoResolved = [System.Collections.Generic.List[string]]::new()
$script:agentResolved = [System.Collections.Generic.List[string]]::new()
$script:unresolved = [System.Collections.Generic.List[string]]::new()
$script:warnings = [System.Collections.Generic.List[string]]::new()
$script:result = 'started'
$script:finished = $false
$script:exitCode = 0
$script:upstreamSha = ''
$script:mergeSha = ''
$script:tag = ''
$script:version = ''
$script:revision = 0
$script:fromSha = ''
$script:summary = ''

# ---------------------------------------------------------------- utilities

function Invoke-Git {
    param([string[]]$GitArgs, [string]$Cwd = $RepoRoot, [switch]$AllowFail)
    # 2>&1 on a native command under EAP=Stop can throw NativeCommandError;
    # keep the error stream merged but relax EAP for the call.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = [System.Collections.Generic.List[string]]::new()
    $err = [System.Collections.Generic.List[string]]::new()
    try {
        & git -C $Cwd @GitArgs 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $err.Add($_.ToString()) }
            elseif ($null -ne $_) { $out.Add([string]$_) }
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($code -ne 0 -and -not $AllowFail) {
        throw "git $($GitArgs -join ' ') failed ($code): $($out + $err -join ' ')"
    }
    return @{ Out = $out.ToArray(); Err = $err.ToArray(); Code = $code }
}

function Save-GitStage {
    # Write a merge stage blob (:1: base, :2: ours, :3: theirs) to a file without
    # PowerShell re-encoding it. cmd redirection preserves raw bytes.
    param([string]$Cwd, [int]$Stage, [string]$RelPath, [string]$Dest)
    $cmdline = "cd /d `"$Cwd`" && git show `":$Stage`:$RelPath`" > `"$Dest`""
    & "$env:SystemRoot\System32\cmd.exe" /d /s /c $cmdline | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git show :$Stage`:$RelPath failed" }
}

function Invoke-Logged {
    # Run an external command, tee output to a per-gate log, return exit code.
    param([string]$Name, [string]$FilePath, [string[]]$CmdArgs, [string]$Cwd)
    $gl = Join-Path $logsDir ("$ts-gate-{0}.log" -f ($Name -replace '[:\\/]', '-'))
    Write-Host "== gate $Name : $FilePath $($CmdArgs -join ' ')"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location $Cwd
    try {
        # Tee passes records through; Write-Host consumes them so only the
        # hashtable below is on the output stream (StrictMode-safe .Code).
        & $FilePath @CmdArgs 2>&1 | Tee-Object -FilePath $gl | Write-Host
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $prevEap
    }
    return @{ Code = $code; Log = $gl }
}

function Invoke-Proc {
    # Process exec with timeout + captured streams (for prime-agent.cmd).
    param([string]$FilePath, [string]$Arguments, [string]$Cwd, [int]$TimeoutMs)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = $Arguments
    $psi.WorkingDirectory = $Cwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    # Event-based line reads capture partial output: a spawned grandchild (e.g.
    # the resident daemon `update` starts) inherits the pipes, so ReadToEndAsync
    # never completes and an unbounded stream wait would hang the run forever.
    $cap = [hashtable]::Synchronized(@{
        Out    = [System.Text.StringBuilder]::new()
        Err    = [System.Text.StringBuilder]::new()
        OutEof = $false
        ErrEof = $false
    })
    $subOut = Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -MessageData $cap -Action {
        if ($null -eq $EventArgs.Data) { $Event.MessageData.OutEof = $true }
        else { [void]$Event.MessageData.Out.AppendLine($EventArgs.Data) }
    }
    $subErr = Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -MessageData $cap -Action {
        if ($null -eq $EventArgs.Data) { $Event.MessageData.ErrEof = $true }
        else { [void]$Event.MessageData.Err.AppendLine($EventArgs.Data) }
    }
    try {
        $p.BeginOutputReadLine()
        $p.BeginErrorReadLine()
        $exited = $p.WaitForExit($TimeoutMs)
        if (-not $exited) {
            try { $p.Kill() } catch {}
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while ((-not $cap.OutEof -or -not $cap.ErrEof) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 100
        }
        $outText = $cap.Out.ToString()
        $errText = $cap.Err.ToString()
        if (-not $cap.OutEof) { $outText += '<stream still held open by a child process; truncated>' }
        if (-not $cap.ErrEof) { $errText += '<stream still held open by a child process; truncated>' }
        if (-not $exited) {
            return @{ Code = -1; Stdout = $outText; Stderr = "TIMED OUT after ${TimeoutMs}ms`n" + $errText }
        }
        return @{ Code = $p.ExitCode; Stdout = $outText; Stderr = $errText }
    } finally {
        Unregister-Event -SubscriptionId $subOut.Id -ErrorAction SilentlyContinue
        Unregister-Event -SubscriptionId $subErr.Id -ErrorAction SilentlyContinue
        $p.Dispose()
    }
}

function Get-ForkSlug {
    $url = (Invoke-Git @('remote', 'get-url', $ForkRemote)).Out | Select-Object -First 1
    if ($url -match 'github\.com[:/]([^/]+/[^/.]+)') { return $Matches[1] }
    return $null
}

function Send-Notify([string]$Text, [string]$Priority) {
    $py = 'C:\Cornerstone\services\prima-telegram\.venv\Scripts\python.exe'
    $notifyScript = 'C:\Cornerstone\services\prima-telegram\notify.py'
    if ((Test-Path $py) -and (Test-Path $notifyScript)) {
        try {
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            & $py $notifyScript $Text --priority $Priority 2>&1 | Out-Null
            $ErrorActionPreference = $prevEap
        } catch {
            Write-Warning "notify.py failed: $_"
        }
    }
}

function Invoke-AgentUpdate {
    # prime-agent.cmd is a batch shim; run it through cmd.exe.
    $cmd = Join-Path $InstallRoot 'prime-agent.cmd'
    return Invoke-Proc "$env:SystemRoot\System32\cmd.exe" `
        "/d /s /c `"`"$cmd`" update --force`"" $InstallRoot (10 * 60 * 1000)
}

function Write-Report {
    param([string[]]$ExtraSections = @())
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("# Upstream sync report $ts")
    $lines.Add("")
    $lines.Add("- repo: $RepoRoot")
    $lines.Add("- branch: $PortBranch  upstream: $UpstreamRef ($($script:upstreamSha))")
    $lines.Add("- result: **$($script:result)** (exit $($script:exitCode))")
    $lines.Add("- duration: $([int]((Get-Date) - $startTime).TotalSeconds)s")
    if ($script:mergeSha) { $lines.Add("- merge commit: $($script:mergeSha)") }
    if ($script:tag) { $lines.Add("- tag: $($script:tag)") }
    if ($script:summary) { $lines.Add(""); $lines.Add($script:summary) }
    $lines.Add("")
    $lines.Add("## Conflicts")
    $lines.Add("- auto-resolved: $($script:autoResolved -join ', ')" )
    $lines.Add("- agent-resolved: $($script:agentResolved -join ', ')" )
    $lines.Add("- unresolved: $($script:unresolved -join ', ')")
    $lines.Add("")
    $lines.Add("## Gates")
    foreach ($k in $script:gateResults.Keys) {
        $g = $script:gateResults[$k]
        $lines.Add("- $k : $($g.status) ($($g.seconds)s)")
    }
    foreach ($s in $ExtraSections) { $lines.Add(""); $lines.Add($s) }
    if ($script:warnings.Count -gt 0) {
        $lines.Add("")
        $lines.Add("## Warnings")
        foreach ($w in $script:warnings) { $lines.Add("- $w") }
    }
    $lines.Add("")
    $lines.Add("log: $logFile")
    [System.IO.File]::WriteAllLines($reportFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "report: $reportFile"
}

function Write-LastRun {
    $obj = [ordered]@{
        ts = $ts
        result = $script:result
        exitCode = $script:exitCode
        from = $script:fromSha
        to = $script:mergeSha
        upstreamSha = $script:upstreamSha
        mergeSha = $script:mergeSha
        tag = $script:tag
        revision = $script:revision
        conflicts = @{
            auto = @($script:autoResolved)
            agent = @($script:agentResolved)
            unresolved = @($script:unresolved)
        }
        gates = @{}
        durationS = [int]((Get-Date) - $startTime).TotalSeconds
    }
    foreach ($k in $script:gateResults.Keys) { $obj.gates[$k] = $script:gateResults[$k].status }
    [System.IO.File]::WriteAllText($lastRunFile, ($obj | ConvertTo-Json -Depth 5),
        (New-Object System.Text.UTF8Encoding($false)))
}

function Finish-Run {
    param([string]$Result, [int]$Code, [string]$Summary, [string[]]$ExtraSections = @())
    $script:result = $Result
    $script:exitCode = $Code
    $script:finished = $true
    $script:summary = $Summary
    Write-Report -ExtraSections $ExtraSections
    Write-LastRun
    $prio = 'normal'; if ($Code -ge 2 -and $Code -le 5) { $prio = 'high' }
    Send-Notify "upstream-sync $Result (exit $Code): $Summary" $prio
    try {
        # PrimaTray.ps1 watches this directory and raises a toast per record.
        $eventsDir = 'C:\Cornerstone\services\prima-telegram\events'
        New-Item -ItemType Directory -Path $eventsDir -Force | Out-Null
        $ev = [ordered]@{ kind = 'sync_result'; title = "upstream-sync $Result"
                          body = [string]$Summary
                          ts = [int][DateTimeOffset]::Now.ToUnixTimeSeconds() }
        $tmp = Join-Path $eventsDir "$ts-sync_result.tmp"
        [System.IO.File]::WriteAllText($tmp, ($ev | ConvertTo-Json -Compress))
        Move-Item $tmp ($tmp -replace '\.tmp$', '.json') -Force
    } catch { }
    exit $Code
}

function Invoke-Gate {
    param([string]$Name, [scriptblock]$Block)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Block
        $script:gateResults[$Name] = @{ status = 'pass'; seconds = [int]$sw.Elapsed.TotalSeconds }
        Write-Host "== gate $Name PASS ($([int]$sw.Elapsed.TotalSeconds)s)"
    } catch {
        $script:gateResults[$Name] = @{ status = 'fail'; seconds = [int]$sw.Elapsed.TotalSeconds }
        $tail = ""
        $gl = Join-Path $logsDir ("$ts-gate-{0}.log" -f ($Name -replace '[:\\/]', '-'))
        if (Test-Path $gl) {
            $fence = [string][char]96 * 3
            $tail = "### last lines of $gl`n$fence`n" +
                ((Get-Content $gl -Tail 80) -join "`n") + "`n$fence"
        }
        Write-Host "== gate $Name FAIL: $_"
        Finish-Run 'gate-failure' 3 "gate '$Name' failed: $($_.Exception.Message)" @($tail)
    }
}

# ---------------------------------------------------------------- lock

if ((Test-Path $lockFile) -and
    ((Get-Date) - (Get-Item $lockFile).LastWriteTime) -lt [TimeSpan]::FromHours(6)) {
    Write-Host "another sync-upstream run holds the lock ($lockFile, <6h old); aborting."
    exit 4
}
[System.IO.File]::WriteAllText($lockFile, "$PID $ts", (New-Object System.Text.ASCIIEncoding))

try {

Start-Transcript -Path $logFile -Append | Out-Null

# ------------------------------------------------------- step 0: catch-up install
if (-not $NoInstall -and -not $NoGitHub) {
    try {
        $activeFile = Join-Path $InstallRoot 'active.json'
        if (Test-Path $activeFile) {
            $active = (Get-Content $activeFile -Raw | ConvertFrom-Json).current
            $installedVer = [string]$active.version
            $installedRev = [int]$active.revision
            $remoteTags = (Invoke-Git @('ls-remote', '--tags', $ForkRemote, 'windows-v*')).Out |
                ForEach-Object { if ($_ -match 'refs/tags/(windows-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-r(\d+))$') {
                    [pscustomobject]@{ tag = $Matches[1]; version = $Matches[2]; revision = [int]$Matches[3] } } }
            $candidate = $remoteTags | Where-Object {
                ([version]($_.version -replace '-.*$', '')) -gt ([version]($installedVer -replace '-.*$', '')) -or
                ($_.version -eq $installedVer -and $_.revision -gt $installedRev)
            } | Sort-Object { [version]($_.version -replace '-.*$', '') }, revision | Select-Object -Last 1
            if ($candidate) {
                $slug = Get-ForkSlug
                $assets = @()
                $ghExe = (Get-Command gh -ErrorAction SilentlyContinue).Source
                if ($slug -and $ghExe) {
                    $gv = Invoke-Proc $ghExe ("release view $($candidate.tag) --repo $slug --json assets --jq .assets[].name") `
                        $RepoRoot (60 * 1000)
                    $assets = @($gv.Stdout -split "`r?`n" | Where-Object { $_.Trim() })
                }
                if ($assets -contains 'windows.json') {
                    Write-Host "catch-up install: $($candidate.tag) is newer than installed $installedVer r$installedRev; updating"
                    # --force: non-TTY runs decline the busy-daemon prompt otherwise.
                    $upd = Invoke-AgentUpdate
                    Write-Host "catch-up update exit $($upd.Code): $($upd.Stdout.Trim())"
                    if ($upd.Code -ne 0) { $script:warnings.Add("catch-up update to $($candidate.tag) exited $($upd.Code): $($upd.Stderr.Trim())") }
                } else {
                    Write-Host "catch-up install: $($candidate.tag) exists but its release has no windows.json yet"
                }
            } else {
                Write-Host "catch-up install: installed $installedVer r$installedRev is current"
            }
        } else {
            Write-Host "catch-up install: no active.json at $InstallRoot; skipping"
        }
    } catch {
        $script:warnings.Add("catch-up install failed: $_")
    }
}

# ------------------------------------------------------- step 1: preflight
$inside = (Invoke-Git @('rev-parse', '--is-inside-work-tree') -AllowFail)
if ($inside.Code -ne 0) { Finish-Run 'preflight' 4 "$RepoRoot is not a git worktree" }
$branch = ((Invoke-Git @('branch', '--show-current')).Out | Select-Object -First 1)
if ($branch -ne $PortBranch) { Finish-Run 'preflight' 4 "repo is on '$branch', expected '$PortBranch'" }
$dirty = (Invoke-Git @('status', '--porcelain')).Out
if (@($dirty).Count -gt 0) { Finish-Run 'preflight' 4 "worktree is dirty: $(@($dirty) -join '; ')" }

foreach ($remote in @($UpstreamRemote, $ForkRemote)) {
    $f = Invoke-Git @('fetch', $remote, '--tags') -AllowFail
    if ($f.Code -ne 0) {
        $rejected = @($f.Out + $f.Err | Where-Object { "$_" -match '\[rejected\]' })
        $clobberOnly = $rejected.Count -gt 0 -and
            (@($rejected | Where-Object { "$_" -notmatch 'would clobber existing tag' }).Count -eq 0)
        if ($clobberOnly) {
            $script:warnings.Add("fetch $remote`: local tag(s) diverge from remote (clobber rejected); continuing")
        } else {
            Finish-Run 'preflight' 4 "git fetch $remote --tags failed: $($f.Out + $f.Err -join ' ')"
        }
    }
}

$forkBranch = "$ForkRemote/$PortBranch"
if ((Invoke-Git @('rev-parse', '--verify', '--quiet', $forkBranch) -AllowFail).Code -eq 0) {
    if ((Invoke-Git @('merge-base', '--is-ancestor', $forkBranch, 'HEAD') -AllowFail).Code -ne 0) {
        Finish-Run 'preflight' 4 "local $PortBranch is behind or diverged from $forkBranch"
    }
}

$missing = @()
foreach ($t in @('node', 'npm', 'git', 'uv')) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { $missing += $t }
}
if (-not $NoGitHub) {
    $ghExe = (Get-Command gh -ErrorAction SilentlyContinue).Source
    if (-not $ghExe) { $missing += 'gh' }
    else {
        $auth = Invoke-Proc $ghExe 'auth status' $RepoRoot (30 * 1000)
        if ($auth.Code -ne 0) { $missing += 'gh(auth)' }
    }
}
$bunOk = (Get-Command bun -ErrorAction SilentlyContinue) -or
    (Test-Path "$env:LOCALAPPDATA\prime-agent-tooling\bun-1.4.0\node_modules\bun\bin\bun.exe") -or
    (Test-Path "$env:LOCALAPPDATA\prime-agent-tooling\bun-1.4.0\node_modules\@oven\bun-windows-x64\bin\bun.exe")
if (-not $bunOk) {
    $script:warnings.Add('bun not found; build-binary.mjs will self-provision bun 1.4.0 via npm')
}
if ($missing.Count -gt 0) { Finish-Run 'preflight' 4 "missing required tools: $($missing -join ', ')" }

$script:fromSha = ((Invoke-Git @('rev-parse', 'HEAD')).Out | Select-Object -First 1).Trim()
$script:upstreamSha = ((Invoke-Git @('rev-parse', $UpstreamRef)).Out | Select-Object -First 1).Trim()
$upstreamShort = ((Invoke-Git @('rev-parse', '--short', $UpstreamRef)).Out | Select-Object -First 1).Trim()
$mergeBase = ((Invoke-Git @('merge-base', 'HEAD', $UpstreamRef)).Out | Select-Object -First 1).Trim()

# ------------------------------------------------------- step 2: up to date?
$needsMerge = (Invoke-Git @('merge-base', '--is-ancestor', $UpstreamRef, 'HEAD') -AllowFail).Code -ne 0
if (-not $needsMerge -and -not $ForceRelease) {
    Finish-Run 'up-to-date' 0 "$PortBranch already contains $UpstreamRef ($upstreamShort)"
}
$mergedCommits = @()
if ($needsMerge) {
    $mergedCommits = @((Invoke-Git @('log', '--oneline', "HEAD..$UpstreamRef")).Out)
}
if (-not $needsMerge) {
    Write-Host "already up to date; -ForceRelease: running gates and tagging current HEAD"
}

# ------------------------------------------------------- step 3: worktree + merge
$wtForward = $wtDir -replace '\\', '/'
$wtListed = (Invoke-Git @('worktree', 'list', '--porcelain')).Out |
    Select-String -SimpleMatch "worktree $wtForward"
if ((Test-Path $wtDir) -or $wtListed) {
    $prev = $null
    if (Test-Path $lastRunFile) {
        try { $prev = Get-Content $lastRunFile -Raw | ConvertFrom-Json } catch {}
    }
    $prevResult = ''
    if ($prev -and $prev.PSObject.Properties['result']) { $prevResult = [string]$prev.result }
    $finished = @('landed', 'up-to-date', 'dry-run', 'installed', 'install-pending')
    if ($prevResult -and ($finished -contains $prevResult)) {
        Write-Host "removing leftover worktree from finished run ($($prev.result))"
        Invoke-Git @('worktree', 'remove', '--force', $wtDir) -AllowFail | Out-Null
        if (Test-Path $wtDir) { Remove-Item $wtDir -Recurse -Force }
    } else {
        Finish-Run 'preflight' 4 ("leftover worktree at $wtDir from a stopped run; a human may be " +
            "reviewing it. Inspect it, then delete it (git worktree remove --force `"$wtDir`") and re-run.")
    }
}
Invoke-Git @('worktree', 'add', '--detach', $wtDir, 'HEAD') | Out-Null
Write-Host "worktree: $wtDir"

$hadMerge = $false
if ($needsMerge) {
    $m = Invoke-Git @('merge', '--no-commit', '--no-ff', $UpstreamRef) -Cwd $wtDir -AllowFail
    $hadMerge = $true
    Write-Host ($m.Out -join "`n")
    if ($m.Code -ne 0 -and -not ((Invoke-Git @('diff', '--name-only', '--diff-filter=U') -Cwd $wtDir).Out.Count)) {
        Invoke-Git @('merge', '--abort') -Cwd $wtDir -AllowFail | Out-Null
        Finish-Run 'preflight' 4 "merge failed without conflicts: $($m.Out -join ' ')"
    }
}

# ------------------------------------------------------- step 4: conflict tiers
function Get-Conflicts { return (Invoke-Git @('diff', '--name-only', '--diff-filter=U') -Cwd $wtDir).Out }

$regenModels = $false
if ($hadMerge) {
    $conflicts = @(Get-Conflicts)
    Write-Host "conflicted files: $($conflicts.Count)"

    # --- tier a: auto
    foreach ($f in @($conflicts)) {
        $rel = $f -replace '/', '\'
        if ($f -match '^packages/[^/]+/(CHANGELOG\.md|\.changes/[^/]+\.md)$') {
            $baseTmp = Join-Path $env:TEMP "sync-base-$([guid]::NewGuid().Guid).txt"
            $theirsTmp = Join-Path $env:TEMP "sync-theirs-$([guid]::NewGuid().Guid).txt"
            Save-GitStage $wtDir 1 $f $baseTmp
            Save-GitStage $wtDir 3 $f $theirsTmp
            Save-GitStage $wtDir 2 $f (Join-Path $wtDir $rel)
            & git -C $wtDir merge-file --union (Join-Path $wtDir $rel) $baseTmp $theirsTmp | Out-Null
            Remove-Item $baseTmp, $theirsTmp -Force -ErrorAction SilentlyContinue
            Invoke-Git @('add', $f) -Cwd $wtDir | Out-Null
            $script:autoResolved.Add($f)
        } elseif ($f -eq 'package-lock.json') {
            Invoke-Git @('checkout', '--theirs', '--', $f) -Cwd $wtDir | Out-Null
            Invoke-Git @('add', $f) -Cwd $wtDir | Out-Null
            $script:autoResolved.Add("$f (theirs; npm ci regenerates)")
        } elseif ($f -eq 'packages/ai/src/models.generated.ts') {
            Invoke-Git @('checkout', '--theirs', '--', $f) -Cwd $wtDir | Out-Null
            Invoke-Git @('add', $f) -Cwd $wtDir | Out-Null
            $genDiff = (Invoke-Git @('diff', $mergeBase, 'HEAD', '--', 'packages/ai/scripts/generate-models.ts') -Cwd $wtDir).Out
            $genDiff2 = (Invoke-Git @('diff', $mergeBase, $UpstreamRef, '--', 'packages/ai/scripts/generate-models.ts') -Cwd $wtDir).Out
            if (@($genDiff).Count -gt 0 -or @($genDiff2).Count -gt 0) { $regenModels = $true }
            $script:autoResolved.Add("$f (theirs$(if ($regenModels) { '; will regenerate' }))")
        }
    }

    # --- tier b: agent
    $remaining = @(Get-Conflicts)
    if ($remaining.Count -gt 0 -and -not $NoAgent) {
        $fileList = $remaining -join ', '
        $prompt = "You are resolving a git merge in this worktree: upstream origin/main is being merged into the Windows-native port branch. Conflicted files: $fileList. For each file, open it, understand both sides (HEAD = the Windows port, the other side = upstream) and write a resolution that keeps upstream's new behavior AND preserves the Windows port's intent: native PowerShell as the shell, no PATH trust for system binaries (absolute System32 paths), Windows job-object process containment, and the release/update flow under scripts/*.ps1 and install-windows.ps1. Remove every conflict marker. Do not change unrelated code. Do not run git commit, git add, git checkout, git reset, or any git command that modifies the index or history; only edit the listed files. When finished, print exactly one line per file: RESOLVED <path> or UNRESOLVED <path> <reason>."
        $agentCmd = Join-Path $InstallRoot 'prime-agent.cmd'
        Write-Host "agent tier: resolving $($remaining.Count) file(s) via prime-agent -p (30 min timeout)"
        $cmdline = "`"$agentCmd`" -p --no-session --cwd `"$wtDir`" `"$prompt`""
        $r = Invoke-Proc "$env:SystemRoot\System32\cmd.exe" "/d /s /c `"$cmdline`"" $wtDir (30 * 60 * 1000)
        [System.IO.File]::WriteAllText((Join-Path $logsDir "$ts-agent-stdout.log"), $r.Stdout)
        [System.IO.File]::WriteAllText((Join-Path $logsDir "$ts-agent-stderr.log"), $r.Stderr)
        Write-Host "agent exit $($r.Code)"

        # independent verification — never trust the RESOLVED lines
        foreach ($f in @($remaining)) {
            $path = Join-Path $wtDir ($f -replace '/', '\')
            $content = if (Test-Path $path) { Get-Content $path -Raw } else { '' }
            $hasMarkers = $content -match '(?m)^<{7} |^={7}$|^>{7} '
            $check = (Invoke-Git @('diff', '--check', '--', $f) -Cwd $wtDir -AllowFail).Out
            if (-not $hasMarkers -and @($check).Count -eq 0) {
                Invoke-Git @('add', $f) -Cwd $wtDir | Out-Null
                $script:agentResolved.Add($f)
            }
        }
    }

    # --- tier c: stop
    foreach ($f in @(Get-Conflicts)) { $script:unresolved.Add([string]$f) }
    if ($script:unresolved.Count -gt 0) {
        $sections = @('## Conflict hunks')
        $fence = [string][char]96 * 3
        foreach ($f in $script:unresolved) {
            $hunks = (Invoke-Git @('diff', '--', $f) -Cwd $wtDir -AllowFail).Out
            $sections += "### $f`n${fence}diff`n" + ($hunks -join "`n") + "`n$fence"
        }
        Finish-Run 'conflicts' 2 ("unresolved conflicts in: $($script:unresolved -join ', '). " +
            "Worktree left at $wtDir; resolve there, then run the gates manually.")
    }
}

function Resolve-ReleaseTag {
    # version from the worktree package.json; revision = 1 + highest existing tag.
    $pkgJson = Get-Content (Join-Path $wtDir 'packages\coding-agent\package.json') -Raw | ConvertFrom-Json
    $script:version = [string]$pkgJson.version
    $existing = @()
    $existing += (Invoke-Git @('tag', '-l', "windows-v$($script:version)-r*")).Out
    $existing += ((Invoke-Git @('ls-remote', '--tags', $ForkRemote, "windows-v$($script:version)-r*") -AllowFail).Out |
        ForEach-Object { ($_ -split '/')[-1] })
    $maxRev = 0
    foreach ($t in $existing) {
        if ($t -match 'r(\d+)$') { $maxRev = [Math]::Max($maxRev, [int]$Matches[1]) }
    }
    $script:revision = $maxRev + 1
    $script:tag = "windows-v$($script:version)-r$($script:revision)"
}

# ------------------------------------------------------- step 5: gates
if ($Gates -eq 'all') {
    Invoke-Gate 'npm-ci' {
        $r = Invoke-Logged 'npm-ci' 'npm.cmd' @('ci') $wtDir
        if ($r.Code -ne 0) { throw "npm ci exited $($r.Code)" }
    }

    if ($regenModels) {
        Invoke-Gate 'regen-models' {
            $r = Invoke-Logged 'regen-models' 'npm.cmd' @('run', 'generate-models') (Join-Path $wtDir 'packages\ai')
            if ($r.Code -ne 0) {
                $script:warnings.Add('models.generated.ts regeneration failed (offline?); keeping upstream version')
                Invoke-Git @('checkout', '--', 'packages/ai/src/models.generated.ts') -Cwd $wtDir -AllowFail | Out-Null
            } else {
                Invoke-Git @('add', 'packages/ai/src/models.generated.ts') -Cwd $wtDir | Out-Null
            }
        }
    }

    Invoke-Gate 'tsgo' {
        $r = Invoke-Logged 'tsgo' (Join-Path $wtDir 'node_modules\.bin\tsgo.cmd') @('--noEmit') $wtDir
        if ($r.Code -ne 0) { throw "tsgo exited $($r.Code)" }
    }

    Invoke-Gate 'test-policy' {
        $env:TEST_POLICY_BASE = $mergeBase
        try {
            $r = Invoke-Logged 'test-policy' 'node' @('scripts\check-test-policy.mjs') $wtDir
        } finally { Remove-Item Env:TEST_POLICY_BASE -ErrorAction SilentlyContinue }
        if ($r.Code -ne 0) { throw "check-test-policy exited $($r.Code)" }
    }

    Invoke-Gate 'biome' {
        $r = Invoke-Logged 'biome' (Join-Path $wtDir 'node_modules\.bin\biome.cmd') @('check', '--write', '--error-on-warnings', '.') $wtDir
        if ($r.Code -ne 0) { throw "biome exited $($r.Code)" }
        # biome --write may have normalized files; keep the fixes in the merge
        Invoke-Git @('add', '-u') -Cwd $wtDir | Out-Null
    }

    Invoke-Gate 'browser-smoke' {
        $pkg = Get-Content (Join-Path $wtDir 'package.json') -Raw | ConvertFrom-Json
        if ($pkg.scripts -and $pkg.scripts.PSObject.Properties['check:browser-smoke']) {
            $r = Invoke-Logged 'browser-smoke' 'npm.cmd' @('run', 'check:browser-smoke') $wtDir
            if ($r.Code -ne 0) { throw "check:browser-smoke exited $($r.Code)" }
        } else { Write-Host 'check:browser-smoke not in package.json; skipped' }
    }

    $sh = 'C:\Program Files\Git\bin\sh.exe'
    if (Test-Path $sh) {
        $shDir = Split-Path $sh -Parent
        foreach ($chk in @('check:installer', 'check:push-guard')) {
            Invoke-Gate $chk {
                $env:PATH = "$shDir;$env:PATH"
                try {
                    $r = Invoke-Logged $chk 'npm.cmd' @('run', $chk) $wtDir
                } finally { $env:PATH = $env:PATH -replace [regex]::Escape("$shDir;"), '' }
                if ($r.Code -ne 0) { throw "$chk exited $($r.Code)" }
            }
        }
    } else {
        $script:warnings.Add('no POSIX sh (C:\Program Files\Git\bin\sh.exe); skipped check:installer and check:push-guard')
        $script:gateResults['installer+push-guard'] = @{ status = 'skipped-no-sh'; seconds = 0 }
    }

    Invoke-Gate 'vitest-windows' {
        $tests = @('test\shell.test.ts', 'test\windows-installation.test.ts',
                   'test\windows-update.test.ts', 'test\kernel-bootstrap-windows.test.ts') |
            Where-Object { Test-Path (Join-Path $wtDir "packages\coding-agent\$_") }
        $r = Invoke-Logged 'vitest-windows' 'node' (@('..\..\node_modules\tsx\dist\cli.mjs',
            '..\..\node_modules\vitest\dist\cli.js', '--run') + $tests) (Join-Path $wtDir 'packages\coding-agent')
        if ($r.Code -ne 0) { throw "vitest exited $($r.Code)" }
    }

    Invoke-Gate 'runtime-harness' {
        $r = Invoke-Logged 'uv-sync' 'uv' @('sync', '--locked', '--project', 'prime-agent-runtime') $wtDir
        if ($r.Code -ne 0) { throw "uv sync exited $($r.Code)" }
        $r = Invoke-Logged 'runtime-harness' (Join-Path $wtDir 'prime-agent-runtime\.venv\Scripts\python.exe') `
            @('scripts\test-windows-runtime.py') $wtDir
        if ($r.Code -ne 0) { throw "test-windows-runtime.py exited $($r.Code)" }
    }

    # release build + installer + artifact checks
    Resolve-ReleaseTag

    Invoke-Gate 'release-build' {
        $r = Invoke-Logged 'release-build' "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            @('-NoProfile', '-File', (Join-Path $wtDir 'scripts\build-windows-release.ps1'),
              '-Revision', "$($script:revision)", '-OutputDir', (Join-Path $wtDir 'artifacts\windows')) $wtDir
        if ($r.Code -ne 0) { throw "build-windows-release.ps1 exited $($r.Code)" }
    }

    Invoke-Gate 'install-test' {
        $manifest = Get-Content (Join-Path $wtDir 'artifacts\windows\windows.json') -Raw | ConvertFrom-Json
        $r = Invoke-Logged 'install-test' "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            @('-NoProfile', '-File', (Join-Path $wtDir 'scripts\test-windows-install.ps1'),
              '-ArchivePath', (Join-Path $wtDir "artifacts\windows\$($manifest.file)"),
              '-Sha256', $manifest.sha256) $wtDir
        if ($r.Code -ne 0) { throw "test-windows-install.ps1 exited $($r.Code)" }
    }

    Invoke-Gate 'artifact-test' {
        $uvPath = (Get-Command uv).Source
        $r = Invoke-Logged 'artifact-test' 'node' @('node_modules\tsx\dist\cli.mjs',
            'scripts\test-windows-artifact.ts',
            '--binary-dir', 'packages\coding-agent\binaries\windows-x64-baseline',
            '--uv', $uvPath) $wtDir
        if ($r.Code -ne 0) { throw "test-windows-artifact.ts exited $($r.Code)" }
    }
} else {
    # gates skipped (fixture tests); still compute version/revision/tag
    Resolve-ReleaseTag
}

# ------------------------------------------------------- step 6: land
if ($DryRun) {
    Invoke-Git @('worktree', 'remove', '--force', $wtDir) -AllowFail | Out-Null
    if (Test-Path $wtDir) { Remove-Item $wtDir -Recurse -Force -ErrorAction SilentlyContinue }
    Invoke-Git @('worktree', 'prune') | Out-Null
    Finish-Run 'dry-run' 0 ("dry run: merge " + $(if ($needsMerge) { 'computed' } else { 'not needed' }) +
        ", gates " + $(if ($Gates -eq 'all') { 'all passed' } else { 'skipped' }) +
        ", tag would be $($script:tag). Nothing landed.")
}

if ($needsMerge) {
    $body = ($mergedCommits -join "`n") + "`n`nGates: all passed`nConflicts: auto=$($script:autoResolved.Count) agent=$($script:agentResolved.Count)"
    $subject = "Merge $UpstreamRef into $PortBranch (upstream through $upstreamShort)"
    Invoke-Git @('commit', '-m', $subject, '-m', $body) -Cwd $wtDir | Out-Null
    $script:mergeSha = ((Invoke-Git @('rev-parse', 'HEAD') -Cwd $wtDir).Out | Select-Object -First 1).Trim()
    Invoke-Git @('merge', '--ff-only', $script:mergeSha) | Out-Null
} else {
    $script:mergeSha = $script:fromSha
}

Invoke-Git @('tag', '-a', $script:tag, '-m', "Prime Agent Windows $($script:version) r$($script:revision)", $script:mergeSha) | Out-Null

if (-not $NoPush) {
    # A tag must never reference commits the fork branch does not have: push the
    # branch whenever the fork tip is not contained in what we are tagging.
    $forkRef = "$ForkRemote/$PortBranch"
    $pushBranch = $true
    $forkTip = Invoke-Git @('rev-parse', '--verify', '--quiet', $forkRef) -AllowFail
    if ($forkTip.Code -eq 0) {
        $forkSha = ($forkTip.Out | Select-Object -First 1).Trim()
        $pushBranch = ($forkSha -ne $script:mergeSha)
    }
    if ($pushBranch) {
        Invoke-Git @('push', $ForkRemote, "$($script:mergeSha):refs/heads/$PortBranch") | Out-Null
    }
    Invoke-Git @('push', $ForkRemote, $script:tag) | Out-Null
}

Invoke-Git @('worktree', 'remove', '--force', $wtDir) -AllowFail | Out-Null
if (Test-Path $wtDir) { Remove-Item $wtDir -Recurse -Force -ErrorAction SilentlyContinue }
Invoke-Git @('worktree', 'prune') | Out-Null

# ------------------------------------------------------- step 7: install
if (-not $NoInstall -and -not $NoPush -and -not $NoGitHub) {
    $slug = Get-ForkSlug
    $deadline = (Get-Date).AddMinutes(75)
    $published = $false
    $ghExe = (Get-Command gh -ErrorAction SilentlyContinue).Source
    while ($ghExe -and (Get-Date) -lt $deadline) {
        $gv = Invoke-Proc $ghExe ("release view $($script:tag) --repo $slug --json assets --jq .assets[].name") `
            $RepoRoot (60 * 1000)
        $assets = @($gv.Stdout -split "`r?`n" | Where-Object { $_.Trim() })
        if ($assets -contains 'windows.json') { $published = $true; break }
        # Watch the release CI run for this tag; fail fast instead of polling
        # for an asset a failed run will never publish.
        $runs = Invoke-Proc $ghExe ('run list --repo ' + $slug +
            ' --workflow "Windows Native Release" --json databaseId,status,conclusion,headBranch,event --limit 10') `
            $RepoRoot (60 * 1000)
        if ($runs.Code -eq 0 -and $runs.Stdout.Trim()) {
            $ciRuns = @()
            try { $ciRuns = @($runs.Stdout | ConvertFrom-Json) } catch { }
            $tagRun = @($ciRuns | Where-Object { $_.headBranch -eq $script:tag }) | Select-Object -First 1
            if ($tagRun -and $tagRun.status -eq 'completed' -and
                @('failure', 'cancelled', 'timed_out') -contains $tagRun.conclusion) {
                $fl = Invoke-Proc $ghExe "run view $($tagRun.databaseId) --repo $slug --log-failed" `
                    $RepoRoot (60 * 1000)
                $fence = [string][char]96 * 3
                $tail = "### CI failure (run $($tagRun.databaseId), conclusion $($tagRun.conclusion))`n$fence`n" +
                    ((@($fl.Stdout -split "`r?`n") | Select-Object -Last 60) -join "`n") + "`n$fence"
                Finish-Run 'ci-failed' 5 ("CI run $($tagRun.databaseId) for $($script:tag) concluded " +
                    "$($tagRun.conclusion); branch+tag pushed, not installed.") @($tail)
            }
        }
        Write-Host "waiting for CI release $($script:tag) ..."
        Start-Sleep -Seconds 60
    }
    if ($published) {
        $upd = Invoke-AgentUpdate
        if ($upd.Code -ne 0) {
            Finish-Run 'install-failed' 5 "landed $($script:tag) but 'prime-agent.cmd update' exited $($upd.Code): $($upd.Stderr.Trim())"
        }
        Finish-Run 'installed' 0 "landed $($script:tag) ($($script:mergeSha.Substring(0,7))) and installed via update."
    } else {
        $script:warnings.Add("release $($script:tag) did not publish within 75 min; will install on next run")
        Finish-Run 'install-pending' 0 "landed $($script:tag); CI release not published yet - next run's catch-up installs it."
    }
}

Finish-Run 'landed' 0 ("landed " + $(if ($needsMerge) { "merge $($script:mergeSha.Substring(0,7))" } else { 'release on HEAD' }) +
    " tagged $($script:tag)" + $(if ($NoPush) { ' (not pushed)' } else { ' and pushed' }) + '.')

} catch {
    # Unexpected failure outside the Finish-Run paths: still report + release lock.
    try {
        $fence = [string][char]96 * 3
        Finish-Run 'error' 4 "unexpected error: $_" @(
            "## Unexpected error`n$fence`n" +
            "$($_.Exception.GetType().FullName): $($_.Exception.Message)`n" +
            "$($_.InvocationInfo.PositionMessage)`n" +
            "$($_.ScriptStackTrace)`n$fence")
    } catch { exit 4 }
} finally {
    # A stop mid-body (Ctrl+C, terminating pipeline error) reaches here without
    # a Finish-Run: still record the outcome so the next run does not treat a
    # leftover worktree as review state without a result.
    if (-not $script:finished) {
        try {
            $script:result = 'aborted'
            $script:exitCode = 4
            Write-LastRun
        } catch { }
    }
    try { Stop-Transcript | Out-Null } catch {}
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}
