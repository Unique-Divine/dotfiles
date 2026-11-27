# WSL Cross Hub

The probe checks whether a Windows worker can accept a request from WSL,
acknowledge it, and finish after the caller exits. It waits two seconds and
records its Windows process ID and Python executable. The worker accepts
the fixed `probe` operation. The client can also check worker or job status.

## Windows Panel

Install the panel with `just wsl-cross-hub-desktop-install` from the dotfiles
checkout. On Windows, run `install-desktop.cmd` from the synced
`%USERPROFILE%\dotfiles\windows\wsl-cross-hub` directory. Building from
source uses the .NET 10 SDK. The installed desktop executable includes
its .NET runtime. Cross Hub uses Windows `uv` to provision Python 3.13.

Launch **WSL Cross Hub** from the Start Menu, click its tray icon, or
press `Alt+Shift+C`. Use **Set global hotkey** in the tray menu to change
the chord. **Start with Windows** starts the panel quietly at sign-in.
To see the icon beside Wi-Fi, drag it out of the tray overflow or enable
it under **Settings → Personalization → Taskbar → Other system tray icons**.
Close the window or press `Esc` from the overview to hide it to the tray.
Drag the title bar or use `Shift+hjkl` to move it. Use `j/k` to select,
`l` or `Enter` to open, and `h` or `Esc` to go back. Click or press `?`
for help with the actions, data, and shortcuts. **Data font** in the tray
menu changes the font for measurements and details. Consolas is the default.

The panel shows C: free space, WSL distribution and VHDX sizes, Docker
Desktop state, and the worker heartbeat. **Compact Ubuntu disk** opens a
preview. Windows starts the job after you choose **Start compaction**.
**Diagnostics and logs** contains **Test Windows worker**, which sends a
small job to check that Windows can accept and complete a request.

**Recent measurements** reads `status-history.json` and shows one row per
sample. The tray app samples about every five minutes and keeps up to 288
readings from the last 24 hours. Refresh takes another sample. Windows
stores job state in `jobs.sqlite3` and each compaction timeline in
`maintenance\<job-id>.jsonl`.

From a native Windows shell, including the `main-ud-win` Herdr session,
read the latest snapshot without opening the panel.

```powershell
& "$env:LOCALAPPDATA\Programs\WslCrossHub\status.cmd"
```

Pass `-Operation collect` to take and store a fresh sample. With no
arguments, the command reuses the last sample if available and checks the
current worker heartbeat. Desktop diagnostics are in `logs\desktop.log`.

Desktop settings and logs are under `%LOCALAPPDATA%\WslCrossHub`. The
desktop install uses its own program directory and shortcuts. It leaves
the existing boot task and installed worker in place. Uninstall with
`just wsl-cross-hub-desktop-uninstall` or the Windows
`uninstall-desktop.cmd` script. Settings, measurements, and logs remain.

Use `build-desktop.cmd -RuntimeIdentifier win-x64` to publish a package
for Homebox or `win-arm64` for the laptop. The package contains its own
installer and goes into `%LOCALAPPDATA%\WslCrossHub\build` by default.
Pass `-UvExe` with a Windows `uv.exe` for the target architecture to
include it in the package.

## Command Line

Run `wsl-cross-hub` from WSL. The CLI uses Python through `uv` and has no
third-party runtime dependencies. The Windows worker continues after your
WSL terminal disconnects.

The CLI uses the Windows scripts staged by `just win-sync` when available.
It also works through the scripts in the installed Windows app, so a sync
from a checkout without Cross Hub can remove the staged copy without
breaking the CLI.

```sh
wsl-cross-hub doctor
wsl-cross-hub setup
wsl-cross-hub setup --apply
wsl-cross-hub doctor
```

The first command checks the worker and the compaction task. The setup
preview requests no elevation. Apply setup while signed in at the Windows
desktop and approve the Windows UAC dialog once. Setup installs fixed
DiskPart and SSH recovery tasks in an administrator-protected directory and starts the
updated, unprivileged boot worker. The disk task runs on demand. Closing
the desktop panel does not stop the boot worker.
The approved VHDX must be on the same local NTFS volume as Program Files.
Setup can upgrade an installed worker while compaction is idle.
Routine runs use the protected tasks without a UAC prompt.

Once the doctor reports compaction ready, finish active WSL work and
submit compaction from WSL. The Windows worker gracefully stops Docker
Desktop if it is running and waits for its distributions to stop. Docker
stays stopped after the run.

```sh
wsl-cross-hub compact
wsl-cross-hub job <job-id>
wsl-cross-hub logs <job-id>
```

Save the job ID before disconnecting. The Windows worker runs TRIM, shuts
down WSL, waits for the DiskPart task to compact and release the VHDX,
then starts the configured distro and checks recovery. It records phase
changes and DiskPart output in `maintenance\<job-id>.jsonl` under the state
directory. Actual elevation and reboot behavior require a live Windows test.

