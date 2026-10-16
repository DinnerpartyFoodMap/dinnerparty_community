<#
.SYNOPSIS
    yUYUko Food MAP - Backend, Memurai & NapCat auto-restart watchdog.
.DESCRIPTION
    Continuously monitors Memurai (Redis) service, the Node.js backend and,
    when the QQ Bot is enabled, NapCat's local OneBot port.
    Automatically restarts them on failure. Logs all actions to file.
    NapCat is a GUI QQ client that needs the user's saved login, so it is only
    (re)started from an interactive user session (install-watchdog-task.ps1
    -WithNapCat); a SYSTEM watchdog only reports it.
.NOTES
    Run as Administrator to manage Windows services.
    Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ".\script\watchdog.ps1"
           powershell -NoProfile -ExecutionPolicy Bypass -File ".\script\watchdog.ps1" -NapCatOnly
#>

param(
    [int]$CheckIntervalSeconds = 10,
    # 0 = read PORT from backend\.env, falling back to the backend default 7000
    [int]$BackendPort = 0,
    [string]$BackendDir = $null,
    [string]$LogDir = $null,
    [string]$MemuraiServiceName = "Memurai",
    [string[]]$MemuraiFallbackNames = @("Redis", "memurai", "redis"),
    # NapCat folder containing NapCatWinBootMain.exe (default: QQ_BOT_NAPCAT_DIR in backend\.env)
    [string]$NapCatDir = $null,
    # Quick-login account (default: QQ_BOT_SELF_ID); port default: from QQ_BOT_WS_URL, else 3001
    [string]$NapCatAccount = $null,
    [int]$NapCatPort = 0,
    [int]$NapCatRestartCooldownSeconds = 300,
    # Only watch NapCat (the user-session task); Memurai and the backend stay with the SYSTEM task
    [switch]$NapCatOnly
)

# ====================== Paths ======================
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot

if (-not $BackendDir) {
    $BackendDir = Join-Path $ProjectRoot "backend"
}

if (-not $LogDir) {
    $LogDir = Join-Path $ScriptRoot "logs"
}
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$LogFile = Join-Path $LogDir "watchdog_$(Get-Date -Format 'yyyy-MM-dd').log"
if ($NapCatOnly) { $LogFile = Join-Path $LogDir "watchdog_napcat_$(Get-Date -Format 'yyyy-MM-dd').log" }

# ====================== backend\.env ======================
function Read-BackendEnv {
    param([string]$Dir)
    $values = @{}
    $envFile = Join-Path $Dir ".env"
    if (-not (Test-Path $envFile)) { return $values }
    foreach ($line in Get-Content -Path $envFile -Encoding UTF8 -ErrorAction SilentlyContinue) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $values[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
        }
    }
    return $values
}

$BackendEnv = Read-BackendEnv -Dir $BackendDir
# Watch the port the backend really listens on; a mismatch would restart a healthy backend forever.
if ($BackendPort -le 0) {
    $BackendPort = 7000
    if ($BackendEnv['PORT'] -match '^\d+$') { $BackendPort = [int]$BackendEnv['PORT'] }
}

$NapCatEnabled = ($BackendEnv['QQ_BOT_ENABLED'] -match '^(1|true|yes|on)$')
if (-not $NapCatDir) { $NapCatDir = $BackendEnv['QQ_BOT_NAPCAT_DIR'] }
if (-not $NapCatAccount) { $NapCatAccount = $BackendEnv['QQ_BOT_SELF_ID'] }
if ($NapCatPort -le 0) {
    $NapCatPort = 3001
    if ($BackendEnv['QQ_BOT_WS_URL'] -match ':(\d+)(/|$)') { $NapCatPort = [int]$Matches[1] }
}
$NapCatMonitored = $NapCatEnabled -and [bool]$NapCatDir

