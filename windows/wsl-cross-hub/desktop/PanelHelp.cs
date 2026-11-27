namespace WslCrossHub.Desktop;

internal static class PanelHelp
{
    internal const string Text = """
        WSL Cross Hub help

        Get around

        Press ? or click Help to open this guide. Use j and k to move, l or
        Enter to open the selected row, and h or Esc to go back. Press Esc
        on the overview to hide the panel. Ctrl+U and Ctrl+D move one visible
        page up and down. F5 refreshes Windows status.

        Read the storage figures

        C: free space is the room available on your Windows drive. A VHDX
        is a Windows file that holds a WSL distribution's virtual disk.
        VHDX size shows the file's length. Linux filesystem
        free space is the room available to files inside Ubuntu. These
        figures refer to different layers of the same storage.

        Compact Ubuntu disk

        Select Compact Ubuntu disk and press Space or Enter to preview.
        The preview checks whether the approved Ubuntu disk is available
        and tells you what could block the job. If Docker is running,
        confirmation explains that Windows will stop it before compaction.

        A ready preview names the target disk and opens a confirmation.
        It starts on Cancel. To proceed, move to Start compaction and
        press Enter, or click that button. Opening help from confirmation
        closes the confirmation.

        Once the job starts, Windows asks Ubuntu to identify unused disk
        blocks, shuts down WSL, compacts the virtual disk, and restarts
        Ubuntu. Save your WSL work first. WSL connections disconnect
        during the job. You can hide Cross Hub and reopen it later.

        Follow a compaction

        The overview shows the current phase, elapsed time, and last
        activity. When DiskPart reports a percentage, the bar shows it.
        Open Compaction details for the full timeline and result.

        Find measurements and logs

        Recent measurements shows Windows free space and virtual disk
        sizes. Use j and k to move one reading at a time and Enter to
        open the full reading. The app saves samples about every five minutes while the
        tray app is running and when you refresh. You can find the recent
        samples in status-history.json inside %LOCALAPPDATA%\WslCrossHub.
        The Windows worker saves jobs in jobs.sqlite3. Compaction details
        reads the matching journal under the maintenance folder.

        Check the Windows worker

        Worker ready means the background Windows process checked in
        recently. Open Diagnostics and logs for that check-in time,
        setup problems, and recent log entries. Tab to Test Windows
        worker and press Enter to send a small test job and wait for
        completion. This is called a probe in the CLI. It leaves WSL
        running and does no disk cleanup.

        Diagnose an access problem

        Doctor checks Windows SSH and the saved Windows and Ubuntu Herdr
        sessions. Select a check and an available runner. Investigate
        gathers evidence without changing the machine. Cure asks for
        confirmation before Cross Hub can apply the action for that check.
        Open journal to see the job's observations, actions, and result.

        Auto-investigate starts Off. Choose Codex or Claude to let the
        agent investigate recurring failures. Doctor checks while the
        panel is open and pauses during compaction.

        Find Cross Hub again

        Click the Cross Hub icon in the Windows system tray or use the
        configured global hotkey. If Windows hides the icon under the
        tray arrow, its Taskbar settings let you show it by the clock.
        """;
}