From a Windows Herdr pane, use the native client while the Linux side is
offline. It uses the registered Windows Python runtime.

```powershell
$client = "$env:USERPROFILE\dotfiles\windows\wsl-cross-hub\client.cmd"
& $client -Operation status -JobId $jobId
& $client -Operation logs -JobId $jobId
```

Set `$jobId` to the ID returned by `compact`. If a job reports `attention`
or `interrupted` and Ubuntu remains offline, the Windows client command
`-Operation acknowledge-hold -JobId $jobId` checks task state, the pinned
disk identity, and exclusive access before clearing the hold. If the check
fails, keep WSL offline and inspect the protected DiskPart journal and any
stranded `compaction-*.vhdx` alias under `%ProgramFiles%\WslCrossHubMaintenance`.
If the check passes, start Ubuntu from Windows and check remote access.


## Doctor and Cure

Open **Doctor** from the Windows overview. Cross Hub opens your native Windows
Neovim with the shared dotfiles config. The selected row shows what Enter will
do. Use `/` to search, Enter to accept the search, and `n` or `N` to move to
matches. `F5` refreshes the current view, and Escape goes back or closes it.
**Open journal** displays Doctor job logs in a searchable buffer. From
**Diagnostics and logs**, choose **Open logs in Neovim** for the desktop and
worker logs. The tray menu also has **Doctor in Windows panel**.

Doctor checks Windows SSH and the saved Windows and Ubuntu Herdr servers. It
checks every minute while Doctor is open
and pauses during compaction. **Auto-investigate** defaults to **Off**. Choose
**Codex** or **Claude** to investigate once after two failures for the same
check. A healthy check resets that incident.

Run these commands from Ubuntu:

```sh
wsl-cross-hub doctor --checks
wsl-cross-hub doctor --investigate windows-ssh --runner codex
wsl-cross-hub doctor --cure ubuntu-herdr --runner claude
wsl-cross-hub job <job-id>
wsl-cross-hub logs <job-id>
wsl-cross-hub logs <job-id> --agent
```

Run the equivalent commands from Windows PowerShell:

```powershell
$client = "$env:LOCALAPPDATA\Programs\WslCrossHub\client.cmd"
& $client -Operation doctor
& $client -Operation doctor-job -Mode investigate -CheckId windows-ssh -Runner codex
& $client -Operation doctor-job -Mode cure -CheckId ubuntu-herdr -Runner claude
& $client -Operation status -JobId $jobId
& $client -Operation logs -JobId $jobId
& $client -Operation doctor-agent-logs -JobId $jobId
```

Check which runners Doctor offers before choosing one. Cross Hub uses the
selected CLI's existing sign-in and runs it on the affected host. Run the
one-time Cross Hub setup after installing an updated worker. Windows
investigations can still run when Ubuntu is offline.

For a nonstandard installation, put runner paths in `doctor-runners.json` in
the Cross Hub state directory. Under `windows` or `ubuntu`, add a `codex` or
`claude` object with the runner's absolute `executable` and `home` paths. Use
paths native to that host. `home` is the runner's existing configuration and
sign-in directory.

An investigation only proposes a next step. A manual cure can start the saved
Herdr server on the selected host or invoke the Windows recovery task for SSH.
That task can also start Tailscale if installed. The worker checks the live state before
starting anything and reruns the check before reporting **Cured**. The job
journal records the diagnosis, requested action, and check results. Its
companion agent stream contains bounded, redacted event information.

### Neovim Setup and Cure

Run these from the dotfiles checkout in WSL:

```sh
just win-neovim-install
just wsl-cross-hub-desktop-install
wsl-cross-hub setup --apply
```

`just win-sync` stages the shared config and plugin lock. The editor installer
verifies the checksum of the pinned upstream ZIP for the Windows architecture
and installs it under your Windows user profile. It applies the staged config
to the normal Windows Neovim config directory. It preserves an unmanaged
directory and backs up the previous managed copy before replacing it. Run
`just win-neovim-install` again after updating the shared config or editor pin.
The tray uses the managed binary. Your shell's existing Neovim install
and PATH are managed separately.

Doctor shows the managed Neovim version and config status for both Windows and
WSL. **Cure** on a Windows editor check applies the staged config and verified
ZIP. **Cure** on a WSL editor check uses the existing mise lock and restores the
managed config link to the checkout that supplied the staged config. Both
actions require confirmation in the UI
and run through the Windows worker. They use the dotfiles installer and record
the verification result in the same journal as other Doctor jobs.


## Boot Worker Setup