# ====================== Helpers ======================
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Write-Host $line
    try {
        Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch { }
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ====================== Memurai Management ======================
function Get-MemuraiServiceName {
    $namesToTry = @($MemuraiServiceName) + $MemuraiFallbackNames
    foreach ($name in $namesToTry) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc) { return $name }
    }
    $all = Get-Service -ErrorAction SilentlyContinue | Where-Object {
        $_.DisplayName -match 'redis|memurai'
    }
    if ($all) { return $all[0].Name }
    return $null
}

function Test-MemuraiRunning {
    param([string]$ServiceName)
    if (-not $ServiceName) { return $false }

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') { return $false }
    if (-not $svc) { return $false }

    # Double-check with redis-cli ping
    $cli = $null
    $found = Get-Command redis-cli -ErrorAction SilentlyContinue
    if ($found) { $cli = $found.Source }

    if (-not $cli) {
        $memePath = "${env:ProgramFiles}\Memurai\redis-cli.exe"
        $memePathX86 = "${env:ProgramFiles(x86)}\Memurai\redis-cli.exe"
        if (Test-Path $memePath) { $cli = $memePath }
        elseif (Test-Path $memePathX86) { $cli = $memePathX86 }
    }
    if ($cli) {
        try {
            $result = & $cli ping 2>$null
            if ($result -eq "PONG") { return $true }
        } catch { }
        return $false
    }
    return ($svc.Status -eq 'Running')
}

