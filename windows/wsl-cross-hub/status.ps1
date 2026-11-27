[CmdletBinding()]
param(
    [ValidateSet("collect", "latest", "preview", "probe", "job", "rehearse", "maintenance", "compact", "doctor", "doctor-job", "doctor-logs", "diagnostic-logs", "editor-open", "approved-preview", "job-detail", "latest-doctor")]
    [string]$Operation = "latest",
    [string]$Distro,
    [string]$JobId,
    [string]$Scenario,
    [string]$StateDir,
    [ValidateSet("investigate", "cure", "auto")][string]$Mode,
    [ValidateSet("windows-ssh", "windows-herdr", "ubuntu-herdr", "windows-neovim", "ubuntu-neovim")][string]$CheckId,
    [ValidateSet("codex", "claude", "managed")][string]$Runner,
    [ValidateSet("doctor", "logs")][string]$View
)

$ErrorActionPreference = "Stop"
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if (($Operation -in @("preview", "rehearse", "compact")) -ne [bool]$Distro) {
    throw "Pass -Distro to preview, rehearse, or compact."
}
if (($Operation -in @("job", "doctor-logs", "job-detail")) -ne [bool]$JobId) {
    throw "Pass -JobId to job, job-detail, or doctor-logs."
}
if ($Scenario -and $Operation -ne "rehearse") {
    throw "Pass -Scenario only to the rehearse operation."
}

if ($Operation -eq "editor-open") {
    if (!$View) { throw "Pass -View to editor-open." }
    $client = Join-Path $PSScriptRoot "client.ps1"
    $editor = & $client -Operation editor-launch | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $ticket = [guid]::NewGuid().ToString("N")
    $ready = Join-Path ([IO.Path]::GetTempPath()) "cross-hub-nvim-$ticket"
    $label = if ($View -eq "doctor") { "Doctor" } else { "Logs" }
    $title = "WSL Cross Hub $label [$($ticket.Substring(0, 8))]"
    $env:WSL_CROSS_HUB_BOOTSTRAP = Join-Path $PSScriptRoot "nvim-cross-hub.lua"
    $env:WSL_CROSS_HUB_PACKAGEDIR = $PSScriptRoot
    $env:WSL_CROSS_HUB_VIEW = $View
    $env:WSL_CROSS_HUB_READY = $ready
    $env:WSL_CROSS_HUB_TITLE = $title
    # Use a dedicated visible console instead of letting the default terminal
    # attach Neovim to a window or tab that Cross Hub cannot activate.
    $console = Join-Path $env:SystemRoot "System32\conhost.exe"
    Start-Process -FilePath $console -WindowStyle Normal -WorkingDirectory $env:USERPROFILE `
        -ArgumentList @(('"{0}"' -f $editor.executable), "-i", "NONE", "-c", '"lua dofile(vim.env.WSL_CROSS_HUB_BOOTSTRAP)"')
    try {
        $until = [DateTime]::UtcNow.AddSeconds(20)
        $editorPid = 0
        while ([DateTime]::UtcNow -lt $until) {
            if ([IO.File]::Exists($ready) -and [int]::TryParse([IO.File]::ReadAllText($ready).Trim(), [ref]$editorPid) -and $editorPid -gt 0) {
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if ($editorPid -le 0) {
            throw "Neovim did not report that the Cross Hub buffer was ready. Check the terminal window for startup errors."
        }
        @{ pid = $editorPid; title = $title } | ConvertTo-Json
    } finally {
        [IO.File]::Delete($ready)
    }
    exit 0
}

if ($Operation -eq "diagnostic-logs") {
    $root = if ($StateDir) { $StateDir } else { Join-Path $env:LOCALAPPDATA "WslCrossHub" }
    $lines = @()
    foreach ($name in @("desktop", "worker")) {
        $lines += @("$name log", "")
        $path = Join-Path $root "logs\$name.log"
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            try { $lines += @(Get-Content -LiteralPath $path -Encoding UTF8 -Tail 200) }
            catch { $lines += "Log unavailable: $($_.Exception.Message)" }
        } else { $lines += "No log has been written yet." }
        $lines += ""
    }
    @{ lines = $lines } | ConvertTo-Json -Depth 4
    exit 0
}

if ($Operation -in @("doctor", "doctor-job", "doctor-logs")) {
    $client = Join-Path $PSScriptRoot "client.ps1"
    $options = @{}
    if ($StateDir) { $options.StateDir = $StateDir }
    if ($Operation -eq "doctor-logs") {
        $doctor = & "$PSScriptRoot\wsl-cross-hub.ps1" @options -ReadOnly -RuntimeOnly |
            ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $state = $doctor.stateDir
        $journal = & $client -StateDir $state -Operation logs -JobId $JobId
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $lines = @(($journal -join "`n") -split '\r?\n' | Where-Object { $_ })
        $agent = Join-Path $state "maintenance\$JobId.agent.jsonl"
        if (Test-Path -LiteralPath $agent -PathType Leaf) {
            $events = & $client -StateDir $state -Operation doctor-agent-logs -JobId $JobId
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            $lines += @('', 'Agent events')
            $lines += @(($events -join "`n") -split '\r?\n' | Where-Object { $_ })
        }
        @{ lines = $lines } | ConvertTo-Json -Depth 4
    } elseif ($Operation -eq "doctor-job") {
        & $client @options -Operation doctor-job -Mode $Mode -CheckId $CheckId -Runner $Runner
    } else {
        & $client @options -Operation doctor
    }
    exit $LASTEXITCODE
}

