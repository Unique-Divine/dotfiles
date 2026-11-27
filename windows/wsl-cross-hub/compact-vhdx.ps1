# The scheduled task runs this protected copy with no arguments.
[CmdletBinding()]
param([switch]$DefineOnly)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$ProgressPreference = 'SilentlyContinue'

function Get-CompactionRoot {
    Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'WslCrossHubMaintenance'
}

function Get-CompactionRegistration([string]$Distro) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
        'Software\Microsoft\Windows\CurrentVersion\Lxss')
    if ($null -eq $key) { throw 'This Windows account has no registered WSL distros.' }
    try {
        $registrations = @(
            foreach ($name in $key.GetSubKeyNames()) {
                $guid = [guid]::Empty
                if (![guid]::TryParseExact($name, 'B', [ref]$guid)) { continue }
                $item = $key.OpenSubKey($name)
                try {
                    if ($item.GetValue('DistributionName') -cne $Distro -or
                        $item.GetValue('Version') -ne 2) { continue }
                    $base = $item.GetValue('BasePath')
                    if ($base -isnot [string]) { throw 'The WSL BasePath is invalid.' }
                    if ($base.StartsWith('\\?\')) { $base = $base.Substring(4) }
                    $leafName = $item.GetValue('VhdFileName', 'ext4.vhdx')
                    if ($leafName -isnot [string] -or $leafName -notmatch '^[a-zA-Z0-9_.-]+\.vhdx$') {
                        throw 'The WSL disk filename is invalid.'
                    }
                    if ($base -notmatch '^[a-zA-Z]:\\[ -~]+$' -or
                        $base.Substring(2) -match '[<>:"|?*/]') {
                        throw 'DiskPart setup requires a local, ASCII WSL disk path.'
                    }
                    [pscustomobject]@{
                        distro = $Distro
                        registration = $guid.ToString('B')
                        vhdx = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $leafName))
                    }
                } finally {
                    $item.Dispose()
                }
            }
        )
    } finally {
        $key.Dispose()
    }
    if ($registrations.Count -ne 1) { throw "Expected exactly one WSL 2 distro named $Distro." }
    $registrations[0]
}

