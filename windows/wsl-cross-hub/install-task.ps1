[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PythonExe,
    [string]$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [string]$StateDir,
    [string]$InstallRoot,
    [switch]$Apply,
    [switch]$Replace
)

$ErrorActionPreference = "Stop"
$taskName = "Unique-WslCrossHub"
$explicitInstallRoot = [bool]$InstallRoot
if (!$InstallRoot) { $InstallRoot = $PSScriptRoot }
$python = (Get-Item -LiteralPath $PythonExe).FullName
$worker = Join-Path $InstallRoot "worker.py"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!$StateDir) {
    if ($UserId -ne $identity.Name) {
        throw "Pass -StateDir explicitly when registering for another account."
    }
    $StateDir = Join-Path $env:LOCALAPPDATA "WslCrossHub"
}
if ($StateDir -notmatch '^[a-zA-Z]:\\') {
    throw "The state directory must be an absolute local Windows path."
}
$StateDir = [IO.Path]::GetFullPath($StateDir).TrimEnd([char]"\")
if ($StateDir.Length -lt 3) {
    throw "Pass a state directory below the drive root."
}
if (($Apply -or !$explicitInstallRoot) -and
    !(Test-Path -LiteralPath $worker -PathType Leaf)) {
    throw "Missing worker at $worker."
}
if ([IO.Path]::GetExtension($python) -ne ".exe") {
    throw "Pass the absolute path to Windows python.exe."
}
if ($InstallRoot -notmatch '^[a-zA-Z]:\\[^"\r\n]+$' -or
    $python -notmatch '^[a-zA-Z]:\\[^"\r\n]+$' -or
    $StateDir -match '["\r\n]') {
    throw "The worker and Python must live on a local Windows drive."
}

$action = New-ScheduledTaskAction -Execute $python `
    -Argument ('-I -S "{0}" --state-dir "{1}" worker' -f $worker, $StateDir) `
    -WorkingDirectory $InstallRoot
$boot = New-ScheduledTaskTrigger -AtStartup
# A recurring trigger also recovers from a clean exit. IgnoreNew keeps
# it from starting another worker while the task is already running.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $UserId `
    -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$summary = [ordered]@{
    task = $taskName
    user = $UserId
    executable = $action.Execute
    arguments = $action.Arguments
    stateDir = $StateDir
    logon = $principal.LogonType.ToString()
    runLevel = $principal.RunLevel.ToString()
    trigger = "Startup and every minute"
    registered = $false
    startRequested = $false
}

if (!$Apply) {
    [pscustomobject]$summary | ConvertTo-Json
    exit 0
}

$administrator = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$administrator.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ("Open Windows PowerShell as Administrator to register the boot " +
        "trigger. The worker runs with Limited privileges.")
}

$existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' `
    -ErrorAction SilentlyContinue
$replaceExisting = $false
if ($existing) {
    if (!$Replace) {
        throw "Task $taskName already exists. Inspect or remove it before reinstalling."
    }
    $actions = @($existing.Actions)
    $previous = Join-Path $StateDir 'app\worker.py'
    $previousArguments = '-I -S "{0}" --state-dir "{1}" worker' -f $previous, $StateDir
    $existingUser = $existing.Principal.UserId
    if ($existingUser -notmatch '^S-1-') {
        $account = New-Object Security.Principal.NTAccount($existingUser)
        $existingUser = $account.Translate([Security.Principal.SecurityIdentifier]).Value
    }
    if ($UserId -ne $identity.Name -or $existingUser -ne $identity.User.Value -or
        $existing.Principal.RunLevel.ToString() -ne 'Limited' -or
        $existing.Principal.LogonType.ToString() -ne 'S4U' -or
        $existing.State.ToString() -eq 'Disabled' -or $actions.Count -ne 1 -or
        $actions[0].Execute -ine $action.Execute) {
        throw "Task $taskName does not match the supported Cross Hub boot worker."
    }
    if ($actions[0].Arguments -eq $action.Arguments) {
        $summary.registered = $true
        if ($existing.State.ToString() -ne 'Running') {
            Start-ScheduledTask -TaskName $taskName -TaskPath '\'
            $summary.startRequested = $true
        }
        [pscustomobject]$summary | ConvertTo-Json
        return
    }
    $versionedArguments = '^-I -S "{0}\\app-versions\\[0-9A-F]{{16}}(?:-[0-9A-F]{{16}}){{1,3}}\\worker\.py" --state-dir "{0}" worker$' -f
        [regex]::Escape($StateDir)
    if ($actions[0].Arguments -ne $previousArguments -and
        $actions[0].Arguments -notmatch $versionedArguments) {
        throw "The existing boot worker is outside the supported Cross Hub installation."
    }
    $replaceExisting = $true
}
# Register metadata only. The potentially user-writable Python and worker
# run under the Limited task principal, never under this admin token.
if ($replaceExisting) {
    Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
}
try {
    if ($replaceExisting) {
        Stop-ScheduledTask -TaskName $taskName -TaskPath '\'
    }
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action `
        -Trigger @($boot, $watchdog) -Principal $principal -Settings $settings `
        -Force:$replaceExisting `
        -Description "Run the unprivileged WSL Cross Hub worker before sign-in." |
        Out-Null
    $summary.registered = $true
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
} catch {
    if ($replaceExisting -and !$summary.registered) {
        Enable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
        Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    }
    [pscustomobject]$summary | ConvertTo-Json
    throw "Could not register or start task $taskName. $_"
}
$summary.startRequested = $true
[pscustomobject]$summary | ConvertTo-Json