Run `just win-sync` in dotfiles to copy the scripts to
`%USERPROFILE%\dotfiles\windows\wsl-cross-hub`. Windows `uv.exe` is the
only runtime prerequisite for a fresh setup. Cross Hub finds it next to
the launcher at `runtime\uv.exe`, on the Windows PATH, or in its local
runtime directory. A packaged Windows build can ship an architecture-matched
`runtime\uv.exe` in that first location.

From an ordinary Windows terminal, run:

```powershell
$root = "$env:USERPROFILE\dotfiles\windows\wsl-cross-hub"
& "$root\wsl-cross-hub.cmd"
& "$root\wsl-cross-hub.cmd" -Setup
```

The first command reports uv, the Windows Python runtime, the task's
registration and last result, and the worker heartbeat. The second
previews boot registration if the task is missing. To accept the preview,
repeat it with `-Setup -Apply`. Setup uses uv to install native Windows
Python 3.13 if needed, then requests Windows UAC under the same account.
Status and preview never download Python or request elevation. If the task
is already registered, the launcher checks its configured interpreter.
Check for worker state `ready` after Windows accepts the task start request.

From WSL, including an SSH session, use the read-only wrapper from the
dotfiles checkout:

```bash
bash windows/wsl-cross-hub/doctor-from-wsl.sh
bash windows/wsl-cross-hub/doctor-from-wsl.sh --setup-preview
```

The wrapper uses Windows PowerShell and looks for the synced Hub in the
Windows user's profile. Run `just win-sync` if that copy is missing. A
WSL interop failure has a separate diagnostic. The wrapper keeps the
Windows command's exit code.

Task registration is the only elevated operation. The installer registers
a Limited task and asks Task Scheduler to start it. Task Scheduler runs
the user-profile Python and worker under that Limited Windows account.
It launches the provisioned interpreter directly so that boot can work
offline. Use `-PythonExe` to select an explicit interpreter for diagnostics.
Before requesting UAC, setup copies the worker to the state directory's
`app\worker.py`. The task uses that copy, so later dotfiles syncs can
replace or remove the staged scripts independently. Ordinary diagnostics
and setup previews leave the installed worker and state directory alone.
An existing boot task keeps using its installed worker after `just win-sync`.
Installing a newer worker for that task requires a separate update.

## Run a Probe Without the Task

Run the worker in one Windows PowerShell window:

```powershell
$root = "$env:USERPROFILE\dotfiles\windows\wsl-cross-hub"
$python = "C:\path\to\python.exe"
& $python -I -S "$root\worker.py" worker
```

In another window, submit a probe and query its status. The first command
returns once the worker has committed the job acknowledgment. The response
includes the job ID for later queries.

```powershell
$ack = & "$root\client.cmd" -Operation probe -PythonExe $python |
    ConvertFrom-Json
& "$root\client.cmd" -Operation status -PythonExe $python -JobId $ack.job_id
```

From WSL, use the same Windows paths with the PowerShell entry point:

```sh
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "$windows_root\client.ps1" -Operation probe -PythonExe "$windows_python"
```

The PowerShell variables `$root` and `$python` correspond to the shell
variables `$windows_root` and `$windows_python` in that example. Use
`status` without a job ID to get the worker PID and heartbeat. If a probe
times out waiting for its acknowledgment, its request can still complete
later. Query the ID printed in the error before retrying.

## Manage the Boot Task

For a manual installation, preview the task directly with the installer:

```powershell
& "$root\install-task.cmd" -PythonExe $python
```

The direct installer uses the worker next to it. To use an existing
stable copy, pass its directory to the installer with `-InstallRoot`.

Stop any foreground worker before switching to the scheduled task.
Open **Windows PowerShell as Administrator** on Windows and rerun the
command with `-Apply`. Registration of a startup trigger requires an
administrator. The task action itself runs with Limited privileges as
your Windows account, including when you use S4U for noninteractive logon.
For manual registration with a different account, pass the intended user
with `-UserId`, pass that user's absolute local state path with
`-StateDir`, and use the intended user's staged paths. Verify whether
S4U starts successfully under the selected account. If you override the
state directory, pass the same value to the client with `-StateDir`.

The task `Unique-WslCrossHub` starts at boot and has a
one-minute trigger to recover after the worker exits. It skips launches
while an instance is running. It has no execution time limit and can
run on battery. The installer reports registration and a request to start.
Check the worker heartbeat separately and inspect the last task result:

```powershell
Get-ScheduledTask -TaskName Unique-WslCrossHub
Get-ScheduledTaskInfo -TaskName Unique-WslCrossHub
& "$root\client.cmd" -Operation status -PythonExe $python
```