function Initialize-CompactionFileApi([string]$Root) {
    # Keep the compiler's intermediates in the protected directory.
    if ('WslCrossHub.FilePins' -as [type]) { return }
    $oldTemp = $env:TEMP
    $oldTmp = $env:TMP
    $env:TEMP = $env:TMP = $Root
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace WslCrossHub {
    public sealed class FilePins : IDisposable {
        [StructLayout(LayoutKind.Sequential)]
        private struct FileInfo {
            public UInt32 Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
            public System.Runtime.InteropServices.ComTypes.FILETIME Access;
            public System.Runtime.InteropServices.ComTypes.FILETIME Write;
            public UInt32 Serial, SizeHigh, SizeLow, Links, IdHigh, IdLow;
        }

        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern SafeFileHandle CreateFile(
            string path, uint access, uint share, IntPtr security,
            uint mode, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle, out FileInfo info);

        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateHardLink(
            string link, string existing, IntPtr reserved);

        private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        public string VolumeSerial { get; private set; }
        public string FileId { get; private set; }
        public uint Links { get; private set; }

        public FilePins(string path, bool lockLeaf = false) {
            // Open each path component without following a reparse point.
            // A data handle additionally blocks deletion of the source file
            // while the administrator-protected hard link is being created.
            string current = Path.GetPathRoot(path);
            string[] parts = path.Substring(current.Length).Split('\\');
            try {
                for (int i = 0; i < parts.Length; i++) {
                    current = Path.Combine(current, parts[i]);
                    bool isFile = i == parts.Length - 1;
                    uint access = isFile && lockLeaf ? 0x81U : 0x80U;
                    var handle = CreateFile(current, access, 3, IntPtr.Zero, 3,
                        0x02200000, IntPtr.Zero);
                    handles.Add(handle);
                    if (handle.IsInvalid)
                        throw new Win32Exception(Marshal.GetLastWin32Error(), current);
                    FileInfo info;
                    if (!GetFileInformationByHandle(handle, out info))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), current);
                    if ((info.Attributes & 0x400) != 0 ||
                        ((info.Attributes & 0x10) == 0) != isFile)
                        throw new IOException("Unexpected path type: " + current);
                    if (isFile) {
                        if ((info.Attributes & 0x200) != 0)
                            throw new IOException("A sparse VHDX is outside this DiskPart workflow.");
                        Links = info.Links;
                        VolumeSerial = info.Serial.ToString("X8");
                        FileId = info.IdHigh.ToString("X8") + info.IdLow.ToString("X8");
                    }
                }
            } catch {
                Dispose();
                throw;
            }
        }

        public static void Link(string link, string existing) {
            if (!CreateHardLink(link, existing, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), link);
        }

        public void Dispose() {
            for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
            handles.Clear();
        }
    }

    public static class VirtualDiskInfo {
        [StructLayout(LayoutKind.Sequential)]
        private struct StorageType {
            public uint Device;
            public Guid Vendor;
        }

        [StructLayout(LayoutKind.Sequential, Size=28)]
        private struct OpenParameters {
            public uint Version, ReadWriteDepth;
        }

        [StructLayout(LayoutKind.Explicit, Size=40)]
        private struct Information {
            [FieldOffset(0)] public uint Version;
            [FieldOffset(8)] public uint Value;
        }

        [DllImport("virtdisk.dll", ExactSpelling=true)]
        private static extern uint OpenVirtualDisk(
            ref StorageType storage, [MarshalAs(UnmanagedType.LPWStr)] string path,
            uint access, uint flags, ref OpenParameters open, out SafeFileHandle handle);

        [DllImport("virtdisk.dll", ExactSpelling=true)]
        private static extern uint GetVirtualDiskInformation(
            SafeFileHandle handle, ref uint size, ref Information info, IntPtr sizeUsed);

        private static uint Query(string path, uint version) {
            const uint getInfoAndDetach = 0x000C0000;
            const uint noParents = 1;
            var storage = new StorageType {
                Device = 3, Vendor = new Guid("ec984aec-a0f9-47e9-901f-71415a66345b")
            };
            var parameters = new OpenParameters { Version = 1, ReadWriteDepth = 1 };
            SafeFileHandle handle;
            // Opening obtains a query handle only. The DETACH right lets the
            // API query a permanently attached disk; it does not detach it.
            uint error = OpenVirtualDisk(ref storage, path, getInfoAndDetach,
                noParents, ref parameters, out handle);
            using (handle) {
                if (error != 0) throw new Win32Exception((int)error, "OpenVirtualDisk: " + path);
                var info = new Information { Version = version };
                uint size = (uint)Marshal.SizeOf(typeof(Information));
                error = GetVirtualDiskInformation(handle, ref size, ref info, IntPtr.Zero);
                if (error != 0) throw new Win32Exception((int)error, "GetVirtualDiskInformation: " + path);
                return info.Value;
            }
        }

        public static bool IsLoaded(string path) { return Query(path, 13) != 0; }
        public static bool IsDynamic(string path) { return Query(path, 7) == 3; }
    }
}
'@
    } finally {
        $env:TEMP = $oldTemp
        $env:TMP = $oldTmp
    }
}

