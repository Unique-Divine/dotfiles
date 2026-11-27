"""Exercise the native installer and NTFS identity guard without elevation."""

import base64
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent
SYSTEM_POWERSHELL = Path("WindowsPowerShell/v1.0/powershell.exe")
WSL_SYSTEM32 = Path("/mnt/c/Windows/System32")


@pytest.fixture
def windows_shell() -> tuple[Path, str, Path]:
    if sys.platform == "win32":
        powershell = Path(os.environ["SystemRoot"]) / "System32" / SYSTEM_POWERSHELL
        root = str(ROOT)
        cwd = powershell.parent
    elif WSL_SYSTEM32.is_dir() and (wslpath := shutil.which("wslpath")):
        powershell = WSL_SYSTEM32 / SYSTEM_POWERSHELL
        root = subprocess.check_output([wslpath, "-w", str(ROOT)], text=True).strip()
        cwd = WSL_SYSTEM32
    else:
        pytest.skip("requires Windows PowerShell, native or through WSL interop")
    if not powershell.is_file():
        pytest.skip("Windows PowerShell is unavailable")
    return powershell, root.replace("'", "''"), cwd


def run_script(
    shell: tuple[Path, str, Path], source: str
) -> subprocess.CompletedProcess[str]:
    powershell, root, cwd = shell
    script = f"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Set-Location -LiteralPath ([IO.Path]::GetTempPath())
$sourceRoot = '{root}'
{source}
"""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return subprocess.run(
        [
            str(powershell),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=30,
        cwd=cwd,
        check=False,
    )


def test_setup_preview_and_mocked_admin_launch(windows_shell: tuple[Path, str, Path]) -> None:
    result = run_script(
        windows_shell,
        r"""
$installer = Join-Path $sourceRoot 'install-compaction.ps1'
$helper = Join-Path $sourceRoot 'compact-vhdx.ps1'
. $helper -DefineOnly
try { $null = Get-CompactionRegistration 'Ubuntu-24.04' }
catch { if ($_.Exception.Message -match 'no registered|exactly one') { exit 88 }; throw }

$global:CrossHubTestApprovalRequests = 0
function global:Start-Process {
    param($FilePath, $WorkingDirectory, $Verb, $ArgumentList, [switch]$PassThru, [switch]$Wait)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $system = [Environment]::SystemDirectory
    $expectedShell = Join-Path $system 'WindowsPowerShell\v1.0\powershell.exe'
    if (($elevated -and $Verb) -or (!$elevated -and $Verb -ne 'RunAs') -or
        $FilePath -ine $expectedShell -or $WorkingDirectory -ine $system -or
        ($ArgumentList[0..2] -join ' ') -ne '-NoProfile -NonInteractive -EncodedCommand' -or
        !$PassThru -or !$Wait) {
        throw 'Installer did not use the expected synchronous system PowerShell launch.'
    }
    $bootstrap = [Text.Encoding]::Unicode.GetString(
        [Convert]::FromBase64String($ArgumentList[-1]))
    $null = [scriptblock]::Create($bootstrap)
    if ($bootstrap -notmatch "FromBase64String\('([A-Za-z0-9+/=]+)'\)") {
        throw 'Installer did not pass a setup snapshot.'
    }
    $options = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String($Matches[1])) | ConvertFrom-Json
    if ($options.distro -ne 'Ubuntu-24.04' -or !$options.helper_hash -or
        !$options.setup_hash -or !$options.volume_serial -or !$options.file_id) {
        throw 'The approval snapshot did not include installer hash and disk identity.'
    }
    $global:CrossHubTestApprovalRequests++
    [pscustomobject]@{ ExitCode = 0 }
}

$preview = & $installer -Preview | ConvertFrom-Json
if ($global:CrossHubTestApprovalRequests -ne 0) { throw 'Preview requested elevation.' }
$applied = & $installer | ConvertFrom-Json
if ($global:CrossHubTestApprovalRequests -ne 1) { throw 'Expected one approval.' }
@{ preview = $preview; applied = $applied } | ConvertTo-Json -Depth 5
""",
    )
    if result.returncode == 88:
        pytest.skip("the designated Ubuntu-24.04 WSL 2 distro is not registered")
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    preview = report["preview"]
    assert preview["distro"] == "Ubuntu-24.04"
    assert preview["task"] == "Unique-WslCrossHub-Compact"
    assert preview["privileges"] == "Highest"
    assert preview["trigger"] == "On demand"
    assert preview["registered"] is False
    assert report["applied"]["registered"] is True
    assert report["applied"]["file_id"] == preview["file_id"]


def test_adapter_storage_rejects_hard_links(
    windows_shell: tuple[Path, str, Path],
) -> None:
    result = run_script(
        windows_shell,
        r"""
