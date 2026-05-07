<#
.SYNOPSIS
    Start strIDEterm dev environment against an isolated dev data directory.
.DESCRIPTION
    Same orchestration as production runs (port cleanup, stale process kill,
    Vite + backend tsc watch + frontend build watch + Electron, graceful
    Ctrl+C), but forces Electron to use ~/.strideterm-dev as its data
    directory via STRIDETERM_DATA_DIR.

    The frontend build watcher (`vite build --watch`) keeps dist/ fresh so
    mobile / remote clients (served from dist/ by remote-server.ts) see
    edits without manual `npm run build`. Vite dev server still drives HMR
    for the Electron desktop renderer.

    This makes state, credentials, logs, electron session data, and the
    single-instance lock separate from the default ~/.strideterm install — so
    dev can run side-by-side with a production strIDEterm without clobbering
    state.

    Run from the project root:  .\dev.ps1
    Stop with Ctrl+C - all child processes (Vite, watchers, Electron) will
    be terminated.
#>

param(
    [int]$Port = 1420,
    [int]$TimeoutSeconds = 30,
    [string]$DataDir = (Join-Path $env:USERPROFILE '.strideterm-dev'),
    # Auto-restart Electron whenever tsc --watch rewrites a file under
    # dist-electron/. Vite handles frontend HMR on its own, but Electron's
    # main process loads backend modules once at startup — without this the
    # user has to manually Ctrl+C and re-run the script after every backend
    # edit to pick up new IPC handlers, runtime methods, etc.
    [switch]$NoAutoRestart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:viteProc = $null
$script:backendProc = $null
$script:preloadProc = $null
$script:frontendBuildProc = $null
$script:electronProc = $null
$script:exiting = $false
$script:backendWatcher = $null
$script:backendChangeAt = [DateTime]::MinValue
$script:backendChangePending = $false
$script:watcherEventIds = @()
# Set after Electron has started — file changes within this many seconds of
# Electron startup are treated as the tsc --watch initial-compile re-emit
# (we just did a one-shot, watcher then re-emits the same files) rather than
# real source edits, so we don't auto-restart Electron immediately after it
# launched.
$script:electronStartedAt = [DateTime]::MinValue
$script:watcherWarmupSec = 15

# --- Helpers ---------------------------------------------------------------

function Write-Step($msg) { Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $msg" -ForegroundColor Red }

function Stop-ProcessTree([int]$procId) {
    try {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue
        foreach ($child in $children) {
            Stop-ProcessTree $child.ProcessId
        }
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    catch {
        # Ignore - process may already be gone
    }
}

function Get-PortProcess([int]$portNum) {
    $conn = Get-NetTCPConnection -LocalPort $portNum -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    }
    return $null
}

function Test-PortOpen([int]$portNum) {
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $tcp.Connect('127.0.0.1', $portNum)
        $tcp.Close()
        return $true
    }
    catch {
        return $false
    }
}

function Kill-PortOwner([int]$portNum) {
    # Method 1: PowerShell API
    $blocker = Get-PortProcess $portNum
    if ($blocker) {
        Write-Warn "Port $portNum held by $($blocker.ProcessName) (PID $($blocker.Id)) - killing..."
        Stop-ProcessTree $blocker.Id
        Start-Sleep -Milliseconds 1000
        return
    }

    # Method 2: netstat fallback (catches cases Get-NetTCPConnection misses)
    if (Test-PortOpen $portNum) {
        Write-Warn "Port $portNum is responding but owner not found via API - using netstat..."
        $lines = netstat -ano | Select-String ":$portNum\s" | Select-String 'LISTENING'
        foreach ($line in $lines) {
            $parts = $line.ToString().Trim() -split '\s+'
            $ownerPid = $parts[-1]
            if ($ownerPid -match '^\d+$') {
                $proc = Get-Process -Id ([int]$ownerPid) -ErrorAction SilentlyContinue
                $procName = if ($proc) { $proc.ProcessName } else { 'unknown' }
                Write-Warn "Found via netstat: $procName (PID $ownerPid) - killing..."
                Stop-ProcessTree ([int]$ownerPid)
                Start-Sleep -Milliseconds 1000
            }
        }
    }
}

function Start-ElectronProcess {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev:electron' `
        -WorkingDirectory $PSScriptRoot `
        -PassThru -NoNewWindow
}

function Restart-Electron {
    if (-not $script:electronProc) { return }
    Write-Step 'Backend rebuilt — restarting Electron...'
    if (-not $script:electronProc.HasExited) {
        Stop-ProcessTree $script:electronProc.Id
    }
    # Kill any orphaned electron processes from the previous instance so
    # the single-instance lock isn't held by a zombie.
    $orphaned = Get-Process -Name electron -ErrorAction SilentlyContinue
    if ($orphaned) {
        $orphaned | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    $script:electronProc = Start-ElectronProcess
    if (!$script:electronProc -or $script:electronProc.HasExited) {
        Write-Err 'Failed to restart Electron.'
        return
    }
    # Reset the warmup window so subsequent restarts (e.g. from a Reset that
    # restarts Electron) also ignore the immediate-aftermath dist-electron
    # writes if any are still in flight.
    $script:electronStartedAt = Get-Date
    Write-Ok "Electron restarted (PID $($script:electronProc.Id))."
}

function Cleanup {
    if ($script:exiting) { return }
    $script:exiting = $true

    Write-Step 'Shutting down...'

    # Stop the file watcher first so it doesn't trigger a restart during shutdown.
    if ($script:backendWatcher) {
        $script:backendWatcher.EnableRaisingEvents = $false
        foreach ($id in $script:watcherEventIds) {
            Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue
        }
        $script:backendWatcher.Dispose()
        $script:backendWatcher = $null
    }

    if ($script:electronProc -and !$script:electronProc.HasExited) {
        Write-Step 'Stopping Electron...'
        Stop-ProcessTree $script:electronProc.Id
    }

    if ($script:backendProc -and !$script:backendProc.HasExited) {
        Write-Step 'Stopping backend tsc watch...'
        Stop-ProcessTree $script:backendProc.Id
    }

    if ($script:preloadProc -and !$script:preloadProc.HasExited) {
        Write-Step 'Stopping preload tsc watch...'
        Stop-ProcessTree $script:preloadProc.Id
    }

    if ($script:frontendBuildProc -and !$script:frontendBuildProc.HasExited) {
        Write-Step 'Stopping frontend build watcher...'
        Stop-ProcessTree $script:frontendBuildProc.Id
    }

    if ($script:viteProc -and !$script:viteProc.HasExited) {
        Write-Step 'Stopping Vite...'
        Stop-ProcessTree $script:viteProc.Id
    }

    # Kill any orphaned electron processes
    $orphanedElectron = Get-Process -Name electron -ErrorAction SilentlyContinue
    if ($orphanedElectron) {
        Write-Warn "Killing $($orphanedElectron.Count) orphaned electron process(es)..."
        $orphanedElectron | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }

    # Final check - kill anything still on the port
    $leftover = Get-PortProcess $Port
    if ($leftover) {
        Write-Warn "Killing leftover process on port $Port (PID $($leftover.Id), $($leftover.ProcessName))"
        Stop-Process -Id $leftover.Id -Force -ErrorAction SilentlyContinue
    }

    Write-Ok 'Dev environment stopped.'
}

# --- Ctrl+C handler -------------------------------------------------------

$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Cleanup }

try {

# --- Step 0: Configure isolated data dir ----------------------------------

# electron/main.ts reads STRIDETERM_DATA_DIR (or --data-dir) and:
#   - sets state/credentials/logs under $DataDir
#   - sets Electron userData to $DataDir\electron-data (isolates cache + single-instance lock)
#   - renames app to strideterm-<basename($DataDir)> so it does NOT fight prod for the lock
$env:STRIDETERM_DATA_DIR = $DataDir
# Default log level "trace" in dev — surfaces every detector decision, IPC
# call, telegram message, etc. for debugging. Override by setting
# STRIDETERM_LOG_LEVEL before invoking this script (e.g. 'info' or 'warn').
if (-not $env:STRIDETERM_LOG_LEVEL) {
    $env:STRIDETERM_LOG_LEVEL = 'trace'
}
# Default remote-access port in dev to 43124 so it doesn't collide with the
# production strideterm (default 43123). Without this, both instances fight
# for the same port and the second one logs EADDRINUSE on every start.
if (-not $env:STRIDETERM_REMOTE_PORT) {
    $env:STRIDETERM_REMOTE_PORT = '43124'
}
if (-not (Test-Path $DataDir)) {
    Write-Step "Creating data dir $DataDir..."
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
Write-Ok "Using isolated data dir: $DataDir (log level: $($env:STRIDETERM_LOG_LEVEL))"

# --- Step 1: Kill stale Electron processes ---------------------------------

Write-Step 'Checking for stale Electron processes...'
$staleElectron = Get-Process -Name electron -ErrorAction SilentlyContinue
if ($staleElectron) {
    Write-Warn "Found $($staleElectron.Count) stale electron process(es) - killing..."
    $staleElectron | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1000
}

# Clear Electron disk cache under the isolated data dir
# (main.ts maps userData -> $DataDir\electron-data when STRIDETERM_DATA_DIR is set).
$electronDataDir = Join-Path $DataDir 'electron-data'
foreach ($cacheName in @('Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Code Cache')) {
    $dir = Join-Path $electronDataDir $cacheName
    if (Test-Path $dir) {
        Write-Step "Clearing $cacheName..."
        Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- Step 2: Free port ----------------------------------------------------

Write-Step "Checking port $Port..."
Kill-PortOwner $Port

if (Test-PortOpen $Port) {
    Write-Err "Port $Port is STILL occupied after cleanup. Aborting."
    exit 1
}
Write-Ok "Port $Port is free."

# --- Step 3: Start Vite ---------------------------------------------------

Write-Step 'Starting Vite dev server...'
$script:viteProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev:web' `
    -WorkingDirectory $PSScriptRoot `
    -PassThru -NoNewWindow

if (!$script:viteProc -or $script:viteProc.HasExited) {
    Write-Err 'Failed to start Vite. Aborting.'
    exit 1
}
Write-Ok "Vite started (PID $($script:viteProc.Id))."

# --- Step 4: Wait for Vite to listen --------------------------------------

Write-Step "Waiting for Vite on port $Port (timeout ${TimeoutSeconds}s)..."
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$ready = $false

while ((Get-Date) -lt $deadline) {
    if ($script:viteProc.HasExited) {
        Write-Err "Vite exited unexpectedly with code $($script:viteProc.ExitCode)."
        exit 1
    }
    if (Test-PortOpen $Port) {
        $ready = $true
        break
    }
    Start-Sleep -Milliseconds 300
}

if (-not $ready) {
    Write-Err "Vite did not start listening on port $Port within ${TimeoutSeconds}s. Aborting."
    Cleanup
    exit 1
}
Write-Ok "Vite is ready on http://127.0.0.1:$Port"

# --- Step 4b: One-shot backend + preload compile BEFORE Electron starts ---

# Why a one-shot here, even though we also start tsc --watch below: relying on
# the watcher's initial compile races with Electron startup. The watcher emits
# files incrementally as it processes them — Electron can latch onto a partial
# dist-electron/ where main.js is fresh but agent-task-files.js is still the
# previous run's output, and silently keep running stale modules until the
# user manually restarts. The one-shot is synchronous (-Wait), so dist-electron
# is guaranteed coherent before we hand it to Electron. tsc --watch then takes
# over for incremental rebuilds during the session.

$mainEntry = Join-Path $PSScriptRoot 'dist-electron/electron/main.js'
$preloadEntry = Join-Path $PSScriptRoot 'dist-electron/electron/preload.cjs'

Write-Step 'Compiling backend + preload (one-shot, before Electron)...'
$backendBuildArgs = @('/c','npx tsc -p tsconfig.backend.json')
$preloadBuildArgs = @('/c','npx tsc -p tsconfig.preload.json')
$backendBuild = Start-Process -FilePath 'cmd.exe' -ArgumentList $backendBuildArgs `
    -WorkingDirectory $PSScriptRoot -PassThru -NoNewWindow
$preloadBuild = Start-Process -FilePath 'cmd.exe' -ArgumentList $preloadBuildArgs `
    -WorkingDirectory $PSScriptRoot -PassThru -NoNewWindow

# Wait for both to finish in parallel rather than chaining sequentially —
# they're independent tsc runs against different tsconfigs.
$buildTimeoutSec = 120
$buildDeadline = (Get-Date).AddSeconds($buildTimeoutSec)
while (((-not $backendBuild.HasExited) -or (-not $preloadBuild.HasExited)) -and ((Get-Date) -lt $buildDeadline)) {
    Start-Sleep -Milliseconds 200
}
if (-not $backendBuild.HasExited) {
    Write-Err "Backend compile timed out after ${buildTimeoutSec}s. Aborting."
    Stop-ProcessTree $backendBuild.Id
    Stop-ProcessTree $preloadBuild.Id
    Cleanup
    exit 1
}
if (-not $preloadBuild.HasExited) {
    Write-Err "Preload compile timed out after ${buildTimeoutSec}s. Aborting."
    Stop-ProcessTree $preloadBuild.Id
    Cleanup
    exit 1
}
if ($backendBuild.ExitCode -ne 0) {
    Write-Err "Backend compile failed (exit $($backendBuild.ExitCode))."
    Cleanup
    exit 1
}
if ($preloadBuild.ExitCode -ne 0) {
    Write-Err "Preload compile failed (exit $($preloadBuild.ExitCode))."
    Cleanup
    exit 1
}
if (-not (Test-Path $mainEntry)) {
    Write-Err "Backend compile reported success but $mainEntry is missing. Aborting."
    Cleanup
    exit 1
}
if (-not (Test-Path $preloadEntry)) {
    Write-Err "Preload compile reported success but $preloadEntry is missing. Aborting."
    Cleanup
    exit 1
}
Write-Ok 'Backend + preload compiled (dist-electron/ ready).'

# --- Step 4c: Start tsc --watch for ongoing incremental compiles ---------

# After the one-shot above, dist-electron is fresh. The watchers below take
# over so edits during the dev session keep flowing through to Electron via
# the dist-electron file watcher (Step 5b auto-restart).

Write-Step 'Starting backend TypeScript watcher (incremental)...'
$script:backendProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev:backend' `
    -WorkingDirectory $PSScriptRoot `
    -PassThru -NoNewWindow

if (!$script:backendProc -or $script:backendProc.HasExited) {
    Write-Err 'Failed to start backend watcher. Aborting.'
    Cleanup
    exit 1
}
Write-Ok "Backend watcher started (PID $($script:backendProc.Id))."

# `tsconfig.preload.json` builds electron/preload.cts → dist-electron/electron/preload.cjs.
# We need its own watch process — `dev:backend` only covers tsconfig.backend.json
# and electron loads the preload script as a separate context-isolated bundle.
# Without this watcher, every change to electron/preload.cts (e.g. a new
# contextBridge entry) silently runs against the LAST manually-built preload,
# so the renderer sees window.strideterm without the new field. The symptom
# is a feature that "just doesn't react" — typeof api.someNewMethod ===
# "function" returns false and the gated code path is skipped.

Write-Step 'Starting preload TypeScript watcher (incremental)...'
$script:preloadProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev:preload' `
    -WorkingDirectory $PSScriptRoot `
    -PassThru -NoNewWindow

if (!$script:preloadProc -or $script:preloadProc.HasExited) {
    Write-Err 'Failed to start preload watcher. Aborting.'
    Cleanup
    exit 1
}
Write-Ok "Preload watcher started (PID $($script:preloadProc.Id))."

# --- Step 4d: Start frontend build watcher (for remote-served dist/) ------

# Vite dev server (Step 3) drives HMR for the Electron desktop renderer, but
# the remote server (mobile / web clients on the LAN) serves static files
# straight from dist/ — see electron/main.ts: staticRoot = path.join(...,
# "dist"). Without this watcher, every frontend edit ships to desktop via
# HMR but mobile is stuck on whatever was in dist/ from the last manual
# `npm run build`. Running `vite build --watch` in parallel keeps dist/
# fresh on every src/ change.

Write-Step 'Starting frontend build watcher (vite build --watch) for remote dist/...'
# VITE_BUILD_WATCH=1 tells vite.config.ts to (a) skip emptyOutDir so existing
# chunks survive a rebuild and live pages don't lose dynamically-imported
# modules, and (b) drop content hashes from filenames so chunks overwrite
# in place instead of accumulating alongside their predecessors.
$script:frontendBuildProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','set VITE_BUILD_WATCH=1 && npx vite build --watch' `
    -WorkingDirectory $PSScriptRoot `
    -PassThru -NoNewWindow

if (!$script:frontendBuildProc -or $script:frontendBuildProc.HasExited) {
    Write-Warn 'Frontend build watcher failed to start. Mobile/remote clients will see stale dist/. Continuing.'
    $script:frontendBuildProc = $null
}
else {
    Write-Ok "Frontend build watcher started (PID $($script:frontendBuildProc.Id))."
    Write-Warn 'Note: first dist/ rebuild takes ~20-30s — mobile remote will be stale until then.'
}

# --- Step 5: Start Electron -----------------------------------------------

Write-Step 'Starting Electron...'
$script:electronProc = Start-ElectronProcess

if (!$script:electronProc -or $script:electronProc.HasExited) {
    Write-Err 'Failed to start Electron. Aborting.'
    Cleanup
    exit 1
}
$script:electronStartedAt = Get-Date
Write-Ok "Electron started (PID $($script:electronProc.Id))."

# --- Step 5b: Watch dist-electron for backend rebuilds --------------------

if (-not $NoAutoRestart) {
    $watchPath = Join-Path $PSScriptRoot 'dist-electron'
    if (Test-Path $watchPath) {
        Write-Step "Watching $watchPath for backend rebuilds (auto-restart Electron)..."
        $script:backendWatcher = New-Object System.IO.FileSystemWatcher
        $script:backendWatcher.Path = $watchPath
        $script:backendWatcher.Filter = '*.js'
        $script:backendWatcher.IncludeSubdirectories = $true
        $script:backendWatcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName

        $onChange = {
            # Suppress the watcher during Electron's startup window — the tsc
            # --watch processes do their own initial full compile right after
            # we hand off, which writes the same dist-electron files we just
            # produced one-shot. Without this guard the watcher would catch
            # those writes and bounce Electron seconds after it launched.
            if ($script:electronStartedAt -ne [DateTime]::MinValue -and
                ((Get-Date) - $script:electronStartedAt).TotalSeconds -lt $script:watcherWarmupSec) {
                return
            }
            $script:backendChangeAt = Get-Date
            $script:backendChangePending = $true
        }
        $idChanged = (Register-ObjectEvent -InputObject $script:backendWatcher -EventName Changed -Action $onChange).Name
        $idCreated = (Register-ObjectEvent -InputObject $script:backendWatcher -EventName Created -Action $onChange).Name
        $script:watcherEventIds = @($idChanged, $idCreated)
        $script:backendWatcher.EnableRaisingEvents = $true
    }
    else {
        Write-Warn "Watch path $watchPath does not exist; auto-restart disabled."
    }
}
else {
    Write-Warn 'Auto-restart disabled (--NoAutoRestart).'
}

Write-Host ''
Write-Ok '=== Dev environment is running (isolated data dir) ==='
Write-Host "    Vite:     http://127.0.0.1:$Port  (PID $($script:viteProc.Id))" -ForegroundColor Gray
Write-Host "    Backend:  tsc --watch  (PID $($script:backendProc.Id))" -ForegroundColor Gray
if ($script:preloadProc) {
    Write-Host "    Preload:  tsc --watch  (PID $($script:preloadProc.Id))" -ForegroundColor Gray
}
if ($script:frontendBuildProc) {
    Write-Host "    Frontend: vite build --watch  (PID $($script:frontendBuildProc.Id))  → dist/ for remote clients" -ForegroundColor Gray
}
Write-Host "    Electron: PID $($script:electronProc.Id)" -ForegroundColor Gray
Write-Host "    Data:     $DataDir" -ForegroundColor Gray
if (-not $NoAutoRestart -and $script:backendWatcher) {
    Write-Host '    Auto-restart Electron on backend changes: ON' -ForegroundColor Gray
}
Write-Host '    Press Ctrl+C to stop all.' -ForegroundColor Gray
Write-Host ''

# --- Step 6: Wait for Electron to exit (and watch for backend rebuilds) ---

$backendWarned = $false
$preloadWarned = $false
$frontendBuildWarned = $false
$RestartDebounceMs = 1500   # wait this long after the LAST file change before restarting

while ($script:exiting -eq $false -and $script:electronProc -and -not $script:electronProc.HasExited) {
    if ($script:backendProc.HasExited -and -not $backendWarned) {
        Write-Warn "Backend tsc watch exited (code $($script:backendProc.ExitCode)) — TypeScript changes won't recompile."
        $backendWarned = $true
    }

    if ($script:preloadProc -and $script:preloadProc.HasExited -and -not $preloadWarned) {
        Write-Warn "Preload tsc watch exited (code $($script:preloadProc.ExitCode)) — preload.cts changes won't recompile."
        $preloadWarned = $true
    }

    if ($script:frontendBuildProc -and $script:frontendBuildProc.HasExited -and -not $frontendBuildWarned) {
        Write-Warn "Frontend build watcher exited (code $($script:frontendBuildProc.ExitCode)) — mobile/remote clients will see stale dist/."
        $frontendBuildWarned = $true
    }

    # Auto-restart Electron when tsc-watch finishes a rebuild burst.
    if ($script:backendChangePending) {
        $sinceMs = ((Get-Date) - $script:backendChangeAt).TotalMilliseconds
        if ($sinceMs -ge $RestartDebounceMs) {
            $script:backendChangePending = $false
            Restart-Electron
        }
    }

    if ($script:viteProc.HasExited) {
        Write-Warn 'Vite crashed! Restarting...'
        $script:viteProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev:web' `
            -WorkingDirectory $PSScriptRoot `
            -PassThru -NoNewWindow

        $retryDeadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $retryDeadline) {
            if (Test-PortOpen $Port) { break }
            Start-Sleep -Milliseconds 300
        }
        if (Test-PortOpen $Port) {
            Write-Ok 'Vite restarted successfully.'
        }
        else {
            Write-Err 'Vite failed to restart. Stopping.'
            Cleanup
            exit 1
        }
    }
    Start-Sleep -Milliseconds 500
}

Write-Step "Electron exited (code $($script:electronProc.ExitCode))."
Cleanup

}
catch {
    Write-Err "Error: $_"
    Cleanup
    exit 1
}