function Write-CompactionEvent {
    param([string]$Stage, [hashtable]$Fields = @{}, [switch]$BestEffort)
    try {
        $row = @{ at = [datetime]::UtcNow.ToString('o'); stage = $Stage; run_id = $runId } + $Fields
        $text = ($row | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
        $file = [IO.File]::Open($journal, 'Append', 'Write', 'ReadWrite')
        try {
            $file.Write($bytes, 0, $bytes.Length)
            $file.Flush($true)
        } finally {
            $file.Dispose()
        }
    } catch {
        if (!$BestEffort) { throw }
        $script:CompactionTelemetryError = $_.Exception.Message
    }
}

function Assert-VhdxAvailable([string]$Path) {
    if ([WslCrossHub.VirtualDiskInfo]::IsLoaded($Path)) {
        throw "Windows reports that the virtual disk is still attached: $Path"
    }
    $file = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    $file.Dispose()
}

if ($DefineOnly) { return }

function Assert-Offline {
    $ErrorActionPreference = 'Continue'
    $out = (& $wsl --list --running --quiet 2>&1 | Out-String) -replace '\x00|\uFEFF', ''
    $exited = $LASTEXITCODE
    $knownStopped = $out.Trim() -match '(?i)^(Windows Subsystem for Linux has no running distributions|There are no running distributions)\.?$'
    if (!$knownStopped -and ($exited -ne 0 -or $out.Trim())) {
        throw "Could not verify that WSL is stopped (exit $exited): $($out.Trim())"
    }
    if (Get-Process -Name 'Docker Desktop','com.docker.backend','com.docker.build','com.docker.proxy' -ErrorAction SilentlyContinue) {
        throw 'A Docker Desktop process is active.'
    }
}

function Assert-ApprovedDisk([object]$Pins, [object]$Target) {
    if ($Pins.VolumeSerial -cne $Target.volume_serial -or $Pins.FileId -cne $Target.file_id) {
        throw 'The WSL disk was replaced. Run Cross Hub setup to approve the new disk.'
    }
}

function Test-VhdxAvailable([string]$Path) {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try { Assert-VhdxAvailable $Path; return $true }
        catch { Start-Sleep -Seconds 1 }
    }
    return $false
}

function Invoke-CompactionDiskPart([string]$Phase, [string[]]$Commands) {
    $scriptPath = Join-Path $root ("diskpart-{0}-{1}.txt" -f $runId, $Phase)
    try {
        [IO.File]::WriteAllLines($scriptPath, $Commands, [Text.Encoding]::ASCII)
        $ErrorActionPreference = 'Continue'
        & $diskpart /s $scriptPath 2>&1 | ForEach-Object {
            foreach ($line in ("$_" -split "[`r`n]+")) {
                if (!$line.Trim()) { continue }
                $fields = @{ phase = $Phase; line = $line.Trim() }
                if ($line -match '(?i)^\s*(\d{1,3})\s*(?:percent completed|%)' -and
                    [int]$Matches[1] -le 100) {
                    $fields.percent = [int]$Matches[1]
                }
                Write-CompactionEvent 'diskpart-output' $fields -BestEffort
            }
        }
        $code = $LASTEXITCODE
        Write-CompactionEvent 'diskpart-exit' @{ phase = $Phase; exit_code = $code } -BestEffort
        return $code
    } finally {
        Remove-Item -LiteralPath $scriptPath -ErrorAction SilentlyContinue
    }
}

$root = Get-CompactionRoot
if ($PSScriptRoot -ine $root) { throw 'Run this helper from its protected install.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The compaction task must run with its registered administrator privileges.'
}
$journal = Join-Path $root 'diskpart.jsonl'
$wsl = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'WSL\wsl.exe'
if (![IO.File]::Exists($wsl)) { $wsl = Join-Path ([Environment]::SystemDirectory) 'wsl.exe' }
$diskpart = Join-Path ([Environment]::SystemDirectory) 'diskpart.exe'
$runId = [guid]::NewGuid().ToString()
$workStarted = $false
$compacted = $false
$detachVerified = $false
$failure = $null
$targetValidated = $false
$alias = Join-Path $root ("compaction-{0}.vhdx" -f $runId)
$aliasCreated = $false

