$ErrorActionPreference = 'Stop'
$sessionId = (Get-Process -Id $PID).SessionId
$processNames = @('Wispr Flow', 'Wispr Flow Helper')

function Get-WisprProcesses {
    Get-Process -Name $processNames -ErrorAction SilentlyContinue |
        Where-Object SessionId -eq $sessionId
}

function Open-Wispr {
    if ($appId) {
        Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$appId"
    } else {
        Start-Process -FilePath $launcher
    }
}

function Test-WisprWindow($appIds) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $scope = [System.Windows.Automation.TreeScope]::Children
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $windows = $root.FindAll($scope, $condition)
    return [bool]($windows | Where-Object {
        $appIds -contains $_.Current.ProcessId -and
            $_.Current.Name -eq 'Wispr Flow' -and !$_.Current.IsOffscreen
    } | Select-Object -First 1)
}

$mutex = [System.Threading.Mutex]::new($false, 'Local\ud-wispr-reset')
try {
    try {
        $locked = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $locked = $true
    }
    if (!$locked) {
        throw 'A Wispr Flow reset is already running.'
    }

    $appId = Get-StartApps | Where-Object Name -eq 'Wispr Flow' |
        Select-Object -First 1 -ExpandProperty AppID
    $launcher = Join-Path $env:LOCALAPPDATA 'WisprFlow\Wispr Flow.exe'
    if (!$appId -and !(Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw 'Wispr Flow launcher not found. Install Wispr Flow on Windows.'
    }
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

    $shutdown = [System.Diagnostics.Stopwatch]::StartNew()
    while ($remaining = @(Get-WisprProcesses)) {
        if ($shutdown.Elapsed.TotalSeconds -ge 5) {
            throw 'Wispr Flow did not stop within five seconds.'
        }
        foreach ($process in $remaining) {
            try {
                Stop-Process -InputObject $process -Force
            } catch {
                if (!$process.HasExited) { throw }
            }
        }
        Start-Sleep -Milliseconds 250
    }

    Open-Wispr
    $startup = [System.Diagnostics.Stopwatch]::StartNew()
    $nextOpen = 2
    while ($startup.Elapsed.TotalSeconds -lt 20) {
        $apps = @(Get-WisprProcesses | Where-Object ProcessName -eq 'Wispr Flow')
        if ($apps) {
            if (Test-WisprWindow $apps.Id) {
                Write-Output 'Wispr Flow is running and its window is open.'
                exit 0
            }
            # Wispr can start in the tray. Activate it again once it is running.
            if ($startup.Elapsed.TotalSeconds -ge $nextOpen) {
                Open-Wispr
                $nextOpen = $startup.Elapsed.TotalSeconds + 2
            }
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'Wispr Flow did not open its window within 20 seconds. Try its Start menu shortcut.'
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
