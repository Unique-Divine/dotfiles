[CmdletBinding()]
param(
    [ValidateRange(1, 30)]
    [int]$Samples = 8
)

$ErrorActionPreference = "Stop"

function Start-BenchmarkPowerShell([string]$Command) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $PSHOME "powershell.exe"
    $start.Arguments = "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardInput = $true
    return [Diagnostics.Process]::Start($start)
}

function Receive-Line([Diagnostics.Process]$Process, [string]$Expected) {
    $read = $Process.StandardOutput.ReadLineAsync()
    if (!$read.Wait(5000) -or $read.Result -ne $Expected) {
        throw "PowerShell did not return $Expected."
    }
}

function Close-BenchmarkPowerShell([Diagnostics.Process]$Process) {
    if (!$Process.HasExited) { $Process.Kill() }
    $Process.Dispose()
}

function Get-Median([double[]]$Values) {
    $sorted = @($Values | Sort-Object)
    $midpoint = [int][Math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2 -eq 1) { return $sorted[$midpoint] }
    return ($sorted[$midpoint - 1] + $sorted[$midpoint]) / 2
}

$coldTimes = foreach ($sample in 1..$Samples) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $cold = Start-BenchmarkPowerShell '[Console]::WriteLine("PONG")'
    try {
        Receive-Line $cold "PONG"
        if (!$cold.WaitForExit(5000) -or $cold.ExitCode -ne 0) {
            throw "Cold PowerShell did not exit successfully."
        }
        $timer.Elapsed.TotalMilliseconds
    } finally {
        Close-BenchmarkPowerShell $cold
    }
}

$warmCommand = @'
[Console]::WriteLine("READY")
while ([Console]::ReadLine() -eq "PING") {
    [Console]::WriteLine("PONG")
}
'@
$timer = [Diagnostics.Stopwatch]::StartNew()
$warm = Start-BenchmarkPowerShell $warmCommand
try {
    Receive-Line $warm "READY"
    $warmStartupMs = $timer.Elapsed.TotalMilliseconds
    $warm.StandardInput.WriteLine("PING")
    Receive-Line $warm "PONG"
    $warmTimes = foreach ($sample in 1..$Samples) {
        $timer.Restart()
        $warm.StandardInput.WriteLine("PING")
        Receive-Line $warm "PONG"
        $timer.Elapsed.TotalMilliseconds
    }
} finally {
    Close-BenchmarkPowerShell $warm
}

[pscustomobject]@{
    samples = $Samples
    coldMedianMs = [Math]::Round((Get-Median @($coldTimes)), 3)
    warmStartupMs = [Math]::Round($warmStartupMs, 3)
    warmMedianMs = [Math]::Round((Get-Median @($warmTimes)), 3)
} | ConvertTo-Json
