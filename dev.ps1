<#
.SYNOPSIS
    Start strIDEterm dev environment against an isolated dev data directory.
.DESCRIPTION
    Same orchestration as production runs (port cleanup, stale process kill,
    Vite + backend tsc watch + Electron, graceful Ctrl+C), but forces Electron
    to use ~/.strideterm-dev as its data directory via STRIDETERM_DATA_DIR.

    This makes state, credentials, logs, electron session data, and the
    single-instance lock separate from the default ~/.strideterm install — so
    dev can run side-by-side with a production strIDEterm without clobbering
    state.

    Run from the project root:  .\dev.ps1
    Stop with Ctrl+C - Vite, backend watcher, and Electron will all be terminated.
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
$script:electronProc = $null
$script:exiting = $false
$script:backendWatcher = $null
$script:backendChangeAt = [DateTime]::MinValue
$script:backendChangePending = $false
$script:watcherEventIds = @()

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

# --- Step 4b: Start backend TS watcher and wait for compiled main.js ------

$mainEntry = Join-Path $PSScriptRoot 'dist-electron/electron/main.js'

Write-Step 'Starting backend TypeScript watcher...'
$script:backendProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev:backend' `
    -WorkingDirectory $PSScriptRoot `
    -PassThru -NoNewWindow

if (!$script:backendProc -or $script:backendProc.HasExited) {
    Write-Err 'Failed to start backend watcher. Aborting.'
    Cleanup
    exit 1
}
Write-Ok "Backend watcher started (PID $($script:backendProc.Id))."

$backendTimeout = 60
Write-Step "Waiting for backend build output (timeout ${backendTimeout}s)..."
$deadline = (Get-Date).AddSeconds($backendTimeout)
$compiled = $false
while ((Get-Date) -lt $deadline) {
    if ($script:backendProc.HasExited) {
        Write-Err "Backend watcher exited unexpectedly with code $($script:backendProc.ExitCode)."
        Cleanup
        exit 1
    }
    if (Test-Path $mainEntry) {
        $compiled = $true
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $compiled) {
    Write-Err "Backend did not produce $mainEntry within ${backendTimeout}s. Aborting."
    Cleanup
    exit 1
}
Write-Ok 'Backend compiled (dist-electron/ ready).'

# --- Step 5: Start Electron -----------------------------------------------

Write-Step 'Starting Electron...'
$script:electronProc = Start-ElectronProcess

if (!$script:electronProc -or $script:electronProc.HasExited) {
    Write-Err 'Failed to start Electron. Aborting.'
    Cleanup
    exit 1
}
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
Write-Host "    Electron: PID $($script:electronProc.Id)" -ForegroundColor Gray
Write-Host "    Data:     $DataDir" -ForegroundColor Gray
if (-not $NoAutoRestart -and $script:backendWatcher) {
    Write-Host '    Auto-restart Electron on backend changes: ON' -ForegroundColor Gray
}
Write-Host '    Press Ctrl+C to stop all.' -ForegroundColor Gray
Write-Host ''

# --- Step 6: Wait for Electron to exit (and watch for backend rebuilds) ---

$backendWarned = $false
$RestartDebounceMs = 1500   # wait this long after the LAST file change before restarting

while ($script:exiting -eq $false -and $script:electronProc -and -not $script:electronProc.HasExited) {
    if ($script:backendProc.HasExited -and -not $backendWarned) {
        Write-Warn "Backend tsc watch exited (code $($script:backendProc.ExitCode)) — TypeScript changes won't recompile."
        $backendWarned = $true
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
