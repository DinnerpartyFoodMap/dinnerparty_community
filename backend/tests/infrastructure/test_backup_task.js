const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installer = path.resolve(__dirname, '../../../script/install-database-backup-task.ps1');
assert.ok(fs.existsSync(installer), 'The independent database backup task installer must exist');
assert.ok([...fs.readFileSync(installer)].every(byte => byte < 128), 'PowerShell installer must remain ASCII for Windows PowerShell 5.1');

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
// Match the documented installer invocation without changing machine/user policy.
const powershellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const probe = spawnSync(powershell, [...powershellArgs, '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
if (probe.error?.code === 'ENOENT') {
    console.log('SKIP backup task runtime checks: PowerShell is unavailable; installer presence and ASCII checks passed.');
} else {
    assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yuyuko-backup task-"));
    const backend = path.join(temp, 'backend with spaces');
    const cli = path.join(backend, 'scripts', 'backups', 'backup_database.js');
    const missing = path.join(temp, 'missing');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "throw new Error('Installer must never execute a backup');\n");
    fs.writeFileSync(path.join(backend, '.env'), 'INVALID_ENV_SENTINEL=installer-must-not-read-this\n');
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;

    // Only the operating-system task boundary and elevated identity are replaced.
    // The actual installer still parses, validates paths and constructs its task.
    const harness = `
$ErrorActionPreference = 'Stop'
$global:calls = @()
function New-Object {
    param([string]$TypeName, [object[]]$ArgumentList)
    if ($TypeName -ne 'Security.Principal.WindowsPrincipal') { throw "Unexpected New-Object: $TypeName" }
    $principal = [pscustomobject]@{}
    $principal | Add-Member ScriptMethod IsInRole { param($role) return $global:isAdministrator }
    return $principal
}
function Get-Date { return [datetime]'2026-10-15T08:00:00' }
function New-ScheduledTaskAction {
    param($Execute, $Argument, $WorkingDirectory)
    return [pscustomobject]@{ Execute = $Execute; Argument = $Argument; WorkingDirectory = $WorkingDirectory }
}
function New-ScheduledTaskTrigger {
    param([switch]$Once, $At, [timespan]$RepetitionInterval, [timespan]$RepetitionDuration = [timespan]::Zero)
    return [pscustomobject]@{
        Once = [bool]$Once; At = $At.ToString('s'); IntervalHours = $RepetitionInterval.TotalHours
        DurationSpecified = $PSBoundParameters.ContainsKey('RepetitionDuration')
        DurationHours = $RepetitionDuration.TotalHours
    }
}
function New-ScheduledTaskSettingsSet {
    param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries,
        [switch]$StartWhenAvailable, [int]$RestartCount, [timespan]$RestartInterval,
        $MultipleInstances, [timespan]$ExecutionTimeLimit)
    return [pscustomobject]@{
        StartWhenAvailable = [bool]$StartWhenAvailable; RestartCount = $RestartCount
        RestartMinutes = $RestartInterval.TotalMinutes; MultipleInstances = $MultipleInstances
        ExecutionMinutes = $ExecutionTimeLimit.TotalMinutes
        AllowStartIfOnBatteries = [bool]$AllowStartIfOnBatteries
        DontStopIfGoingOnBatteries = [bool]$DontStopIfGoingOnBatteries
    }
}
function New-ScheduledTaskPrincipal {
    param($UserId, $LogonType, $RunLevel)
    return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}
function Register-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess)]
    param($TaskName, $TaskPath, $Action, $Trigger, $Settings, $Principal, $Description, [switch]$Force)
    $global:calls += [pscustomobject]@{
        Operation = 'register'; TaskName = $TaskName; TaskPath = $TaskPath; Action = $Action
        Trigger = $Trigger; Settings = $Settings; Principal = $Principal; Description = $Description
        Force = [bool]$Force
    }
}
function Get-ScheduledTask {
    [CmdletBinding()]
    param($TaskName, $TaskPath)
    if ($global:taskExists) { return [pscustomobject]@{ TaskName = $TaskName; TaskPath = $TaskPath } }
}
function Unregister-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess)]
    param($TaskName, $TaskPath)
    $global:calls += [pscustomobject]@{ Operation = 'unregister'; TaskName = $TaskName; TaskPath = $TaskPath }
}
function Start-ScheduledTask { throw 'Installer must not start a task' }
function Start-Process { throw 'Installer must not start background processes' }
`;
    let scenarios = 0;
    function run(args, { administrator = true, taskExists = true } = {}) {
        const code = `${harness}
$global:isAdministrator = $${administrator}
$global:taskExists = $${taskExists}
$errorText = $null
try { & ${quote(installer)} ${args} } catch { $errorText = $_.Exception.Message }
[pscustomobject]@{ Error = $errorText; Calls = @($global:calls) } | ConvertTo-Json -Depth 12 -Compress | ForEach-Object { Write-Output ('RESULT:' + $_) }
`;
        const result = spawnSync(powershell, [...powershellArgs, '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
        const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('RESULT:'));
        assert.ok(line, result.stdout || result.stderr);
        scenarios++;
        return JSON.parse(line.slice(7));
    }
    const common = `-BackendDir ${quote(backend)} -NodePath ${quote(process.execPath)} -Confirm:$false`;

    try {
        const parseCode = `$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(installer)}, [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`;
        const parsed = spawnSync(powershell, [...powershellArgs, '-EncodedCommand', Buffer.from(parseCode, 'utf16le').toString('base64')], { encoding: 'utf8' });
        assert.equal(parsed.status, 0, parsed.stderr);

        // Exercise Windows PowerShell's real -File parameter binding. Calling
        // the script from an existing session misses default-value timing bugs.
        const filePreview = spawnSync(powershell, [...powershellArgs, '-File', installer, '-WhatIf'], {
            cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 15000,
        });
        assert.equal(filePreview.status, 0, filePreview.stderr || filePreview.error?.message || filePreview.stdout);
        assert.match(filePreview.stdout, /Install SYSTEM database backup task/);

        const installed = run(common);
        assert.equal(installed.Error, null);
        assert.equal(installed.Calls.length, 1, 'Install must register exactly one independent task without starting it');
        const task = installed.Calls[0];
        assert.equal(task.TaskName, 'YuyukoFoodMapDatabaseBackup');
        assert.equal(task.TaskPath, '\\');
        assert.equal(task.Operation, 'register');
        assert.equal(task.Force, true, 'Reinstallation should update the existing task directly');
        assert.equal(task.Action.Execute, process.execPath);
        assert.equal(task.Action.WorkingDirectory, backend);
        assert.equal(task.Action.Argument, `"${cli}"`, 'Quote the absolute CLI path and use its default OSS mode');
        assert.deepEqual(task.Principal, { UserId: 'SYSTEM', LogonType: 'ServiceAccount', RunLevel: 'Highest' });
        assert.equal(task.Trigger.Once, true);
        assert.equal(task.Trigger.At, '2026-10-15T14:00:00', 'First backup is one full interval after installation');
        assert.equal(task.Trigger.IntervalHours, 6);
        assert.equal(task.Trigger.DurationSpecified, false, 'Omit duration for native indefinite repetition, avoiding TimeSpan.MaxValue');
        assert.deepEqual(task.Settings, {
            StartWhenAvailable: true, RestartCount: 3, RestartMinutes: 5,
            MultipleInstances: 'IgnoreNew', ExecutionMinutes: 30,
            AllowStartIfOnBatteries: true, DontStopIfGoingOnBatteries: true,
        });

        for (const [hours, first] of [[1, '2026-10-15T09:00:00'], [5, '2026-10-15T13:00:00'], [7, '2026-10-15T15:00:00'], [168, '2026-10-22T08:00:00']]) {
            const changed = run(`${common} -IntervalHours ${hours} -TaskName 'Test Backup'`);
            assert.equal(changed.Error, null);
            assert.equal(changed.Calls[0].TaskName, 'Test Backup');
            assert.equal(changed.Calls[0].Trigger.IntervalHours, hours);
            assert.equal(changed.Calls[0].Trigger.At, first);
            assert.equal(changed.Calls[0].Trigger.Once, true, 'An interval must continue across midnight without a daily reset');
            assert.equal(changed.Calls[0].Trigger.DurationSpecified, false);
        }
        for (const hours of [0, 169]) {
            const invalid = run(`${common} -IntervalHours ${hours}`);
            assert.match(invalid.Error, /IntervalHours/i);
            assert.equal(invalid.Calls.length, 0);
        }
        for (const taskName of ["''", "'folder\\task'", "'   '"]) {
            const invalid = run(`${common} -TaskName ${taskName}`);
            assert.ok(invalid.Error, 'Invalid task names must fail before any changes');
            assert.equal(invalid.Calls.length, 0);
        }
        const missingNode = run(`-BackendDir ${quote(backend)} -NodePath ${quote(missing)} -Confirm:$false`);
        assert.match(missingNode.Error, /node/i);
        assert.equal(missingNode.Calls.length, 0);
        const missingBackend = run(`-BackendDir ${quote(missing)} -NodePath ${quote(process.execPath)} -Confirm:$false`);
        assert.match(missingBackend.Error, /backend/i);
        assert.equal(missingBackend.Calls.length, 0);
        for (const explicitBackend of ["''", "'   '"]) {
            const blankBackend = run(`-BackendDir ${explicitBackend} -NodePath ${quote(process.execPath)} -WhatIf`);
            assert.match(blankBackend.Error, /backend/i, 'Explicit blank paths must not fall back to the default backend');
            assert.equal(blankBackend.Calls.length, 0);
        }
        const emptyBackend = path.join(temp, 'empty backend');
        fs.mkdirSync(emptyBackend);
        const missingCli = run(`-BackendDir ${quote(emptyBackend)} -NodePath ${quote(process.execPath)} -Confirm:$false`);
        assert.match(missingCli.Error, /backup_database\.js/i);
        assert.equal(missingCli.Calls.length, 0);

        const denied = run(common, { administrator: false });
        assert.match(denied.Error, /administrator/i);
        assert.equal(denied.Calls.length, 0);
        const preview = run(`${common} -WhatIf`, { administrator: false });
        assert.equal(preview.Error, null, 'Preview is safe without elevation');
        assert.equal(preview.Calls.length, 0);

        const uninstall = `-Uninstall -NodePath ${quote(missing)} -BackendDir ${quote(missing)} -Confirm:$false`;
        const removed = run(`${uninstall} -TaskName 'Test Backup'`);
        assert.equal(removed.Error, null, 'Uninstall must work after Node or the backend directory is removed');
        assert.deepEqual(removed.Calls, [{ Operation: 'unregister', TaskName: 'Test Backup', TaskPath: '\\' }]);
        const absent = run(uninstall, { taskExists: false });
        assert.equal(absent.Error, null);
        assert.equal(absent.Calls.length, 0, 'Uninstall is idempotent');
        const removePreview = run(`${uninstall} -WhatIf`, { administrator: false });
        assert.equal(removePreview.Error, null);
        assert.equal(removePreview.Calls.length, 0);
        const removeDenied = run(uninstall, { administrator: false });
        assert.match(removeDenied.Error, /administrator/i);
        assert.equal(removeDenied.Calls.length, 0);
        assert.equal(fs.readFileSync(path.join(backend, '.env'), 'utf8'), 'INVALID_ENV_SENTINEL=installer-must-not-read-this\n');
        console.log(`Database backup task passed: PowerShell parser, ASCII, real -File -WhatIf launch, ${scenarios} isolated task-boundary scenarios; no task registered or backup executed.`);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
