# Windows Setup

The native Windows port runs Prime Agent directly on Windows — no WSL, Git Bash, Node.js, or Bun required on `PATH`. Windows 10/11 on x64 (not ARM64).

## Shell

On Windows the agent's shell tool uses native PowerShell. Resolution order:

1. `shellPath` from `~/.prime/agent/settings.json` (explicit override, wins if set)
2. PowerShell 7 at `C:\Program Files\PowerShell\7\pwsh.exe` (preferred)
3. In-box Windows PowerShell 5.1 at `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

PowerShell is resolved from these absolute paths only — never `PATH` — so a repo-controlled `where.exe`/`PATH` cannot pick the shell. Install [PowerShell 7](https://github.com/PowerShell/PowerShell) for the best experience; without it the port falls back to Windows PowerShell 5.1 automatically.

Windows PowerShell 5.1 caveat: `&&` and `||` are not supported (they are a PS 7 feature). Shell commands using them fail under 5.1; use `;` or `if ($?)` instead. This is the main reason to install PowerShell 7.

### Custom shell path

```json
{
  "shellPath": "C:\\tools\\my-shell.exe"
}
```

`pwsh`/`powershell` get `-NoLogo -NoProfile -NonInteractive -EncodedCommand`; `cmd` gets `/d /s /c`; anything else gets `-c`.

## Installation

The Windows fork publishes releases at [prime-agent-windows releases](https://github.com/KushBeaverTTV/prime-agent-windows/releases). Download the release zip, `install-windows.ps1`, and `SHA256SUMS` into one directory, verify the archive hash, then:

```powershell
powershell -NoProfile -File .\install-windows.ps1 -ArchivePath .\prime-agent-<version>-windows-x64-baseline-<revision>.zip -Sha256 <sha256> -ManifestUrl https://github.com/KushBeaverTTV/prime-agent-windows/releases/latest/download/windows.json
```

The installer places side-by-side immutable releases under `%LOCALAPPDATA%\Programs\PrimeAgentWindows\releases\`, activates one atomically via `active.json` (which also retains the previous release for rollback), and creates `Prime Agent` and `Prime Agent Dashboard` shortcuts on the Desktop. Launch with `%LOCALAPPDATA%\Programs\PrimeAgentWindows\prime-agent.cmd`, then run `/login` on first launch.

## Updates

```powershell
prime-agent.cmd update              # Update to the newest Windows release
prime-agent.cmd update --force      # Reinstall even when already current
prime-agent.cmd update --rollback   # Roll back to the previous release
```

`update` fetches the release manifest (`windows.json`), verifies the archive SHA-256, and invokes `install-windows.ps1` non-interactively; `--rollback` switches activation back to the retained previous release. The build is not code-signed — SmartScreen may prompt on first launch, and unsigned `.ps1` scripts need an execution policy that allows them (the installer never changes execution policy).

## Upstream sync

Windows releases are produced by the automated upstream-sync pipeline: `scripts/sync-upstream.ps1` (scheduled task `Prima Upstream Sync`, daily 04:30; `npm run sync:upstream`) merges `origin/main` into `windows-native` in a scratch worktree, auto-resolves changelog/lockfile/generated-model conflicts, delegates remaining conflicts to `prime-agent -p`, and lands the merge only when every gate passes (typecheck, test policy, native unit tests, the Python runtime harness, a full release build, the isolated installer test, and the packaged-artifact checks). A passing run tags `windows-v<version>-r<revision>`, pushes to the fork, and installs the CI-published release via `prime-agent update`. Failed gates or unresolved conflicts stop the run and leave the worktree plus a report under `artifacts/upstream-sync/`; nothing is landed, and raw upstream packages are never installed. See AGENTS.md for the full contract and manual switches.