$installer = Join-Path $sourceRoot 'install-tailnet-api.ps1'
$tokens = $null
$parseErrors = $null
$syntax = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Assert-PrivateItem', 'Initialize-PrivateRoot', 'Publish-PrivateFile')) {
    $function = $syntax.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $false)
    if (!$function) { throw "Missing installer function: $name" }
    . ([scriptblock]::Create($function.Extent.Text))
}
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$scratch = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
Initialize-PrivateRoot $scratch $owner
try {
    foreach ($name in @('token', 'tailnet_api.py')) {
        $path = Join-Path $scratch $name
        Publish-PrivateFile $path ([byte[]](1, 2, 3)) $owner
        $alias = "$path.link"
        Push-Location -LiteralPath $scratch
        try { New-Item -Path $alias -ItemType HardLink -Target $path | Out-Null }
        finally { Pop-Location }
        try {
            Assert-PrivateItem $path $owner $false
            throw "The installer accepted a hard-linked $name."
        } catch {
            if ($_.Exception.Message -notlike 'Unexpected adapter storage item:*') { throw }
        }
    }
} finally {
    [IO.Directory]::Delete($scratch, $true)
}
""",
    )
    assert result.returncode == 0, result.stderr


def test_adapter_rollback_restores_old_task_after_cleanup_failure(
    windows_shell: tuple[Path, str, Path],
) -> None:
    result = run_script(
        windows_shell,
        r"""
$installer = Join-Path $sourceRoot 'install-tailnet-api.ps1'
$tokens = $null
$parseErrors = $null
$syntax = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = $syntax.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Restore-AdapterTask'
}, $false)
if (!$function) { throw 'Missing adapter rollback function.' }
. ([scriptblock]::Create($function.Extent.Text))

$calls = [Collections.Generic.List[string]]::new()
function Disable-ScheduledTask {
    [CmdletBinding()] param($TaskName, $TaskPath)
    $calls.Add('disable')
    throw 'disable failed'
}
function Stop-ScheduledTask {
    [CmdletBinding()] param($TaskName, $TaskPath)
    $calls.Add('stop')
    throw 'stop failed'
}
function Register-ScheduledTask {
    [CmdletBinding()] param($TaskName, $TaskPath, $Xml, [switch]$Force)
    if ($TaskName -cne 'adapter' -or $Xml -cne '<old/>' -or !$Force) {
        throw 'The previous registration was not restored.'
    }
    $calls.Add('register')
}
function Start-ScheduledTask {
    [CmdletBinding()] param($TaskName, $TaskPath)
    $calls.Add('start')
}

$errors = @(Restore-AdapterTask 'adapter' $true '<old/>' $true)
if (($calls -join ',') -cne 'disable,stop,register,start') {
    throw "Unexpected rollback operations: $($calls -join ',')"
}
if ($errors.Count -ne 2 -or $errors[0] -notlike '*disable failed*' -or $errors[1] -notlike '*stop failed*') {
    throw "Unexpected rollback diagnostics: $($errors -join ',')"
}
""",
    )
    assert result.returncode == 0, result.stderr


def test_adapter_requires_configured_compaction_target(
    windows_shell: tuple[Path, str, Path],
) -> None:
    result = run_script(
        windows_shell,
        r"""
$installer = Join-Path $sourceRoot 'install-tailnet-api.ps1'
$tokens = $null
$parseErrors = $null
$syntax = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Get-SafeLocalPath', 'Assert-CompactionReady', 'Test-AdapterReady')) {
    $function = $syntax.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $false)
    if (!$function) { throw "Missing installer function: $name" }
    . ([scriptblock]::Create($function.Extent.Text))
}