Write-CompactionEvent 'diskpart-started' @{ pid = $PID }
try {
    $target = [IO.File]::ReadAllText((Join-Path $root 'target.json')) | ConvertFrom-Json
    if ($target.owner_sid -cne $identity.User.Value) {
        throw 'The compaction task is running under a different Windows account.'
    }
    $registered = Get-CompactionRegistration $target.distro
    if ($registered.registration -cne $target.registration -or $registered.vhdx -ine $target.vhdx) {
        throw 'The WSL registration changed. Run Cross Hub setup to approve the new disk.'
    }

    Initialize-CompactionFileApi $root
    $targetValidated = $true
    Assert-Offline
    Assert-VhdxAvailable $target.vhdx
    $pins = [WslCrossHub.FilePins]::new($target.vhdx, $true)
    try {
        Assert-ApprovedDisk $pins $target
        if ($pins.Links -ne 1) { throw 'The approved disk has an unexpected hard link.' }
        [WslCrossHub.FilePins]::Link($alias, $target.vhdx)
        $aliasCreated = $true
    } finally {
        $pins.Dispose()
    }

    # DiskPart uses this name inside the protected directory. Confirm that the
    # hard link opened the approved file before giving DiskPart the alias path.
    $pins = [WslCrossHub.FilePins]::new($alias)
    try {
        Assert-ApprovedDisk $pins $target
        if ($pins.Links -ne 2) { throw 'The WSL disk hard link count changed.' }
    } finally {
        $pins.Dispose()
    }
    Assert-VhdxAvailable $alias
    if (![WslCrossHub.VirtualDiskInfo]::IsDynamic($alias)) {
        throw 'The approved VHDX is not a standalone dynamically expandable disk.'
    }
    Assert-Offline
    $select = 'select vdisk file="{0}"' -f $alias
    Write-CompactionEvent 'compaction-started' @{ target = $target.vhdx; alias = $alias }
    $workStarted = $true
    try {
        $compacted = (Invoke-CompactionDiskPart 'compact' @(
            $select, 'attach vdisk readonly', 'compact vdisk', 'detach vdisk', 'exit'
        )) -eq 0
    } finally {
        Write-CompactionEvent 'detach-requested' -BestEffort
        $fallbackCode = $null
        $detachVerified = Test-VhdxAvailable $alias
        if (!$compacted -or !$detachVerified) {
            # DiskPart requires 15 seconds between successive scripts.
            Start-Sleep -Seconds 15
            $fallbackCode = Invoke-CompactionDiskPart 'detach' @(
                $select, 'detach vdisk', 'exit'
            )
            $detachVerified = Test-VhdxAvailable $alias
        }
        Write-CompactionEvent 'detach-observed' @{
            verified = $detachVerified
            exit_code = $fallbackCode
        } -BestEffort
    }
} catch {
    $failure = $_.Exception.Message
} finally {
    if ($aliasCreated -and (!$workStarted -or $detachVerified)) {
        try {
            [IO.File]::Delete($alias)
            $aliasCreated = $false
        } catch {
            $detachVerified = $false
            $failure = "Could not remove the maintenance hard link: $($_.Exception.Message)"
        }
    }
    if (!$aliasCreated -and (!$workStarted -or $detachVerified) -and $targetValidated) {
        try {
            $pins = [WslCrossHub.FilePins]::new($target.vhdx)
            try {
                Assert-ApprovedDisk $pins $target
                if ($pins.Links -ne 1) { throw 'The WSL disk hard link count changed.' }
                Assert-VhdxAvailable $target.vhdx
                $detachVerified = $true
            } finally {
                $pins.Dispose()
            }
        } catch {
            $detachVerified = $false
            if (!$failure) { $failure = $_.Exception.Message }
        }
    }
    if ($aliasCreated -and !$detachVerified) {
        $failure = "$failure Verify detachment before restarting WSL. Maintenance alias: $alias"
    }
    Write-CompactionEvent 'diskpart-result' @{
        work_started = $workStarted
        compaction_ok = $compacted
        detach_verified = $detachVerified
        error = $failure
        telemetry_error = $script:CompactionTelemetryError
    }
}
if (!$compacted -or !$detachVerified) { exit 1 }
