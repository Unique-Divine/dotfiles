[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("probe", "status")]
    [string]$Operation,
    [Parameter(Mandatory = $true)]
    [string]$PythonExe,
    [string]$JobId,
    [string]$StateDir
)

$ErrorActionPreference = "Stop"

if ($JobId -and $Operation -ne "status") {
    throw "Only status accepts a job ID."
}

$python = (Get-Item -LiteralPath $PythonExe).FullName
$workerArgs = @("-I", "-S", (Join-Path $PSScriptRoot "worker.py"))
if ($StateDir) { $workerArgs += @("--state-dir", $StateDir) }
$workerArgs += $Operation.ToLowerInvariant()
if ($JobId) { $workerArgs += $JobId }
& $python @workerArgs
exit $LASTEXITCODE
