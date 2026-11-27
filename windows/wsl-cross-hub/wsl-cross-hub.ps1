[CmdletBinding()]
param(
    [string]$PythonExe,
    [string]$StateDir,
    [switch]$Setup,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
$taskName = "Unique-WslCrossHub"
$taskPath = "\"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run WSL Cross Hub from a regular Windows terminal."
}
if ($Apply -and !$Setup) {
    throw "Use -Setup -Apply to request boot task registration."
}

function Get-HubTask {
    try {
        $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath
    } catch {
        if ($_.CategoryInfo.Category -eq "ObjectNotFound") {
            return [ordered]@{ name = $taskName; status = "missing" }
        }
        return [ordered]@{
            name = $taskName
            status = "unavailable"
            error = $_.Exception.Message
        }
    }
    $result = [ordered]@{
        name = $taskName
        status = "registered"
        state = $task.State.ToString()
        user = $task.Principal.UserId
        runLevel = $task.Principal.RunLevel.ToString()
    }
    $actions = @($task.Actions)
    $pattern = '^-I -S "[^"]+" --state-dir "(?<state>[a-zA-Z]:\\[^"]+)" worker$'
    if ($actions.Count -eq 1 -and $actions[0].Arguments -match $pattern) {
        $result.python = $actions[0].Execute
        $result.stateDir = $Matches.state
    }
    try {
        $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath
        $result.lastTaskResult = $info.LastTaskResult
    } catch {
        $result.lastTaskResult = $null
    }
    return $result
}

function Get-HubUv {
    $bundled = Join-Path $PSScriptRoot "runtime\uv.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $command = Get-Command uv.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) { return $command.Source }
    $local = Join-Path $env:LOCALAPPDATA "WslCrossHub\runtime\uv.exe"
    if (Test-Path -LiteralPath $local -PathType Leaf) { return $local }
}

function Find-UvPython {
    if (!$uv) { return }
    try {
        $path = & $uv --no-config --no-python-downloads python find `
            --managed-python --no-project 3.13 2>$null
        if ($LASTEXITCODE -eq 0 -and $path -is [string]) { return $path }
    } catch {
        # A fresh uv installation has no interpreter to find yet.
    }
}

function Install-UvPython {
    # uv writes installation progress to stderr. Leave stdout for the JSON result.
    & $uv --no-config python install --managed-python --no-bin 3.13 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "uv could not install Windows Python 3.13 (exit $LASTEXITCODE)."
    }
}

function Get-HubRuntime {
    $probe = "import sys; assert sys.platform == 'win32' and sys.version_info[:2] == (3, 13); print(sys.version.split()[0])"
    if ($PythonExe) {
        $candidates = @($PythonExe)
    } elseif ($task.python) {
        $candidates = @($task.python)
    } else {
        $candidates = @(Find-UvPython)
    }
    foreach ($candidate in $candidates) {
        if ($candidate -notmatch '^[a-zA-Z]:\\' -or
            $candidate -match '\\Microsoft\\WindowsApps\\' -or
            [IO.Path]::GetFileName($candidate) -ine "python.exe" -or
            !(Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        try {
            $version = & $candidate -I -S -c $probe 2>$null
            if ($LASTEXITCODE -eq 0 -and $version -match '^3\.13\.\d+$') {
                return [ordered]@{
                    state = "ready"
                    path = (Get-Item -LiteralPath $candidate).FullName
                    version = $version
                }
            }
        } catch {
            continue
        }
    }
    if (!$PythonExe -and !$task.python -and $uv) {
        return [ordered]@{
            state = "provisionable"
            hint = "Setup can install native Windows Python 3.13 with uv."
        }
    }
    return [ordered]@{
        state = "missing"
        hint = "Install Windows uv or check the configured Python path."
    }
}

function Get-HubWorker {
    if ($runtime.state -ne "ready") {
        return [ordered]@{ state = "unavailable" }
    }
    try {
        $output = & $runtime.path -I -S "$PSScriptRoot\worker.py" `
            --state-dir $StateDir status 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "The worker status command failed with exit code $LASTEXITCODE."
        }
        return $output | ConvertFrom-Json
    } catch {
        return [ordered]@{ state = "unavailable"; error = $_.Exception.Message }
    }
}

