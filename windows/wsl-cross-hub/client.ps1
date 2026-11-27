[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("probe", "status", "compact", "logs", "acknowledge-hold", "doctor", "doctor-job", "doctor-agent-logs", "editor-launch", "editor-install")]
    [string]$Operation,
    [string]$PythonExe,
    [string]$JobId,
    [string]$StateDir,
    [ValidateSet("investigate", "cure", "auto")][string]$Mode,
    [ValidateSet("windows-ssh", "windows-herdr", "ubuntu-herdr", "windows-neovim", "ubuntu-neovim")][string]$CheckId,
    [ValidateSet("codex", "claude", "managed")][string]$Runner
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($JobId -and $Operation -notin @("status", "logs", "acknowledge-hold", "doctor-agent-logs")) {
    throw "This operation does not accept a job ID."
}
if ($Operation -in @("logs", "acknowledge-hold", "doctor-agent-logs") -and !$JobId) {
    throw "Pass a job ID to $Operation."
}
if ($JobId -and $JobId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw "Expected a lowercase UUIDv4 job ID."
}

if ($Operation -eq "doctor-job") {
    if (!$Mode -or !$CheckId -or !$Runner) { throw "Pass Mode, CheckId, and Runner to doctor-job." }
} elseif ($Mode -or $CheckId -or $Runner) {
    throw "Mode, CheckId, and Runner apply only to doctor-job."
}

$readingLogs = $Operation -in @("logs", "doctor-agent-logs")
$needRuntime = !$readingLogs -and !$PythonExe
$needLogPath = $readingLogs -and !$StateDir
if ($needRuntime -or $needLogPath) {
    $options = @{}
    if ($StateDir) { $options.StateDir = $StateDir }
    if ($Operation -in @("status", "logs", "doctor", "doctor-agent-logs", "editor-launch")) {
        $options.ReadOnly = $true
    }
    if ($options.ReadOnly -or $Operation -in @("doctor-job", "editor-install")) {
        $options.RuntimeOnly = $true
    }
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

if ($readingLogs) {
    $file = if ($Operation -eq "doctor-agent-logs") { "$JobId.agent.jsonl" } else { "$JobId.jsonl" }
    $journal = Join-Path $StateDir "maintenance\$file"
    if (!(Test-Path -LiteralPath $journal -PathType Leaf)) {
        throw "There is no maintenance journal for $JobId. Check the job status."
    }
    $stream = [IO.File]::Open($journal, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite)
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        try {
            $journal = $reader.ReadToEnd()
            if ($journal -and !$journal.EndsWith("`n")) {
                $lastBreak = $journal.LastIndexOf("`n") + 1
                try { $null = $journal.Substring($lastBreak) | ConvertFrom-Json }
                catch { $journal = $journal.Substring(0, $lastBreak) }
            }
            Write-Output $journal.TrimEnd("`r", "`n")
        }
        finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    exit 0
}

$python = (Get-Item -LiteralPath $PythonExe).FullName
# Keep sibling imports while ignoring Python environment variables and site hooks.
$workerArgs = @("-E", "-s", "-S", "-X", "utf8", (Join-Path $PSScriptRoot "worker.py"))
if ($StateDir) { $workerArgs += @("--state-dir", $StateDir) }
$workerArgs += switch ($Operation) {
    "compact" { "submit-compact" }
    "doctor" { "doctor-checks" }
    "doctor-job" { "submit-doctor"; $Mode.ToLowerInvariant(); $CheckId.ToLowerInvariant(); $Runner.ToLowerInvariant() }
    default { $Operation.ToLowerInvariant() }
}
if ($JobId) { $workerArgs += $JobId }
& $python @workerArgs
exit $LASTEXITCODE