function Get-ScheduledTask {
    [CmdletBinding()] param($TaskName, $TaskPath)
    if ($TaskName -cne 'Unique-WslCrossHub-Compact' -or $TaskPath -cne '\') {
        throw 'The installer queried the wrong task.'
    }
    if ($taskState) { [pscustomobject]@{State = $taskState} }
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$root = Join-Path $scratch 'WslCrossHubMaintenance'
$null = [IO.Directory]::CreateDirectory($root)
try {
    $taskState = 'Ready'
    try {
        Assert-CompactionReady $scratch
        throw 'The installer accepted missing compaction files.'
    } catch {
        if ($_.Exception.Message -notlike 'Missing WSL Cross Hub compaction setup file:*') { throw }
    }
    foreach ($name in @('target.json', 'compact-vhdx.ps1', 'diskpart.jsonl')) {
        [IO.File]::WriteAllText((Join-Path $root $name), '')
    }
    foreach ($taskState in @($null, 'Disabled', 'Running', 'Queued')) {
        try {
            Assert-CompactionReady $scratch
            throw 'The installer accepted a compaction task that was not ready.'
        } catch {
            if ($_.Exception.Message -notlike 'WSL Cross Hub compaction must be configured and idle.*') { throw }
        }
    }
    $taskState = 'Ready'
    Assert-CompactionReady $scratch
} finally {
    [IO.Directory]::Delete($scratch, $true)
}

$status = [pscustomobject]@{worker_state = 'ready'; recovery_protocol = 1; distro = $null; distro_running = $null}
if (Test-AdapterReady $status 1) { throw 'An unconfigured target reported ready.' }
$status.distro = 'Ubuntu'
$status.distro_running = $false
if (!(Test-AdapterReady $status 1)) { throw 'A configured, offline target did not report ready.' }
if (Test-AdapterReady $status 2) { throw 'An incompatible worker reported ready.' }
""",
    )
    assert result.returncode == 0, result.stderr


def test_diskpart_alias_preserves_disk_identity(
    windows_shell: tuple[Path, str, Path],
) -> None:
    result = run_script(
        windows_shell,
        r"""
. (Join-Path $sourceRoot 'compact-vhdx.ps1') -DefineOnly
Initialize-CompactionFileApi ([IO.Path]::GetTempPath())
$scratch = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$null = [IO.Directory]::CreateDirectory($scratch)
try {
    $source = Join-Path $scratch 'source.vhdx'
    $alias = Join-Path $scratch 'alias.vhdx'
    [IO.File]::WriteAllText($source, 'fixture')
    $original = [WslCrossHub.FilePins]::new($source, $true)
    try {
        $renamed = $false
        try {
            [IO.File]::Move($source, ($source + '.moved'))
            $renamed = $true
        } catch [IO.IOException] {}
        if ($renamed) { throw 'The source path was renamed despite the data handle.' }
        [WslCrossHub.FilePins]::Link($alias, $source)
        $serial = $original.VolumeSerial
        $fileId = $original.FileId
    } finally {
        $original.Dispose()
    }

    $linked = [WslCrossHub.FilePins]::new($alias)
    try {
        if ($linked.VolumeSerial -cne $serial -or $linked.FileId -cne $fileId -or
            $linked.Links -ne 2) { throw 'Hard link has a different identity.' }
    } finally {
        $linked.Dispose()
    }
    [IO.File]::Open($alias, 'Open', 'Read', 'None').Dispose()
    [IO.File]::Delete($alias)
    if ([IO.File]::ReadAllText($source) -cne 'fixture') {
        throw 'Discarding the hard link changed the source.'
    }
} finally {
    [IO.Directory]::Delete($scratch, $true)
}
""",
    )
    assert result.returncode == 0, result.stderr


def test_journal_failure_can_be_ignored_during_detach(
    windows_shell: tuple[Path, str, Path],
) -> None:
    result = run_script(
        windows_shell,
        r"""
. (Join-Path $sourceRoot 'compact-vhdx.ps1') -DefineOnly
$scratch = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$null = [IO.Directory]::CreateDirectory($scratch)
try {
    $runId = [guid]::NewGuid().ToString()
    $journal = $scratch  # Opening a directory as a journal must fail.
    $strictFailed = $false
    try { Write-CompactionEvent 'diskpart-started' }
    catch { $strictFailed = $true }
    if (!$strictFailed) { throw 'Starting without a readable journal should fail.' }

    Write-CompactionEvent 'detach-requested' -BestEffort
    if (!$script:CompactionTelemetryError) {
        throw 'Missing best-effort event should be recorded in memory.'
    }
    $journal = Join-Path $scratch 'diskpart.jsonl'
    Write-CompactionEvent 'diskpart-result' @{ detach_verified = $true }
    $row = [IO.File]::ReadAllText($journal) | ConvertFrom-Json
    if ($row.stage -ne 'diskpart-result' -or $row.run_id -ne $runId -or
        !$row.detach_verified) {
        throw 'Terminal event was lost after the earlier journal failure.'
    }
} finally {
    [IO.Directory]::Delete($scratch, $true)
}
""",
    )
    assert result.returncode == 0, result.stderr


def test_native_virtual_disk_detachment_query_on_linked_vhdx(
    windows_shell: tuple[Path, str, Path],
) -> None:
    result = run_script(
        windows_shell,
        r"""
. (Join-Path $sourceRoot 'compact-vhdx.ps1') -DefineOnly
Initialize-CompactionFileApi ([IO.Path]::GetTempPath())
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class VhdxFixture {
    [StructLayout(LayoutKind.Sequential)]
    private struct StorageType { public uint Device; public Guid Vendor; }

    [StructLayout(LayoutKind.Sequential)]
    private struct CreateParameters {
        public uint Version;
        public Guid UniqueId;
        public ulong MaximumSize;
        public uint BlockSize, SectorSize;
        public IntPtr Parent, Source;
    }

    [DllImport("virtdisk.dll", ExactSpelling=true)]
    private static extern uint CreateVirtualDisk(
        ref StorageType storage, [MarshalAs(UnmanagedType.LPWStr)] string path,
        uint access, IntPtr security, uint flags, uint providerFlags,
        ref CreateParameters parameters, IntPtr overlapped, out SafeFileHandle handle);

    public static void Create(string path) {
        var storage = new StorageType {
            Device = 3, Vendor = new Guid("ec984aec-a0f9-47e9-901f-71415a66345b")
        };
        var parameters = new CreateParameters {
            Version = 1, MaximumSize = 64 * 1024 * 1024, SectorSize = 512
        };
        SafeFileHandle handle;
        uint error = CreateVirtualDisk(ref storage, path, 0x003f0000,
            IntPtr.Zero, 0, 0, ref parameters, IntPtr.Zero, out handle);
        using (handle) {
            if (error != 0) throw new Win32Exception((int)error, "CreateVirtualDisk: " + path);
        }
    }
}
'@
$scratch = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$null = [IO.Directory]::CreateDirectory($scratch)
try {
    $source = Join-Path $scratch 'source.vhdx'
    $alias = Join-Path $scratch 'alias.vhdx'
    [VhdxFixture]::Create($source)
    [WslCrossHub.FilePins]::Link($alias, $source)
    foreach ($path in @($source, $alias)) {
        if (![WslCrossHub.VirtualDiskInfo]::IsDynamic($path)) {
            throw 'Windows did not report a dynamically expandable VHDX.'
        }
        Assert-VhdxAvailable $path
    }
    $invalid = Join-Path $scratch 'invalid.vhdx'
    [IO.File]::WriteAllText($invalid, 'not a virtual disk')
    $rejected = $false
    try { Assert-VhdxAvailable $invalid }
    catch { $rejected = $true }
    if (!$rejected) {
        throw 'An exclusive file open should not establish detachment by itself.'
    }
} finally {
    [IO.Directory]::Delete($scratch, $true)
}
""",
    )
    assert result.returncode == 0, result.stderr


def test_powershell_readiness_signature_matches_python(
    windows_shell: tuple[Path, str, Path],
) -> None:
    import tailnet_api

    token = "fixture-signing-credential-value"
    result = run_script(
        windows_shell,
        r"""
$installer = Join-Path $sourceRoot 'install-tailnet-api.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
$function = $ast.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Get-AdapterMac'
}, $false)
. ([scriptblock]::Create($function.Extent.Text))
$payload = [Text.Encoding]::UTF8.GetBytes("Cross Hub request v1`n1760000000`n0123456789abcdef0123456789abcdef`nGET`n/v1/status`n")
Get-AdapterMac 'fixture-signing-credential-value' $payload
""",
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == tailnet_api.request_signature(
        token.encode(), "1760000000", "0123456789abcdef0123456789abcdef",
        "GET", "/v1/status", "",
    )
