[CmdletBinding()]
param(
    [switch]$Preview,
    [string]$Distro = 'Ubuntu-24.04',
    [string]$BootPythonExe,
    [string]$BootStateDir,
    [string]$BootInstallRoot
)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'

function Get-SetupHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [Convert]::ToBase64String($sha.ComputeHash($Bytes)) }
    finally { $sha.Dispose() }
}

function Read-SetupSource([string]$Path, [string]$Hash) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ((Get-SetupHash $bytes) -cne $Hash) {
        throw "Setup source changed after the approval request: $Path"
    }
    return ,$bytes
}

function Get-CompactionTaskAction([string]$Root, [string]$Script) {
    @{
        executable = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
        arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f
            (Join-Path $Root $Script)
    }
}

function Assert-ProtectedCompactionItem([string]$Path, [string]$OwnerSid) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "The protected maintenance path is a reparse point: $Path"
    }
    $acl = Get-Acl -LiteralPath $Path
    $admins = 'S-1-5-32-544'
    $system = 'S-1-5-18'
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($admins, $system)) {
        throw "Windows administrators must own $Path."
    }

    $full = [Security.AccessControl.FileSystemRights]::FullControl
    $read = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
        [Security.AccessControl.FileSystemRights]::Synchronize
    $allowed = @{
        $admins = $full
        $system = $full
        $OwnerSid = $read
    }
    $seen = @{}
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if (!$allowed.ContainsKey($sid) -or
            $rule.AccessControlType -ne 'Allow' -or
            ($rule.FileSystemRights -band (-bnot [int]$allowed[$sid])) -ne 0) {
            throw "The maintenance path has unexpected permissions: $Path"
        }
        if (!$seen.ContainsKey($sid)) { $seen[$sid] = 0 }
        $seen[$sid] = $seen[$sid] -bor [int]$rule.FileSystemRights
    }
    foreach ($sid in $allowed.Keys) {
        if (($seen[$sid] -band [int]$allowed[$sid]) -ne [int]$allowed[$sid]) {
            throw "The maintenance path is missing required permissions: $Path"
        }
    }
}

function Initialize-CompactionRoot([string]$Root, [string]$OwnerSid) {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    # File generic read and execute include Synchronize. Explicit protected DACL
    # avoids a writable interval or depending on the machine's inherited ACL.
    $security.SetSecurityDescriptorSddlForm(
        "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;${OwnerSid})")
    [IO.Directory]::CreateDirectory($Root, $security) | Out-Null
    Assert-ProtectedCompactionItem $Root $OwnerSid
}

function Initialize-CompactionFile([string]$Path, [byte[]]$Bytes, [string]$OwnerSid) {
    if ([IO.File]::Exists($Path)) { return }
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetSecurityDescriptorSddlForm(
        "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;${OwnerSid})")
    $handle = [IO.FileStream]::new($Path, 'CreateNew',
        [Security.AccessControl.FileSystemRights]::Write, 'None', 4096, 'None', $security)
    try { $handle.Write($Bytes, 0, $Bytes.Length) }
    finally { $handle.Dispose() }
}

function Publish-CompactionFile([string]$Path, [byte[]]$Bytes, [string]$OwnerSid) {
    Initialize-CompactionFile $Path $Bytes $OwnerSid
    Assert-ProtectedCompactionItem $Path $OwnerSid
    if ((Get-SetupHash ([IO.File]::ReadAllBytes($Path))) -cne (Get-SetupHash $Bytes)) {
        throw "A different file is already installed at $Path. An administrator must inspect it."
    }
}

function Register-MaintenanceTask([object]$Approved, [string]$Root,
    [string]$Name, [string]$Script, [string]$Description) {
    $account = $Approved.owner_sid
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $taskAction = Get-CompactionTaskAction $Root $Script

    $definition = $scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = $Description
    $definition.Principal.UserId = $account
    $definition.Principal.LogonType = 2  # TASK_LOGON_S4U
    $definition.Principal.RunLevel = 1   # TASK_RUNLEVEL_HIGHEST
    $definition.Settings.Enabled = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.MultipleInstances = 2  # TASK_INSTANCES_IGNORE_NEW
    $action = $definition.Actions.Create(0)  # TASK_ACTION_EXEC
    $action.Path = $taskAction.executable
    $action.Arguments = $taskAction.arguments
    $action.WorkingDirectory = $Root

    # Register with the security descriptor in one operation. The user's
    # filtered token can query and run this task. Only administrators can edit it.
    $sddl = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;${account})"
    $existing = @($folder.GetTasks(1) | Where-Object { $_.Name -eq $name })
    if ($existing.Count) {
        $current = $existing[0]
        $currentOwner = $current.Definition.Principal.UserId
        if ($currentOwner -notmatch '^S-1-') {
            $identity = [Security.Principal.NTAccount]::new($currentOwner)
            $currentOwner = $identity.Translate([Security.Principal.SecurityIdentifier]).Value
        }
        if ($current.State -ne 3 -or $current.Definition.Actions.Count -ne 1 -or
            $current.Definition.Actions.Item(1).Path -ine $taskAction.executable -or
            $current.Definition.Actions.Item(1).Arguments -cne $taskAction.arguments -or
            $currentOwner -ine $account -or
            $current.Definition.Principal.RunLevel -ne 1 -or
            $current.Definition.Principal.LogonType -ne 2 -or
            $current.Definition.Triggers.Count -ne 0) {
            throw "Task $name already exists with different settings or is active."
        }
        $mode = 4  # TASK_UPDATE
    } else {
        $mode = 2  # TASK_CREATE
    }
    $null = $folder.RegisterTaskDefinition($name, $definition, ($mode -bor 16),
        $account, $null, 2, $sddl)  # TASK_DONT_ADD_PRINCIPAL_ACE
}

