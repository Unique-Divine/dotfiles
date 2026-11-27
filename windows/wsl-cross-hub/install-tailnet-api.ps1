#Requires -Version 5.1
#Requires -PSEdition Desktop
[CmdletBinding(DefaultParameterSetName = 'Preview')]
param(
    [string]$StateDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WslCrossHub'),
    [ValidateRange(1024, 65535)]
    [int]$Port = 8765,
    [Parameter(Mandatory = $true, ParameterSetName = 'Prepare')]
    [switch]$Prepare,
    [Parameter(Mandatory = $true, ParameterSetName = 'Apply')]
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$taskName = 'Unique-WslCrossHub-Tailnet'
$bootTaskName = 'Unique-WslCrossHub'
$protocol = 1

function Get-SafeLocalPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\[^"\r\n:]+$') {
        throw "Expected an absolute local Windows path: $Path"
    }
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([char]'\')
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -lt 3 -or [IO.DriveInfo]::new($root).DriveFormat -ne 'NTFS') {
        throw "Expected a path below an NTFS drive root: $Path"
    }
    $item = $fullPath
    while ($item -and $item -ne $root) {
        if (Test-Path -LiteralPath $item) {
            if ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Cross Hub cannot use a reparse path: $item"
            }
        }
        $item = [IO.Path]::GetDirectoryName($item)
    }
    return $fullPath
}

function Get-TaskOwnerSid($Task) {
    if ($Task.Principal.UserId -match '^S-1-') { return $Task.Principal.UserId }
    $account = [Security.Principal.NTAccount]::new($Task.Principal.UserId)
    return $account.Translate([Security.Principal.SecurityIdentifier]).Value
}

function Assert-LimitedTask($Task, [string]$OwnerSid) {
    if (!$Task -or (Get-TaskOwnerSid $Task) -ne $OwnerSid -or
        $Task.Principal.RunLevel.ToString() -ne 'Limited' -or
        $Task.Principal.LogonType.ToString() -ne 'S4U' -or
        $Task.State.ToString() -eq 'Disabled' -or @($Task.Actions).Count -ne 1) {
        throw 'The scheduled task must be an enabled single-action Limited S4U task for the current user.'
    }
}

function Get-CompatibleWorkerRoot($Task, [string]$StateDir) {
    $shape = '^-I -S "({0}\\app-versions\\[0-9A-F]{{16}}(?:-[0-9A-F]{{16}}){{3}})\\worker\.py" --state-dir "{0}" worker$' -f
        [regex]::Escape($StateDir)
    if ($Task.Actions[0].Arguments -notmatch $shape) {
        throw 'The boot worker must point to a versioned Cross Hub installation for this state directory.'
    }
    $workerRoot = Get-SafeLocalPath $Matches[1]
    $workerPath = Join-Path $workerRoot 'worker.py'
    if ($Task.Actions[0].WorkingDirectory -ine $workerRoot) {
        throw 'The boot worker working directory does not match its installed source.'
    }
    $version = foreach ($name in @('worker.py', 'maintenance_runtime.py', 'cure_runtime.py', 'editor_runtime.py')) {
        $path = Get-SafeLocalPath (Join-Path $workerRoot $name)
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing boot worker source: $path" }
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.Substring(0, 16)
    }
    if ((Split-Path -Leaf $workerRoot) -cne ($version -join '-')) {
        throw 'The installed boot worker does not match its content version.'
    }
    if ([IO.File]::ReadAllText($workerPath) -cnotmatch "(?m)^RECOVERY_PROTOCOL[ \t]*=[ \t]*$protocol[ \t]*\r?$") {
        throw "Install the boot worker with recovery protocol $protocol before enabling the adapter."
    }
    return $workerRoot
}

