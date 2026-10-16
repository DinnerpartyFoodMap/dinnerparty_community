<#
.SYNOPSIS
    Install or remove the independent database backup Windows Scheduled Task.
.DESCRIPTION
    Run installation or removal from an elevated PowerShell session. The task
    runs Node as SYSTEM without an interactive desktop or a logged-in user.
    Its first backup is IntervalHours after installation, then every
    IntervalHours continuously, including across midnight. Reinstalling resets
    that schedule. Missed runs are started when Windows makes the task available.

    The CLI uses its default OSS upload mode. This installer does not read .env,
    execute the backup CLI, or start the task. SYSTEM must have access to Node,
    the backend directory, the database, the backup directory and the network.
    Use a machine-wide Node installation, not a user-session version manager.

    Omitting RepetitionDuration uses Task Scheduler's native indefinite
    repetition; no oversized TimeSpan is serialized into the task definition.
    See https://learn.microsoft.com/windows/win32/taskschd/repetitionpattern-duration
.EXAMPLE
    .\script\install-database-backup-task.ps1 -WhatIf
.EXAMPLE
    .\script\install-database-backup-task.ps1 -IntervalHours 6
.EXAMPLE
    .\script\install-database-backup-task.ps1 -NodePath 'C:\Program Files\nodejs\node.exe'
.EXAMPLE
    .\script\install-database-backup-task.ps1 -Uninstall
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateRange(1, 168)]
    [int]$IntervalHours = 6,

    [switch]$Uninstall,

    [ValidateNotNullOrEmpty()]
    [ValidatePattern('^[^\\/:*?"<>|\[\]]+$')]
    [ValidateScript({ -not [string]::IsNullOrWhiteSpace($_) })]
    [string]$TaskName = 'YuyukoFoodMapDatabaseBackup',

    [string]$NodePath,

    [string]$BackendDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskPath = '\'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $identity
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script as Administrator to install or remove the SYSTEM backup task. Use -WhatIf to preview without elevation.'
    }
}

# Removal deliberately precedes all Node/backend/CLI checks so stale tasks can
# still be removed after moving or deleting a deployment.
if ($Uninstall) {
    if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Remove database backup scheduled task')) {
        Assert-Administrator
        try {
            $existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
        } catch {
            if ($_.CategoryInfo.Category -eq 'ObjectNotFound') {
                $existing = $null
            } else {
                throw
            }
        }
        if ($null -ne $existing) {
            Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction Stop
            Write-Host "Removed database backup task: $TaskName"
        } else {
            Write-Host "Database backup task does not exist: $TaskName"
        }
    }
    return
}

# Windows PowerShell 5.1 initializes PSScriptRoot after -File parameter defaults
# are evaluated. Resolve the omitted default here, preserving explicit blanks.
if (-not $PSBoundParameters.ContainsKey('BackendDir')) {
    $BackendDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'backend'
}
if ([string]::IsNullOrWhiteSpace($BackendDir) -or -not (Test-Path -LiteralPath $BackendDir -PathType Container)) {
    throw "Backend directory not found: $BackendDir"
}
$ResolvedBackend = (Resolve-Path -LiteralPath $BackendDir).ProviderPath
$BackupScript = Join-Path $ResolvedBackend 'scripts\backups\backup_database.js'
if (-not (Test-Path -LiteralPath $BackupScript -PathType Leaf)) {
    throw "Backup CLI not found: $BackupScript"
}
$BackupScript = (Resolve-Path -LiteralPath $BackupScript).ProviderPath

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw 'Node.js was not found. Install Node.js 22 or newer, or provide -NodePath.'
    }
    $NodePath = $nodeCommand.Source
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or [IO.Path]::GetExtension($NodePath) -ne '.exe') {
    throw "Node executable not found: $NodePath"
}
$ResolvedNode = (Resolve-Path -LiteralPath $NodePath).ProviderPath
try {
    $nodeVersion = & $ResolvedNode --version 2>&1
    if ($LASTEXITCODE -ne 0 -or "$nodeVersion" -notmatch '^v(\d+)\.\d+\.\d+\s*$' -or [int]$Matches[1] -lt 22) {
        throw 'Node.js 22 or newer is required.'
    }
} catch {
    throw "Cannot run Node executable '$ResolvedNode': $($_.Exception.Message)"
}

if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", "Install SYSTEM database backup task every $IntervalHours hour(s)")) {
    Assert-Administrator

    # A direct Node action in the SYSTEM service session has no visible window.
    # Quote only the CLI argument; Execute and WorkingDirectory are separate
    # ScheduledTasks fields and must contain unquoted absolute paths.
    $Action = New-ScheduledTaskAction -Execute $ResolvedNode `
        -Argument ('"' + $BackupScript + '"') -WorkingDirectory $ResolvedBackend
    $FirstRun = (Get-Date).AddHours($IntervalHours)
    $Trigger = New-ScheduledTaskTrigger -Once -At $FirstRun `
        -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)
    $Settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 5) `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    $Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath `
        -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
        -Description "Yuyuko Food Map database backup with OSS upload; every $IntervalHours hour(s), independently of the web server and watchdog." `
        -Force -ErrorAction Stop | Out-Null

    Write-Host "Installed database backup task: $TaskName"
    Write-Host "First scheduled backup: $($FirstRun.ToString('yyyy-MM-dd HH:mm:ss'))"
    Write-Host "Continuous interval: $IntervalHours hour(s). The task was not started by this installer."
}