function Invoke-ApprovedCompactionInstall([object]$Options) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
        $identity.User.Value -cne $Options.owner_sid) {
        throw 'Approve setup as the Windows administrator who owns the WSL distro.'
    }

    $helper = Read-SetupSource $Options.helper_path $Options.helper_hash
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $helperBlock = [scriptblock]::Create($utf8.GetString($helper))
    . $helperBlock -DefineOnly
    $registration = Get-CompactionRegistration $Options.distro
    if ($registration.registration -cne $Options.registration -or
        $registration.vhdx -ine $Options.vhdx) {
        throw 'The WSL registration changed after the approval request.'
    }

    $bootBlock = $null
    if ($Options.boot) {
        $bootSource = Read-SetupSource $Options.boot_path $Options.boot_hash
        $bootBlock = [scriptblock]::Create($utf8.GetString($bootSource))
    }

    $root = Get-CompactionRoot
    Initialize-CompactionRoot $root $Options.owner_sid
    Initialize-CompactionFileApi $root
    $pins = [WslCrossHub.FilePins]::new($registration.vhdx)
    try {
        if ($pins.Links -ne 1 -or $pins.VolumeSerial -cne $Options.volume_serial -or
            $pins.FileId -cne $Options.file_id) {
            throw 'The VHDX identity or hard link count changed after the approval request.'
        }
        $approved = [ordered]@{
            owner_sid = $Options.owner_sid
            distro = $registration.distro
            registration = $registration.registration
            vhdx = $registration.vhdx
            volume_serial = $pins.VolumeSerial
            file_id = $pins.FileId
        }
        Publish-CompactionFile (Join-Path $root 'compact-vhdx.ps1') $helper $Options.owner_sid
        $bytes = $utf8.GetBytes(($approved | ConvertTo-Json -Compress))
        Publish-CompactionFile (Join-Path $root 'target.json') $bytes $Options.owner_sid
    } finally {
        $pins.Dispose()
    }

    $journal = Join-Path $root 'diskpart.jsonl'
    Initialize-CompactionFile $journal ([byte[]]::new(0)) $Options.owner_sid
    Assert-ProtectedCompactionItem $journal $Options.owner_sid

    Register-MaintenanceTask $Options $root 'Unique-WslCrossHub-Compact' `
        'compact-vhdx.ps1' 'Compact the approved WSL VHDX on demand.'
    $recovery = @'
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
# Windows SSH is the recovery route. Tailscale is optional.
try {
    $tailscale = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
    if ($tailscale -and $tailscale.Status -ne 'Running') {
        Start-Service -Name Tailscale
    }
} catch {
    Write-Warning $_.Exception.Message
}
$deadline = (Get-Date).AddSeconds(20)
do {
    if ((Get-Service -Name sshd).Status -eq 'Running') { return }
    try { Start-Service -Name sshd; return }
    catch {
        if ((Get-Date) -ge $deadline) { throw }
        Start-Sleep -Seconds 1
    }
} while ($true)
'@
    Publish-CompactionFile (Join-Path $root 'recover-access.ps1') `
        $utf8.GetBytes($recovery) $Options.owner_sid
    Register-MaintenanceTask $Options $root 'Unique-WslCrossHub-Recovery' `
        'recover-access.ps1' 'Start the existing Windows SSH and Tailscale services.'
    if ($bootBlock) {
        $bootOptions = @{
            PythonExe = $Options.boot.python
            StateDir = $Options.boot.state
            InstallRoot = $Options.boot.root
            UserId = $identity.Name
        }
        $null = & $bootBlock @bootOptions -Apply -Replace
    }
}

# The encoded elevated launcher sets this private script variable and calls
# these functions with the hashes and target from the pre-approval preview.
if ($null -ne $script:CrossHubApprovedOptions) {
    Invoke-ApprovedCompactionInstall $script:CrossHubApprovedOptions
    return
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$helperPath = Join-Path $PSScriptRoot 'compact-vhdx.ps1'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$helper = [IO.File]::ReadAllBytes($helperPath)
. ([scriptblock]::Create($utf8.GetString($helper))) -DefineOnly
$registration = Get-CompactionRegistration $Distro
$root = Get-CompactionRoot
$installDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
if ($installDrive.DriveFormat -ne 'NTFS' -or
    $installDrive.RootDirectory.FullName -ine [IO.Path]::GetPathRoot($registration.vhdx)) {
    throw 'The WSL disk and Cross Hub maintenance install must be on the same NTFS drive.'
}
Initialize-CompactionFileApi ([IO.Path]::GetTempPath())
$pins = [WslCrossHub.FilePins]::new($registration.vhdx)
try {
    if ($pins.Links -ne 1) { throw 'The approved disk has an unexpected hard link.' }
    $volumeSerial = $pins.VolumeSerial
    $fileId = $pins.FileId
} finally {
    $pins.Dispose()
}

$requestedBoot = $BootPythonExe -or $BootStateDir -or $BootInstallRoot
$options = [ordered]@{
    owner_sid = $identity.User.Value
    distro = $registration.distro
    registration = $registration.registration
    vhdx = $registration.vhdx
    volume_serial = $volumeSerial
    file_id = $fileId
    helper_path = $helperPath
    helper_hash = Get-SetupHash $helper
    boot = $null
}
if ($requestedBoot) {
    foreach ($path in @($BootPythonExe, $BootStateDir, $BootInstallRoot)) {
        if ($path -notmatch '^[a-zA-Z]:\\[^"]+$') {
            throw 'Provide all three boot options as absolute local Windows paths.'
        }
    }
    $options.boot = @{ python = $BootPythonExe; state = $BootStateDir; root = $BootInstallRoot }
    $options.boot_path = Join-Path $PSScriptRoot 'install-task.ps1'
    $options.boot_hash = Get-SetupHash ([IO.File]::ReadAllBytes($options.boot_path))
}

$previewData = [ordered]@{
    task = 'Unique-WslCrossHub-Compact'
    recovery_task = 'Unique-WslCrossHub-Recovery'
    owner_sid = $options.owner_sid
    distro = $options.distro
    registration = $options.registration
    vhdx = $options.vhdx
    install_root = $root
    volume_serial = $options.volume_serial
    file_id = $options.file_id
    setup = if ($requestedBoot) { 'Register compaction and refresh the boot worker' }
        else { 'Register compaction only' }
    trigger = 'On demand'
    logon = 'S4U'
    privileges = 'Highest'
    registered = $false
    startRequested = $false
    workerUpdated = $false
}
if ($Preview) {
    $previewData | ConvertTo-Json
    return
}

# Only a small bootstrap crosses the command line. Files read from the
# sync directory after UAC must match their pre-approval hashes byte-for-byte.
$options.setup_attempt = [Guid]::NewGuid().ToString()
$options.setup_path = $PSCommandPath
$options.setup_hash = Get-SetupHash ([IO.File]::ReadAllBytes($PSCommandPath))
$payload = [Convert]::ToBase64String($utf8.GetBytes(($options | ConvertTo-Json -Compress)))
$command = @'
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
try {
    $safeDirectory = [Environment]::SystemDirectory
    [Environment]::CurrentDirectory = $safeDirectory
    Set-Location -LiteralPath $safeDirectory
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $script:CrossHubApprovedOptions = $utf8.GetString([Convert]::FromBase64String('CROSS_HUB_PAYLOAD')) | ConvertFrom-Json
    $bytes = [IO.File]::ReadAllBytes($script:CrossHubApprovedOptions.setup_path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [Convert]::ToBase64String($sha.ComputeHash($bytes)) }
    finally { $sha.Dispose() }
    if ($hash -cne $script:CrossHubApprovedOptions.setup_hash) {
        throw 'The Cross Hub installer changed after the approval request.'
    }
    & ([scriptblock]::Create($utf8.GetString($bytes)))
    exit 0
} catch {
    $detail = $_.Exception.Message
    [Console]::Error.WriteLine($detail)
    if ($script:CrossHubApprovedOptions.setup_attempt) {
        Write-EventLog -LogName 'Windows PowerShell' -Source 'PowerShell' `
            -EventId 41000 -EntryType Error -ErrorAction SilentlyContinue `
            -Message ("Cross Hub setup {0}: {1}" -f $script:CrossHubApprovedOptions.setup_attempt, $detail)
    }
    exit 1
}
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(
    $command.Replace('CROSS_HUB_PAYLOAD', $payload)))
$action = Get-CompactionTaskAction (Get-CompactionRoot) "compact-vhdx.ps1"
$process = Start-Process -FilePath $action.executable -Verb RunAs -PassThru -Wait `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
if ($process.ExitCode -ne 0) {
    $pattern = 'Cross Hub setup ' + $options.setup_attempt + ':'
    $event = Get-WinEvent -FilterHashtable @{LogName='Windows PowerShell'; Id=41000} `
        -MaxEvents 20 -ErrorAction SilentlyContinue |
        Where-Object { $_.Properties[0].Value -like "$pattern*" } | Select-Object -First 1
    $detail = if ($event) { $event.Properties[0].Value } else { '' }
    throw "Cross Hub administrator setup failed (exit $($process.ExitCode)). $detail"
}
$previewData.registered = $true
$previewData.startRequested = [bool]$requestedBoot
$previewData.workerUpdated = [bool]$requestedBoot
$previewData | ConvertTo-Json