function Assert-PrivateItem([string]$Path, [string]$OwnerSid, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -ne $Directory -or $item.LinkType -eq 'HardLink' -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected adapter storage item: $Path"
    }
    $security = Get-Acl -LiteralPath $Path
    if (!$security.AreAccessRulesProtected -or
        $security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $OwnerSid) {
        throw "The adapter storage must have a private DACL and be owned by the current user: $Path"
    }
    $flags = [Security.AccessControl.AceFlags]::None
    if ($Directory) {
        $flags = [Security.AccessControl.AceFlags]'ContainerInherit,ObjectInherit'
    }
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new(
        $security.GetSecurityDescriptorBinaryForm(), 0)
    $required = @($OwnerSid, 'S-1-5-18')
    $seen = @{}
    foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or
            $ace.AceType -ne 'AccessAllowed' -or $ace.AceFlags -ne $flags) {
            throw "The adapter storage has an unexpected access entry: $Path"
        }
        $sid = $ace.SecurityIdentifier.Value
        if ($sid -notin $required -or $seen.ContainsKey($sid) -or
            $ace.AccessMask -ne [int][Security.AccessControl.FileSystemRights]::FullControl) {
            throw "The adapter storage has unexpected permissions: $Path"
        }
        $seen[$sid] = $true
    }
    if ($seen.Count -ne $required.Count) {
        throw "The adapter storage must grant access to the current user and SYSTEM: $Path"
    }
}

function Initialize-PrivateRoot([string]$Path, [string]$OwnerSid) {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm("O:${OwnerSid}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${OwnerSid})")
    [IO.Directory]::CreateDirectory($Path, $security) | Out-Null
    Assert-PrivateItem $Path $OwnerSid $true
}

function Publish-PrivateFile([string]$Path, [byte[]]$Bytes, [string]$OwnerSid) {
    if (!(Test-Path -LiteralPath $Path)) {
        $temporary = Join-Path ([IO.Path]::GetDirectoryName($Path)) ([Guid]::NewGuid().ToString('N'))
        $security = [Security.AccessControl.FileSecurity]::new()
        $security.SetSecurityDescriptorSddlForm("O:${OwnerSid}D:P(A;;FA;;;SY)(A;;FA;;;${OwnerSid})")
        try {
            $stream = [IO.FileStream]::new($temporary, 'CreateNew',
                [Security.AccessControl.FileSystemRights]::Write, 'None', 4096, 'None', $security)
            try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
            finally { $stream.Dispose() }
            [IO.File]::Move($temporary, $Path)
        } finally {
            [IO.File]::Delete($temporary)
        }
    }
    Assert-PrivateItem $Path $OwnerSid $false
}

function Get-AdapterMac([string]$Token, [byte[]]$Message) {
    $encoding = [Text.Encoding]::UTF8
    $mac = [Security.Cryptography.HMACSHA256]::new($encoding.GetBytes($Token))
    try { return [BitConverter]::ToString($mac.ComputeHash($Message)).Replace('-', '').ToLowerInvariant() }
    finally { $mac.Dispose() }
}

function Read-AdapterStatus([int]$Port, [string]$Token) {
    $created = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $nonce = [Guid]::NewGuid().ToString('N')
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $payload = $encoding.GetBytes("Cross Hub request v1`n$created`n$nonce`nGET`n/v1/status`n")
    $signature = Get-AdapterMac $Token $payload
    $request = [Net.HttpWebRequest][Net.WebRequest]::Create("http://127.0.0.1:$Port/v1/status")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 1200
    $request.ReadWriteTimeout = 1200
    $request.Headers['Authorization'] = "CrossHub $created.$nonce.$signature"
    try {
        $response = $request.GetResponse()
        try {
            if ($response.StatusCode -ne [Net.HttpStatusCode]::OK -or
                $response.ContentLength -lt 1 -or $response.ContentLength -gt 8192) { return }
            $received = $response.Headers['X-Cross-Hub-Signature']
            if ($received -cnotmatch '^[0-9a-f]{64}$') { return }
            $body = [byte[]]::new([int]$response.ContentLength)
            $stream = $response.GetResponseStream()
            try {
                $clock = [Diagnostics.Stopwatch]::StartNew()
                $offset = 0
                while ($offset -lt $body.Length) {
                    $remaining = 1200 - [int]$clock.ElapsedMilliseconds
                    if ($remaining -le 0) { return }
                    $read = $stream.ReadAsync($body, $offset, $body.Length - $offset)
                    if (!$read.Wait($remaining) -or $read.Result -le 0) { return }
                    $offset += $read.Result
                }
            } finally { $stream.Dispose() }
            $prefix = $encoding.GetBytes("Cross Hub response v1`n$signature`n200`n")
            $expected = Get-AdapterMac $Token ($prefix + $body)
            if ($received -ceq $expected) { $encoding.GetString($body) | ConvertFrom-Json }
        } finally { $response.Dispose() }
    } catch [Net.WebException], [IO.IOException], [AggregateException] {
        return
    }
}

