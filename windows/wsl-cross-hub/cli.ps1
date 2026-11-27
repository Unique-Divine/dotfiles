# Launch the shared CLI using Windows Python. No WSL process is required.
$ErrorActionPreference = "Stop"
$hub = Join-Path $PSScriptRoot "wsl-cross-hub.ps1"
$report = & $hub -ReadOnly -RuntimeOnly | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($report.runtime.state -ne "ready") {
    $options = @($args | Where-Object { $_ -ne "--json" })
    if ($options[0] -ieq "setup" -and @($options | Select-Object -Skip 1 | Where-Object {
        $_ -ne "--apply"
    }).Count -eq 0) {
        & $hub -MaintenanceSetup -Apply:("--apply" -in $args)
        exit $LASTEXITCODE
    }
    throw "Native Windows Python is unavailable. Run wsl-cross-hub.cmd setup for setup options."
}
& $report.runtime.path -I -S -X utf8 (Join-Path $PSScriptRoot "hub_cli.py") @args
exit $LASTEXITCODE
