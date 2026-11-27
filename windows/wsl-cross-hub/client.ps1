[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("probe", "status", "compact", "logs", "acknowledge-hold")]
    [string]$Operation,
    [string]$PythonExe,
    [string]$JobId,
    [string]$StateDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($JobId -and $Operation -notin @("status", "logs", "acknowledge-hold")) {
    throw "Only status, logs, and acknowledge-hold accept a job ID."
}
if ($Operation -in @("logs", "acknowledge-hold") -and !$JobId) {
    throw "Pass a job ID to $Operation."
}
if ($JobId -and $JobId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw "Expected a lowercase UUIDv4 job ID."
}

$needRuntime = $Operation -ne "logs" -and !$PythonExe
$needLogPath = $Operation -eq "logs" -and !$StateDir
if ($needRuntime -or $needLogPath) {
    $options = @{}
    if ($StateDir) { $options.StateDir = $StateDir }
    if ($Operation -in @("status", "logs")) { $options.ReadOnly = $true; $options.RuntimeOnly = $true }
    $doctor = & "$PSScriptRoot\wsl-cross-hub.ps1" @options | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Cross Hub doctor returned exit code $LASTEXITCODE." }
    $StateDir = $doctor.stateDir
    if ($needRuntime) {
        if ($doctor.runtime.state -ne "ready") {
            throw "Windows Python is unavailable. $($doctor.runtime.hint)"
        }
        $PythonExe = $doctor.runtime.path
    }
}

if ($Operation -eq "logs") {
    $journal = Join-Path $StateDir "maintenance\$JobId.jsonl"
    if (!(Test-Path -LiteralPath $journal -PathType Leaf)) {
        throw "There is no maintenance journal for $JobId. Check the job status."
    }
    $stream = [IO.File]::Open($journal, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite)
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        try { [Console]::Write($reader.ReadToEnd()) }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    exit 0
}

$python = (Get-Item -LiteralPath $PythonExe).FullName
# Keep sibling imports while ignoring Python environment variables and site hooks.
$workerArgs = @("-E", "-s", "-S", "-X", "utf8", (Join-Path $PSScriptRoot "worker.py"))
if ($StateDir) { $workerArgs += @("--state-dir", $StateDir) }
$workerArgs += if ($Operation -eq "compact") { "submit-compact" } else { $Operation.ToLowerInvariant() }
if ($JobId) { $workerArgs += $JobId }
& $python @workerArgs
exit $LASTEXITCODE