$StateDir = Get-SafeLocalPath $StateDir
$localAppData = Get-SafeLocalPath ([Environment]::GetFolderPath('LocalApplicationData'))
if (!$StateDir.StartsWith("$localAppData\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use a state directory below the current user LocalAppData directory.'
}
$serviceRoot = Join-Path $StateDir 'tailnet-api'
$tokenPath = Join-Path $serviceRoot 'token'
$summary = [ordered]@{
    task = $taskName
    stateDir = $StateDir
    tokenFile = $tokenPath
    listen = "127.0.0.1:$Port"
    logon = 'S4U'
    runLevel = 'Limited'
    recoveryProtocol = $protocol
    prepared = $false
    registered = $false
}
if (!$Prepare -and !$Apply) {
    [pscustomobject]$summary | ConvertTo-Json
    return
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$ownerSid = $identity.User.Value
if (!(Test-Path -LiteralPath $StateDir -PathType Container)) {
    throw 'Install and start the Cross Hub boot worker first.'
}
$adapterSource = Get-SafeLocalPath (Join-Path $PSScriptRoot 'tailnet_api.py')
$adapterBytes = [IO.File]::ReadAllBytes($adapterSource)
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $adapterHash = [BitConverter]::ToString($sha256.ComputeHash($adapterBytes)).Replace('-', '') }
finally { $sha256.Dispose() }
$adapter = Join-Path $serviceRoot "tailnet_api-$adapterHash.py"

if ($Prepare) {
    if ($elevated) { throw 'Run -Prepare from a standard PowerShell window as the Cross Hub owner.' }
    Initialize-PrivateRoot $serviceRoot $ownerSid
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $tokenBytes = [byte[]]::new(32)
        $random.GetBytes($tokenBytes)
    } finally {
        $random.Dispose()
    }
    $newToken = [BitConverter]::ToString($tokenBytes).Replace('-', '').ToLowerInvariant()
    Publish-PrivateFile $tokenPath ([Text.Encoding]::ASCII.GetBytes($newToken)) $ownerSid
    Publish-PrivateFile $adapter $adapterBytes $ownerSid
} else {
    if (!$elevated) {
        throw 'Open Windows PowerShell as Administrator to register the Limited adapter task.'
    }
    Assert-PrivateItem $serviceRoot $ownerSid $true
    Assert-PrivateItem $tokenPath $ownerSid $false
    Assert-PrivateItem $adapter $ownerSid $false
}
$token = [IO.File]::ReadAllText($tokenPath).Trim()
if ($token -cnotmatch '^[A-Za-z0-9._~+/-]{32,128}={0,2}$') {
    throw 'The adapter token does not have a supported bearer token format.'
}
if ((Get-FileHash -LiteralPath $adapter -Algorithm SHA256).Hash -cne $adapterHash) {
    throw 'The installed adapter source does not match the SHA-256 in its filename.'
}
$summary.prepared = $true
if ($Prepare) {
    [pscustomobject]$summary | ConvertTo-Json
    return
}

