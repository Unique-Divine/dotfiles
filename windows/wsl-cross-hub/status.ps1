[CmdletBinding()]
param(
    [ValidateSet("collect", "latest", "preview", "probe", "job", "rehearse", "maintenance", "compact")]
    [string]$Operation = "latest",
    [string]$Distro,
    [string]$JobId,
    [string]$Scenario,
    [string]$StateDir
)

$ErrorActionPreference = "Stop"
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if (($Operation -in @("preview", "rehearse", "compact")) -ne [bool]$Distro) {
    throw "Pass -Distro to preview, rehearse, or compact."
}
if (($Operation -eq "job") -ne [bool]$JobId) {
    throw "Pass -JobId only to the job operation."
}
if ($Scenario -and $Operation -ne "rehearse") {
    throw "Pass -Scenario only to the rehearse operation."
}

$options = @{}
if ($StateDir) { $options.StateDir = $StateDir }
if ($Operation -eq 'maintenance') { $options.RuntimeOnly = $true }
$doctor = & "$PSScriptRoot\wsl-cross-hub.ps1" @options | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Cross Hub doctor returned exit code $LASTEXITCODE." }

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
} elseif ($Operation -eq 'maintenance') {
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