function Start-MemuraiService {
    param([string]$ServiceName)

    if (-not $ServiceName) {
        Write-Log "Memurai/Redis service not found. Is Memurai installed?" "ERROR"
        return $false
    }

    Write-Log "Starting service: $ServiceName ..." "WARN"
    try {
        Start-Service -Name $ServiceName -ErrorAction Stop
        Start-Sleep -Seconds 3
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            Write-Log "Service $ServiceName started successfully" "INFO"
            return $true
        } else {
            $status = if ($svc) { $svc.Status } else { "UNKNOWN" }
            Write-Log "Service $ServiceName status abnormal: $status" "ERROR"
            return $false
        }
    } catch {
        Write-Log "Failed to start $ServiceName : $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# ====================== Backend Process Management ======================
$script:BackendProcess = $null
$script:LogFileForEvents = $LogFile

function Test-BackendRunning {
    param([int]$Port)
    try {
        $client = [Net.Sockets.TcpClient]::new("127.0.0.1", $Port)
        if ($client.Connected) {
            $client.Dispose()
            return $true
        }
        $client.Dispose()
    } catch { }
    return $false
}

function Start-BackendProcess {
    param([string]$WorkDir)

    if (-not (Test-Path $WorkDir)) {
        Write-Log "Backend directory not found: $WorkDir" "ERROR"
        return $false
    }

    # Kill old backend process
    if ($script:BackendProcess -and -not $script:BackendProcess.HasExited) {
        Write-Log "Killing old backend process (PID: $($script:BackendProcess.Id))..." "WARN"
        try {
            $script:BackendProcess.Kill()
            $script:BackendProcess.WaitForExit(5000)
            $script:BackendProcess = $null
        } catch { }
    }

    # Kill any node process occupying the backend port
    $pidsOnPort = Get-NetTCPConnection -LocalPort $BackendPort -ErrorAction SilentlyContinue `
        | Where-Object { $_.State -eq 'Listen' } `
        | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pidTarget in $pidsOnPort) {
        try {
            $proc = Get-Process -Id $pidTarget -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match 'node') {
                Write-Log "Killing stale node process on port $BackendPort (PID: $pidTarget)" "WARN"
                $proc.Kill()
            }
        } catch { }
    }

    Write-Log "Starting backend (node index.js)..." "WARN"
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "node"
        $psi.Arguments = "index.js"
        $psi.WorkingDirectory = $WorkDir
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $proc.EnableRaisingEvents = $true

        $logPath = $script:LogFileForEvents

        # Event handlers for stdout/stderr redirection
        $outEvent = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
            $line = $EventArgs.Data
            if ($line) {
                $msg = "[node-out] $line"
                Write-Host $msg
                try { Add-Content -Path $logPath -Value $msg -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
            }
        }

        $errEvent = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
            $line = $EventArgs.Data
            if ($line) {
                $msg = "[node-err] $line"
                Write-Host $msg -ForegroundColor Red
                try { Add-Content -Path $logPath -Value $msg -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
            }
        }

        $proc.Start() | Out-Null
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()

        $script:BackendProcess = $proc
        Write-Log "Backend process started (PID: $($proc.Id))" "INFO"
        return $true
    } catch {
        Write-Log "Failed to start backend: $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# ====================== NapCat (QQ Bot) ======================
$script:NapCatFailCount = 0
$script:NapCatLastStart = [datetime]::MinValue
$script:NapCatLastWarn = [datetime]::MinValue

function Test-SystemAccount {
    return [Security.Principal.WindowsIdentity]::GetCurrent().IsSystem
}

function Test-NapCatRunning {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-NapCat {
    $launcher = Join-Path $NapCatDir "NapCatWinBootMain.exe"
    if (-not (Test-Path $launcher)) {
        Write-Log "NapCat launcher not found: $launcher" "ERROR"
        return $false
    }
    # Only QQ processes started from the NapCat folder are stopped; a personal QQ installed elsewhere is never touched.
    $root = (Resolve-Path $NapCatDir).Path
    Get-Process -Name QQ -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object {
            Write-Log "Stopping stale NapCat QQ process (PID: $($_.Id))" "WARN"
            try { $_.Kill(); $_.WaitForExit(5000) | Out-Null } catch { }
        }
    $script:NapCatLastStart = Get-Date
    Write-Log "Starting NapCat (quick login: $NapCatAccount). If the saved login expired, scan the QR code in the NapCat window or WebUI." "WARN"
    try {
        if ($NapCatAccount) {
            Start-Process -FilePath $launcher -ArgumentList $NapCatAccount -WorkingDirectory $NapCatDir | Out-Null
        } else {
            Start-Process -FilePath $launcher -WorkingDirectory $NapCatDir | Out-Null
        }
        return $true
    } catch {
        Write-Log "Failed to start NapCat: $($_.Exception.Message)" "ERROR"
        return $false
    }
}

# The backend reconnects to NapCat by itself; this only brings the QQ client back.
function Invoke-NapCatCheck {
    if (-not $NapCatMonitored) { return }
    if (Test-NapCatRunning -Port $NapCatPort) {
        if ($script:NapCatFailCount -ge 3) { Write-Log "NapCat OneBot port $NapCatPort is listening again" "INFO" }
        $script:NapCatFailCount = 0
        return
    }
    $script:NapCatFailCount++
    if ($script:NapCatFailCount -lt 3) { return }
    if (Test-SystemAccount) {
        if (((Get-Date) - $script:NapCatLastWarn).TotalSeconds -ge $NapCatRestartCooldownSeconds) {
            $script:NapCatLastWarn = Get-Date
            Write-Log "NapCat OneBot port $NapCatPort is not listening. A SYSTEM watchdog cannot start the QQ client; the user-session task (install-watchdog-task.ps1 -WithNapCat) restarts it." "WARN"
        }
        return
    }
    # Leave time for login (and a possible QR scan) before trying again.
    if (((Get-Date) - $script:NapCatLastStart).TotalSeconds -lt $NapCatRestartCooldownSeconds) { return }
    Start-NapCat | Out-Null
}

function NapCat-Loop {
    if (-not $NapCatMonitored) {
        Write-Log "NapCat monitoring is off (QQ_BOT_ENABLED is not true or no NapCat directory configured)" "WARN"
        return
    }
    if (Test-NapCatRunning -Port $NapCatPort) {
        Write-Log "NapCat is running (OneBot port $NapCatPort)" "INFO"
    }
    while ($true) {
        Invoke-NapCatCheck
        Start-Sleep -Seconds $CheckIntervalSeconds
    }
}

# ====================== Main Loop ======================
function Main-Loop {
    $serviceName = Get-MemuraiServiceName
    if ($serviceName) {
        Write-Log "Detected Redis service: $serviceName" "INFO"
    } else {
        Write-Log "No Memurai/Redis service detected, will skip Redis monitoring" "WARN"
    }

    # Startup: ensure everything is ready
    if ($serviceName) {
        if (-not (Test-MemuraiRunning -ServiceName $serviceName)) {
            Write-Log "Memurai not running, starting..." "WARN"
            Start-MemuraiService -ServiceName $serviceName | Out-Null
        } else {
            Write-Log "Memurai is running" "INFO"
        }
    }

    if (-not (Test-BackendRunning -Port $BackendPort)) {
        Write-Log "Backend not running, starting..." "WARN"
        Start-BackendProcess -WorkDir $BackendDir | Out-Null
    } else {
        Write-Log "Backend is running (port $BackendPort)" "INFO"
    }

    $memuraiFailCount = 0
    $backendFailCount = 0

    while ($true) {
        Start-Sleep -Seconds $CheckIntervalSeconds

        # ---- Check Memurai ----
        if ($serviceName) {
            if (Test-MemuraiRunning -ServiceName $serviceName) {
                $memuraiFailCount = 0
            } else {
                $memuraiFailCount++
                Write-Log "Memurai unresponsive (consecutive: $memuraiFailCount)" "WARN"
                if ($memuraiFailCount -ge 2) {
                    Start-MemuraiService -ServiceName $serviceName | Out-Null
                    $memuraiFailCount = 0
                }
            }
        }

        # ---- Check Backend ----
        if (Test-BackendRunning -Port $BackendPort) {
            $backendFailCount = 0
        } else {
            $backendFailCount++
            if ($script:BackendProcess -and -not $script:BackendProcess.HasExited) {
                Write-Log "Backend process exists but port $BackendPort not responding (consecutive: $backendFailCount)" "WARN"
            } else {
                Write-Log "Backend process exited (consecutive: $backendFailCount)" "WARN"
            }

            if ($backendFailCount -ge 2) {
                Write-Log "Backend abnormal, attempting restart..." "ERROR"

                # If Memurai is also down, fix it first
                if ($serviceName -and -not (Test-MemuraiRunning -ServiceName $serviceName)) {
                    Write-Log "Memurai also down, restarting Memurai first..." "ERROR"
                    Start-MemuraiService -ServiceName $serviceName | Out-Null
                    Start-Sleep -Seconds 3
                }

                Start-BackendProcess -WorkDir $BackendDir | Out-Null
                $backendFailCount = 0

                # Wait a moment then verify
                Start-Sleep -Seconds 5
                if (Test-BackendRunning -Port $BackendPort) {
                    Write-Log "Backend recovered successfully" "INFO"
                } else {
                    Write-Log "Backend still not responding after restart, will retry next round" "ERROR"
                }
            }
        }

        # ---- Check NapCat (QQ Bot) ----
        Invoke-NapCatCheck
    }
}

# ====================== Entry Point ======================
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  yUYUko Food MAP - Watchdog Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Check Interval: ${CheckIntervalSeconds}s" -ForegroundColor Gray
Write-Host "  Backend Port  : $BackendPort" -ForegroundColor Gray
Write-Host "  Backend Dir   : $BackendDir" -ForegroundColor Gray
Write-Host "  NapCat        : $(if ($NapCatMonitored) { "$NapCatDir (port $NapCatPort)" } else { 'not monitored' })" -ForegroundColor Gray
Write-Host "  Log Dir       : $LogDir" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not $NapCatOnly -and -not (Test-Admin)) {
    Write-Log "WARNING: Not running as Administrator. Memurai service management may fail." "WARN"
    Write-Host ""
}

try {
    if ($NapCatOnly) { NapCat-Loop } else { Main-Loop }
} catch {
    Write-Log "Watchdog script crashed: $($_.Exception.Message)" "FATAL"
    Write-Log "Stack trace: $($_.ScriptStackTrace)" "FATAL"
    throw
} finally {
    Write-Log "Watchdog script stopped" "INFO"
}