$options = @{}
if ($StateDir) { $options.StateDir = $StateDir }
if ($Operation -in @('maintenance', 'job-detail', 'latest-doctor')) {
    $options.RuntimeOnly = $true
    $options.ReadOnly = $true
}
$doctor = & "$PSScriptRoot\wsl-cross-hub.ps1" @options | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cross Hub doctor returned exit code $LASTEXITCODE." }

if ($Operation -eq "approved-preview") {
    $Distro = $doctor.compaction.distro
    if ($doctor.compaction.state -ne "ready" -or !$Distro) {
        @{
            distro = $Distro; decision = "blocked"; steps = @()
            blockers = @(@{ code = "permission"; message = ($doctor.compaction.hint, $doctor.compaction.message, "Compaction readiness unavailable." | Where-Object { $_ } | Select-Object -First 1) })
        } | ConvertTo-Json -Depth 5
        exit 0
    }
    $Operation = "preview"
}

if ($doctor.runtime.state -ne "ready") {
    if ($Operation -notin @("collect", "latest")) {
        throw "Native Windows Python 3.13 is unavailable. $($doctor.runtime.hint)"
    }

    $inventory = & "$PSScriptRoot\inventory.ps1" | ConvertFrom-Json
    [ordered]@{
        schemaVersion = 1
        observedAt = $inventory.observedAt
        inventory = $inventory
        inventoryStale = $false
        worker = $doctor.worker
        compaction = $doctor.compaction
        previousInventory = $null
        latestProbe = $null
        history = @()
        guestReports = @()
        errors = @(@{ source = "runtime"; message = $doctor.runtime.hint })
    } | ConvertTo-Json -Depth 10
    exit 0
}

# Keep sibling imports while ignoring Python environment variables and site hooks.
$python = $doctor.runtime.path
$pythonOptions = @("-E", "-s", "-S", "-X", "utf8")
if ($Operation -eq 'compact') {
    if ($doctor.compaction.state -ne 'ready' -or $doctor.compaction.distro -cne $Distro) {
        throw 'The approved compaction target or readiness changed. Refresh the preview.'
    }
    & "$PSScriptRoot\client.ps1" -Operation compact -PythonExe $python -StateDir $doctor.stateDir
    exit $LASTEXITCODE
}
$coreOperation = if ($Operation -eq "rehearse") { "preview" } else { $Operation }
$arguments = $pythonOptions + @("$PSScriptRoot\status_core.py", $coreOperation,
    "--state-dir", $doctor.stateDir)
if ($Distro) { $arguments += "--distro=$Distro" }
if ($JobId) { $arguments += "--job-id=$JobId" }
if ($Operation -eq "rehearse") {
    $plan = & $python @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $rehearsal = $pythonOptions + @("$PSScriptRoot\maintenance_rehearsal.py")
    if ($Scenario) { $rehearsal += "--scenario=$Scenario" }
    $plan | & $python @rehearsal
} elseif ($Operation -in @('maintenance', 'job-detail', 'latest-doctor')) {
    & $python @arguments
} elseif ($Operation -in @('collect', 'latest')) {
    $sample = $doctor.worker | ConvertTo-Json -Depth 5 -Compress | & $python @arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $snapshot = $sample | ConvertFrom-Json
    $snapshot | Add-Member -NotePropertyName compaction -NotePropertyValue $doctor.compaction
    $snapshot | ConvertTo-Json -Depth 18
} else {
    $doctor.worker | ConvertTo-Json -Depth 5 -Compress | & $python @arguments
}
exit $LASTEXITCODE
