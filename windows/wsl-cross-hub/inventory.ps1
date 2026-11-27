# Read Windows and WSL state without starting a distribution.
# Target: Windows PowerShell 5.1.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

function Read-WslOutput {
    param([AllowEmptyCollection()][byte[]]$Bytes)

    if ($Bytes.Length -eq 0) { return "" }
    # WSL normally emits UTF-16LE without a BOM when redirected. A NUL
    # is common in that form and cannot occur in a distribution name.
    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xfe -and $Bytes[1] -eq 0xff) {
        $encoding = New-Object Text.UnicodeEncoding($true, $true, $true)
    } elseif ($Bytes -contains 0 -or
        ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xff -and $Bytes[1] -eq 0xfe)) {
        $encoding = New-Object Text.UnicodeEncoding($false, $true, $true)
    } else {
        $encoding = New-Object Text.UTF8Encoding($false, $true)
    }
    return $encoding.GetString($Bytes).TrimStart([char]0xfeff)
}

function Get-RunningDistributions {
    param([AllowEmptyCollection()][string[]]$RegisteredNames)

    $process = New-Object Diagnostics.Process
    $stdout = New-Object IO.MemoryStream
    $stderr = New-Object IO.MemoryStream
    try {
        $process.StartInfo.FileName = Join-Path $env:SystemRoot "System32\wsl.exe"
        $process.StartInfo.Arguments = "--list --running --quiet"
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        if (!$process.Start()) { throw "Could not start wsl.exe." }
        $outDrain = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errDrain = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (!$process.WaitForExit(5000)) {
            if (!$process.HasExited) { $process.Kill() }
            throw "Timed out after five seconds waiting for the WSL list command."
        }
        if (![Threading.Tasks.Task]::WaitAll(@($outDrain, $errDrain), 1000)) {
            throw "Timed out reading the WSL list output."
        }
        $output = Read-WslOutput -Bytes ($stdout.ToArray())
        $diagnostic = (Read-WslOutput -Bytes ($stderr.ToArray())).Trim()
        $noRunning = '^(Windows Subsystem for Linux has no running distributions|There are no running distributions)\.?$'
        if (($output.Trim() -match $noRunning -and !$diagnostic) -or
            ($diagnostic -match $noRunning -and !$output.Trim())) { return }
        if ($process.ExitCode -ne 0 -or $diagnostic) {
            throw "WSL list returned exit $($process.ExitCode). $diagnostic"
        }
        foreach ($line in ($output -split "\r?\n")) {
            $name = $line.Trim()
            if (!$name) { continue }
            if ($name -notin $RegisteredNames) {
                throw "WSL list returned an unregistered distribution or diagnostic: $name"
            }
            $name
        }
    } finally {
        $process.Dispose()
        $stdout.Dispose()
        $stderr.Dispose()
    }
}

function Get-RegisteredDistributions {
    $root = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss"
    if (!(Test-Path -LiteralPath $root)) { return }

    foreach ($key in Get-ChildItem -LiteralPath $root) {
        $registration = Get-ItemProperty -LiteralPath $key.PSPath
        if (!$registration.DistributionName) { continue }
        $version = $null
        $vhdPath = $null
        $vhdExists = $null
        $vhdLength = $null
        $vhdSparse = $null
        if ($null -ne $registration.Version) { $version = [int]$registration.Version }
        if ($version -eq 2 -and $registration.BasePath) {
            $base = $registration.BasePath -replace '^\\\\\?\\', ''
            $file = $registration.VhdFileName
            if (!$file) { $file = "ext4.vhdx" }
            $vhdPath = Join-Path $base $file
            try {
                $item = Get-Item -LiteralPath $vhdPath
                $vhdExists = !$item.PSIsContainer
                if ($vhdExists) {
                    $vhdLength = $item.Length
                    $vhdSparse = [bool]($item.Attributes -band [IO.FileAttributes]::SparseFile)
                }
            } catch [System.Management.Automation.ItemNotFoundException] {
                $vhdExists = $false
            } catch {
                $script:errors.Add(@{source = "vhd"; message = $_.Exception.Message})
            }
        }
        [ordered]@{
            name = [string]$registration.DistributionName
            version = $version
            vhdPath = $vhdPath
            vhdExists = $vhdExists
            vhdLengthBytes = $vhdLength
            vhdSparse = $vhdSparse
        }
    }
}

$errors = New-Object 'Collections.Generic.List[object]'
$registered = $null
$running = $null
$diskFree = $null
$dockerRunning = $null

try { $registered = @(Get-RegisteredDistributions) }
catch { $errors.Add(@{source = "registry"; message = $_.Exception.Message}) }

if ($null -ne $registered) {
    try {
        $names = @($registered | ForEach-Object { $_.name })
        $running = @(Get-RunningDistributions -RegisteredNames $names)
    } catch { $errors.Add(@{source = "wsl-running"; message = $_.Exception.Message}) }
}
try { $diskFree = (Get-PSDrive -Name C -PSProvider FileSystem).Free }
catch { $errors.Add(@{source = "host-free"; message = $_.Exception.Message}) }

try {
    $docker = Get-Process | Where-Object { $_.ProcessName -eq "Docker Desktop" }
    $dockerRunning = [bool]$docker
} catch { $errors.Add(@{source = "docker-desktop"; message = $_.Exception.Message}) }

[ordered]@{
    schemaVersion = 1
    observedAt = [DateTime]::UtcNow.ToString("o")
    cFreeBytes = $diskFree
    dockerDesktopRunning = $dockerRunning
    runningDistros = $running
    distributions = $registered
    errors = @($errors.ToArray())
} | ConvertTo-Json -Depth 5