If S4U cannot log on, check the account's **Log on as a batch job** right
and the Task Scheduler Operational log. For a password-backed task,
open the task's **General** tab in Task Scheduler, keep **Run whether user
is logged on or not** selected, and clear **Do not store password**. Enter
the account password in the Windows dialog when you save. Keep **Run with
highest privileges** cleared.

Use the task's **Disable** action to pause automatic starts before you stop
it, or **Delete** to unregister the experiment. Test startup without sign-in
during an agreed reboot window.

## State and Timing

The worker stores requests and job records under
`%LOCALAPPDATA%\WslCrossHub`. It holds an operating-system lock
for the lifetime of the worker, commits job state in SQLite, and marks an
unfinished accepted probe as interrupted when it starts again. The worker
and client can share a separate test directory via flag `--state-dir` on
the Python script and flag `-StateDir` on the PowerShell client. Keep the
directory on local NTFS on Windows.

The worker writes `logs\worker.log` under the state directory. Entries use
UTC timestamps and include the worker PID. They record startup, failures,
rejected requests, and probe outcomes by job ID. The log rotates at 1 MiB
and keeps three backups.

```powershell
Get-Content "$env:LOCALAPPDATA\WslCrossHub\logs\worker.log" -Tail 30
```

The worker runs with limited privileges from the user profile. Setup
registers the administrator-protected DiskPart task separately. Its
installation pins the WSL distribution and disk, and the task accepts no
caller-supplied arguments.

Run `benchmark.cmd -Samples 8` on Windows to compare starting a native
PowerShell process with sending a fixed request to a warm process. It
reports startup and request latency separately. These measurements cover
PowerShell, independent of the worker and the WSL-to-Windows handoff.

## Tests

From the dotfiles checkout in WSL, run `uvx pytest -q windows/wsl-cross-hub`.
The suite skips native Windows launcher tests under Linux Python. Some
publication tests also skip when the filesystem disallows symbolic links.

From Windows PowerShell, use native Python 3.13 to include the launcher
tests. Set `$uv` to the path of Windows `uv.exe`.

```powershell
& $uv tool run --python 3.13 --from pytest pytest -q $root
```

To include the fresh setup test, set `$env:WSL_CROSS_HUB_TEST_UV = $uv`
before running pytest. It copies uv into a disposable bundle, installs
Python into an empty temporary directory, and mocks the UAC request.

## Inventory and Maintenance Preview

Run `inventory.cmd` for a JSON snapshot of C: free space, registered and
running WSL distros, VHDX file lengths and sparse flags, and the Docker
Desktop process. An unavailable observation appears as `null` with a
diagnostic in `errors`. The inventory lists distros without starting them.

Pass the snapshot to the planner with the Windows registration name.
In Windows PowerShell, use UTF-8 when piping JSON to native Python.

```powershell
& {
    $OutputEncoding = New-Object Text.UTF8Encoding($false)
    & "$root\inventory.ps1" | & $python -I -S "$root\maintenance_plan.py" --distro Ubuntu-24.04
}
```

The planner reports `eligible` with symbolic steps or `blocked` with reasons.
Both decisions exit with status 0. Invalid input exits with status 2.
The current plan covers offline compaction without TRIM. It blocks when
Docker Desktop or another distro is running because the current Windows
compaction script can shut down all of WSL. The planner has no executor.

From Windows PowerShell, rehearse the stages in the current plan and
inspect the simulated journal.

```powershell
$status = "$env:LOCALAPPDATA\Programs\WslCrossHub\status.cmd"
& $status -Operation rehearse -Distro Ubuntu-24.04 -Scenario restart-failed
```

A blocked preview stays blocked in the rehearsal. To exercise every stage,
pass an eligible fixture plan to `maintenance_rehearsal.py` on stdin.
The journal labels the result `simulated` and reports compaction and
recovery separately. It runs no maintenance commands.

## Publish Linux Storage Measurements

Run the guest reporter while you are already inside WSL. It measures the
Linux root filesystem, home trash, and Cargo build output in the Git
worktrees you name. It prints candidate paths and allocated bytes for
review. Verify that a worktree and its build output are idle before
choosing cleanup targets.

```sh
just wsl-cross-hub-guest-report \
  --repo "$HOME/sai-perps" --repo "$HOME/boku/dotfiles" \
  --target-relative herdr/target
```

Add `--publish` to save the same report under
`%LOCALAPPDATA%\WslCrossHub\guest-reports`. Windows reads the saved report
and displays its timestamp. A report more than 24 hours old is stale.
Run the same command to refresh it after measuring a cleanup. The Windows
panel reads the report without launching the distro.

If you separately ran `fstrim`, pass `--trim-at` with its UTC timestamp
and `--trim-bytes` with the byte count you observed. Linux used bytes,
TRIM bytes, VHDX length, and Windows volume free space describe different
measurements. Compare the Windows baseline and result to measure host
space recovered by compaction.
