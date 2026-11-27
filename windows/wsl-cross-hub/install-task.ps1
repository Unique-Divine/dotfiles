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
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$taskName = "Unique-WslCrossHub"

function Resolve-HubPython([string]$Path) {
    if ($Path -notmatch '^[a-zA-Z]:\\[^"\r\n]+$') {
        throw 'Pass the absolute local path to Windows python.exe.'
    }
    $Path = [IO.Path]::GetFullPath($Path)
    if ([IO.Path]::GetFileName($Path) -ine 'python.exe') {
        throw 'Pass the absolute path to Windows python.exe.'
    }
    $parent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($Path)) -Force
    if ($parent.LinkType -eq 'Junction') {
        $targets = @($parent.Target)
        if ($targets.Count -ne 1 -or $targets[0] -notmatch '^[a-zA-Z]:\\[^"\r\n]+$' -or
            [IO.Path]::GetPathRoot($targets[0]) -ine [IO.Path]::GetPathRoot($Path)) {
            throw 'The Windows Python junction must have one local target on the same drive.'
        }
        $Path = Join-Path $targets[0] 'python.exe'
    }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) { throw 'The Windows Python executable is a directory.' }
    return $item.FullName
}

function Get-HubWorkerProcess([string]$Arguments) {
    # Task Scheduler may quote the executable. Compare the complete argument tail.
    $command = '^\s*(?:"[^"]+"|[^\s"]+)\s+' + [regex]::Escape($Arguments) + '$'
    Get-CimInstance -ClassName Win32_Process -Filter "Name = 'python.exe'" |
        Where-Object { $_.CommandLine -match $command }
}

function Stop-HubWorkerTask($TaskFolder, [string]$Arguments) {
    Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
    $task = $TaskFolder.GetTask($taskName)
    $sawInstance = $false
    $stopRequested = $false
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        # Disabled is a task state, not evidence that its last instance exited.
        if ($task.GetInstances(0).Count -gt 0) {
            if (!$stopRequested) {
                $null = $task.Stop(0)
                $stopRequested = $true
            }
            $sawInstance = $true
        } elseif (Get-HubWorkerProcess $Arguments) {
            $sawInstance = $true
        } else {
            return $sawInstance
        }
        Start-Sleep -Milliseconds 200
    } while ($elapsed.Elapsed.TotalSeconds -lt 15)
    throw "Timed out waiting for the previous $taskName process to exit."
}

function Test-HubWorkerTaskInstance($Task, $Process) {
    $instances = $Task.GetInstances(0)
    for ($index = 1; $index -le $instances.Count; $index++) {
        $enginePid = [uint32]$instances.Item($index).EnginePID
        if ($enginePid -eq 0) { continue }
        if ($enginePid -eq $Process.ProcessId) { return $true }
        if ($enginePid -ne $Process.ParentProcessId) { continue }

        # The scheduler may use a separate engine process to start the action.
        # Check its lifetime so a recycled parent PID cannot satisfy the check.
        $engine = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $enginePid"
        if ($engine.CreationDate -and $engine.CreationDate -le $Process.CreationDate) { return $true }
    }
    return $false
}