function Publish-HubWorker([string]$InstallRoot) {
    $message = & $runtime.path -I -S "$PSScriptRoot\setup_core.py" `
        "$PSScriptRoot\worker.py" $InstallRoot
    if ($LASTEXITCODE -ne 0) {
        if ($message) { throw ($message -join " ") }
        throw "Worker publishing failed with exit code $LASTEXITCODE."
    }
}

function Invoke-HubSetup {
    param([hashtable]$Arguments, [byte[]]$InstallerSource)
    # The elevated host only registers a Limited task, without running Python.
    $source = [Convert]::ToBase64String($InstallerSource)
    $json = $Arguments | ConvertTo-Json -Compress
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $command = @'
        $ErrorActionPreference = 'Stop'
        $env:PSModulePath = "$PSHOME\Modules"
        try {
            Import-Module "$PSHOME\Modules\ScheduledTasks\ScheduledTasks.psd1"
            $utf8 = [Text.Encoding]::UTF8
            $params = $utf8.GetString([Convert]::FromBase64String('HUB_SETUP_ARGS')) |
                ConvertFrom-Json
            $adminUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            if ($adminUser -ne $params.UserId) { exit 5 }
            $options = @{}
            foreach ($property in $params.PSObject.Properties) {
                $options[$property.Name] = $property.Value
            }
            $setup = $utf8.GetString([Convert]::FromBase64String('HUB_SETUP_SOURCE'))
            & ([scriptblock]::Create($setup)) @options -Apply
            exit 0
        } catch {
            Write-Error $_ -ErrorAction Continue
            exit 1
        }
'@
    $command = $command.Replace("HUB_SETUP_ARGS", $payload).Replace("HUB_SETUP_SOURCE", $source)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $process = Start-Process -FilePath "$PSHOME\powershell.exe" -Verb RunAs `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-EncodedCommand", $encoded) `
        -PassThru -Wait
    return $process.ExitCode
}

$task = Get-HubTask
$installer = Join-Path $PSScriptRoot "install-task.ps1"
$installerSource = $null
if ($Apply -and $task.status -eq "missing") {
    # Capture the reviewed bytes before running any user-profile interpreter.
    $installerSource = [IO.File]::ReadAllBytes($installer)
}
if (!$StateDir) {
    $StateDir = $task.stateDir
    if (!$StateDir) {
        $StateDir = Join-Path $env:LOCALAPPDATA "WslCrossHub"
    }
}
if ($StateDir -notmatch '^[a-zA-Z]:\\') {
    throw "The state directory must be an absolute local Windows path."
}
$StateDir = [IO.Path]::GetFullPath($StateDir).TrimEnd([char]"\")
if ($StateDir.Length -lt 3) {
    throw "Pass a state directory below the drive root."
}

$uv = Get-HubUv
$runtime = Get-HubRuntime
$worker = Get-HubWorker
$outcome = 0
$setupResult = [ordered]@{ state = "available" }
if ($task.status -eq "missing" -and $runtime.state -eq "provisionable" -and $Apply) {
    try {
        Install-UvPython
        $runtime = Get-HubRuntime
        if ($runtime.state -ne "ready") {
            throw "uv did not provide a working native Windows Python 3.13."
        }
        $worker = Get-HubWorker
    } catch {
        $setupResult = [ordered]@{ state = "failed"; error = $_.Exception.Message }
        $outcome = 1
    }
}
if ($outcome -ne 0) {
    # Provisioning failed. The installer has not requested elevation.
} elseif ($task.status -eq "registered") {
    $setupResult.state = "already-registered"
} elseif ($task.status -eq "missing" -and $runtime.state -eq "provisionable") {
    if ($Setup) {
        $setupResult.state = "preview"
        $setupResult.provisionsPython = $true
    }
} elseif ($task.status -ne "missing" -or $runtime.state -ne "ready") {
    $setupResult.state = "blocked"
    if ($Setup) { $outcome = 1 }
} elseif ($Setup) {
    $options = @{
        PythonExe = $runtime.path
        StateDir = $StateDir
        UserId = $identity.Name
        InstallRoot = Join-Path $StateDir "app"
    }
    if ($Apply) {
        try {
            Publish-HubWorker -InstallRoot $options.InstallRoot
            $result = Invoke-HubSetup -Arguments $options `
                -InstallerSource $installerSource
            if ($result -eq 5) {
                throw "Approve UAC with your current Windows account, or use the manual installer."
            }
            if ($result -ne 0) {
                throw "The installer returned exit code $result."
            }
            $setupResult.state = "start-requested"
        } catch {
            $setupResult = [ordered]@{
                state = "failed"
                error = $_.Exception.Message
            }
            $outcome = 1
        }
        $task = Get-HubTask
        $worker = Get-HubWorker
    } else {
        $preview = & "$PSHOME\powershell.exe" -NoProfile -NonInteractive `
            -ExecutionPolicy Bypass -File $installer -PythonExe $runtime.path `
            -StateDir $StateDir -InstallRoot $options.InstallRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Task registration preview failed with exit code $LASTEXITCODE."
        }
        $setupResult.state = "preview"
        $setupResult.task = $preview | ConvertFrom-Json
    }
}

[ordered]@{
    product = "WSL Cross Hub"
    stateDir = $StateDir
    uv = $uv
    runtime = $runtime
    task = $task
    worker = $worker
    setup = $setupResult
} | ConvertTo-Json -Depth 5
exit $outcome
