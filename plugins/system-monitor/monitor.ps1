
# strIDEterm System Monitor - live dashboard
# Refreshes every 2 seconds with CPU, memory, disk, network and top processes.

$Host.UI.RawUI.WindowTitle = "System Monitor"

function Show-Dashboard {
    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $os = Get-CimInstance Win32_OperatingSystem
    $totalMem = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $freeMem = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    $usedMem = [math]::Round($totalMem - $freeMem, 1)
    $memPct = [math]::Round(($usedMem / $totalMem) * 100, 0)
    $uptime = (Get-Date) - $os.LastBootUpTime

    Clear-Host
    Write-Host ""
    Write-Host "  =========================================" -ForegroundColor DarkYellow
    Write-Host "   strIDEterm System Monitor" -ForegroundColor Yellow
    Write-Host "  =========================================" -ForegroundColor DarkYellow
    Write-Host ""
    Write-Host "  CPU Usage:    " -NoNewline; Write-Host "$cpu%" -ForegroundColor $(if ($cpu -gt 80) { "Red" } elseif ($cpu -gt 50) { "Yellow" } else { "Green" })

    $bar = "[" + ("#" * [math]::Round($memPct / 5)) + ("." * (20 - [math]::Round($memPct / 5))) + "]"
    Write-Host "  Memory:       " -NoNewline; Write-Host "$usedMem / $totalMem GB ($memPct%) $bar" -ForegroundColor $(if ($memPct -gt 85) { "Red" } elseif ($memPct -gt 60) { "Yellow" } else { "Green" })

    Write-Host "  Uptime:       $([math]::Floor($uptime.TotalDays))d $($uptime.Hours)h $($uptime.Minutes)m" -ForegroundColor Cyan
    Write-Host ""

    # Disk
    Write-Host "  --- Disks ---" -ForegroundColor DarkYellow
    Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
        $total = [math]::Round($_.Size / 1GB, 1)
        $free = [math]::Round($_.FreeSpace / 1GB, 1)
        $used = [math]::Round($total - $free, 1)
        $pct = if ($total -gt 0) { [math]::Round(($used / $total) * 100, 0) } else { 0 }
        Write-Host "  $($_.DeviceID) " -NoNewline
        Write-Host "$used / $total GB ($pct%)" -ForegroundColor $(if ($pct -gt 90) { "Red" } elseif ($pct -gt 70) { "Yellow" } else { "Green" })
    }
    Write-Host ""

    # Network
    Write-Host "  --- Network ---" -ForegroundColor DarkYellow
    Get-NetAdapter | Where-Object Status -eq "Up" | Select-Object -First 3 | ForEach-Object {
        $speed = if ($_.LinkSpeed) { $_.LinkSpeed } else { "?" }
        Write-Host "  $($_.Name): $($_.Status) ($speed)" -ForegroundColor Green
    }
    Write-Host ""

    # Top processes
    Write-Host "  --- Top Processes (by CPU) ---" -ForegroundColor DarkYellow
    $header = "  {0,-6} {1,-28} {2,6} {3,10}" -f "PID", "Name", "CPU%", "Mem(MB)"
    Write-Host $header -ForegroundColor DarkGray
    Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 | ForEach-Object {
        $memMB = [math]::Round($_.WorkingSet64 / 1MB, 0)
        $cpuSec = [math]::Round($_.CPU, 1)
        $procName = $_.ProcessName
        if ($procName.Length -gt 28) { $procName = $procName.Substring(0, 28) }
        $line = "  {0,-6} {1,-28} {2,6} {3,10}" -f $_.Id, $procName, $cpuSec, $memMB
        Write-Host $line
    }
    Write-Host ""
    Write-Host "  Refreshing every 2s... (Ctrl+C to stop)" -ForegroundColor DarkGray
}

while ($true) {
    Show-Dashboard
    Start-Sleep -Seconds 2
}