function Wait-HubWorkerHeartbeat($Task, $Action, [string]$StateDir, [DateTimeOffset]$StartedAt,
    [string]$OwnerSid) {
    $path = Join-Path $StateDir 'worker-heartbeat.json'
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        $heartbeat = $null
        try {
            $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
            if ($item -and !$item.PSIsContainer -and
                !($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.Length -le 4096) {
                # A shared read lets the worker atomically replace the heartbeat.
                $stream = [IO.File]::Open($path, 'Open', 'Read', 'Read,Delete')
                try {
                    if ($stream.Length -le 4096) {
                        $reader = [IO.StreamReader]::new($stream)
                        try { $heartbeat = $reader.ReadToEnd() | ConvertFrom-Json }
                        finally { $reader.Dispose() }
                    }
                } finally { $stream.Dispose() }
            }
        } catch [IO.IOException], [ArgumentException], [InvalidOperationException] {
            # The heartbeat may be absent during startup or replaced between reads.
        }
        $beatAt = [DateTimeOffset]::MinValue
        if ($heartbeat.platform -ceq 'win32' -and
            $heartbeat.pid -is [int] -and $heartbeat.pid -gt 0 -and
            [DateTimeOffset]::TryParse($heartbeat.heartbeat_at, [ref]$beatAt) -and
            $beatAt -ge $StartedAt -and
            $beatAt -le [DateTimeOffset]::UtcNow -and
            ([DateTimeOffset]::UtcNow - $beatAt).TotalSeconds -lt 15) {
            foreach ($process in (Get-HubWorkerProcess $Action.Arguments)) {
                if ($process.ProcessId -ne $heartbeat.pid -or
                    $process.ExecutablePath -ine $Action.Execute -or !$process.CreationDate -or
                    [DateTimeOffset]$process.CreationDate -lt $StartedAt -or
                    [DateTimeOffset]$process.CreationDate -gt $beatAt) { continue }
                $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
                if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $OwnerSid -and
                    (Test-HubWorkerTaskInstance $Task $process)) { return }
            }
        }
        Start-Sleep -Milliseconds 250
    } while ($elapsed.Elapsed.TotalSeconds -lt 30)
    throw "The replacement $taskName did not publish a fresh heartbeat from its running task instance."
}

$explicitInstallRoot = [bool]$InstallRoot
if (!$InstallRoot) { $InstallRoot = $PSScriptRoot }
$python = Resolve-HubPython $PythonExe
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
        (Resolve-HubPython $actions[0].Execute) -ine $action.Execute) {
        throw "Task $taskName does not match the supported WSL Cross Hub boot worker."
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
        throw "The existing boot worker is outside the supported WSL Cross Hub installation."
    }
    $replaceExisting = $true
}
# Register metadata only. The potentially user-writable Python and worker
# run under the Limited task principal, never under this admin token.
if ($replaceExisting) {
    $rollbackXml = Export-ScheduledTask -TaskName $taskName -TaskPath '\'
    $wasRunning = $existing.State.ToString() -eq 'Running'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $taskFolder = $scheduler.GetFolder('\')
}
try {
    if ($replaceExisting) {
        $stoppedInstance = Stop-HubWorkerTask $taskFolder $actions[0].Arguments
        $wasRunning = $wasRunning -or $stoppedInstance
    }
    $startedAt = [DateTimeOffset]::UtcNow
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action `
        -Trigger @($boot, $watchdog) -Principal $principal -Settings $settings `
        -Force:$replaceExisting `
        -Description "Run the unprivileged WSL Cross Hub worker before sign-in." |
        Out-Null
    $summary.registered = $true
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    if ($replaceExisting) {
        $candidateTask = $taskFolder.GetTask($taskName)
        Wait-HubWorkerHeartbeat $candidateTask $action $StateDir $startedAt $identity.User.Value
    }
} catch {
    $failure = $_.Exception.Message
    $rollbackFailures = [Collections.Generic.List[string]]::new()
    if ($replaceExisting -and $summary.registered) {
        try { $null = Stop-HubWorkerTask $taskFolder $action.Arguments }
        catch { $rollbackFailures.Add("Candidate cleanup failed. $($_.Exception.Message)") }
    }
    try {
        if ($replaceExisting) {
            Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $rollbackXml -Force |
                Out-Null
            # Restore the registration even if cleanup failed. Let its watchdog
            # restart the old worker if the candidate may still be exiting.
            if ($wasRunning -and $rollbackFailures.Count -eq 0) {
                Start-ScheduledTask -TaskName $taskName -TaskPath '\'
            }
        } elseif ($summary.registered) {
            Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
        }
    } catch {
        $rollbackFailures.Add("Task restoration failed. $($_.Exception.Message)")
    }
    if ($rollbackFailures.Count) {
        throw "Could not register or start task $taskName. $failure $($rollbackFailures -join ' ')"
    }
    $summary.registered = $false
    [pscustomobject]$summary | ConvertTo-Json
    throw "Could not register or start task $taskName. $failure"
}
$summary.startRequested = $true
[pscustomobject]$summary | ConvertTo-Json