$bootTask = Get-ScheduledTask -TaskName $bootTaskName -TaskPath '\'
Assert-LimitedTask $bootTask $ownerSid
$workerRoot = Get-CompatibleWorkerRoot $bootTask $StateDir
$python = $bootTask.Actions[0].Execute
if ($python -notmatch '^[A-Za-z]:\\[^"\r\n:]+\\python\.exe$' -or
    !(Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'The boot worker does not specify an existing local Windows python.exe.'
}
$oldTask = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($oldTask) {
    Assert-LimitedTask $oldTask $ownerSid
    $oldArguments = '^-I -S "[A-Za-z]:\\[^"\r\n]+\\tailnet_api(?:-[0-9A-F]{{64}})?\.py" --worker-root "{0}\\app-versions\\[0-9A-F]{{16}}(?:-[0-9A-F]{{16}}){{1,3}}" --state-dir "{0}" --token-file "{1}" --port [0-9]{{4,5}}$' -f
        [regex]::Escape($StateDir), [regex]::Escape($tokenPath)
    if ($oldTask.Actions[0].Arguments -notmatch $oldArguments) {
        throw 'The existing adapter task does not match the supported Cross Hub installation.'
    }
    $oldXml = Export-ScheduledTask -TaskName $taskName -TaskPath '\'
    $wasRunning = $oldTask.State.ToString() -eq 'Running'
}

$arguments = '-I -S "{0}" --worker-root "{1}" --state-dir "{2}" --token-file "{3}" --port {4}' -f
    $adapter, $workerRoot, $StateDir, $tokenPath, $Port
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $workerRoot
$boot = New-ScheduledTaskTrigger -AtStartup
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

$registered = $false
try {
    if ($oldTask) {
        Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
        if ($wasRunning) { Stop-ScheduledTask -TaskName $taskName -TaskPath '\' }
    }
    $deadline = (Get-Date).AddSeconds(5)
    do {
        $listener = [Net.Sockets.TcpClient]::new()
        try {
            $listener.Connect('127.0.0.1', $Port)
            $portInUse = $true
        } catch [Net.Sockets.SocketException] {
            if ($_.Exception.SocketErrorCode -ne [Net.Sockets.SocketError]::ConnectionRefused) { throw }
            $portInUse = $false
        } finally {
            $listener.Dispose()
        }
        if ($portInUse) { Start-Sleep -Milliseconds 250 }
    } while ($portInUse -and (Get-Date) -lt $deadline)
    if ($portInUse) { throw 'The adapter loopback port is already in use.' }

    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action `
        -Trigger @($boot, $watchdog) -Principal $taskPrincipal -Settings $settings `
        -Description 'Run the limited Cross Hub loopback recovery adapter.' -Force:([bool]$oldTask) |
        Out-Null
    $registered = $true
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'

    $deadline = (Get-Date).AddSeconds(20)
    do {
        $status = Read-AdapterStatus $Port $token
        $ready = $status.worker_state -ceq 'ready' -and
            ($status.recovery_protocol -is [int] -or $status.recovery_protocol -is [long]) -and
            $status.recovery_protocol -eq $protocol
        if ($ready) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if (!$ready) { throw "The adapter did not report a ready worker with recovery protocol $protocol." }
    $summary.registered = $true
} catch {
    $failure = $_.Exception.Message
    try {
        if ($registered) {
            Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
            Stop-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
        }
        if ($oldTask) {
            Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $oldXml -Force | Out-Null
            if ($wasRunning) { Start-ScheduledTask -TaskName $taskName -TaskPath '\' }
        } elseif ($registered) {
            Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
        }
    } catch {
        throw "Could not enable the adapter. $failure Rollback failed. $_"
    }
    throw "Could not enable the adapter. $failure"
}
[pscustomobject]$summary | ConvertTo-Json
