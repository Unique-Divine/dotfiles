using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace WslCrossHub.Desktop;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var command = args.Length == 0 ? "--show" : args[0];
        if (args.Length > 1 || command is not ("--show" or "--tray" or "--quit" or "--self-test"
            or "--doctor-auto-off" or "--doctor-auto-codex" or "--doctor-auto-claude"))
            return 2;
        if (command == "--self-test")
            return DesktopSelfTest.Run();

        using var identity = WindowsIdentity.GetCurrent();
        var session = Process.GetCurrentProcess().SessionId;
        var location = Environment.ProcessPath!.ToUpperInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(location)))[..16];
        var address = $"WslCrossHub.Desktop.{identity.User?.Value}.{session}.{hash}";
        using var ownership = new Mutex(initiallyOwned: true, $@"Local\{address}", out var first);
        if (!first)
            return Signal(address, command);
        if (command.StartsWith("--doctor-auto-", StringComparison.Ordinal))
            return 1;
        if (command == "--quit")
            return 0;

        try
        {
            ApplicationConfiguration.Initialize();
            using var app = new DesktopApp(address, command == "--show");
            Application.Run(app);
            return 0;
        }
        catch (Exception error)
        {
            DesktopFiles.Log($"desktop failed: {error.Message}");
            return 1;
        }
        finally
        {
            ownership.ReleaseMutex();
        }
    }

    private static int Signal(string address, string command)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", address, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            pipe.Connect(2500);
            if (command == "--show" && GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint serverPid))
                AllowSetForegroundWindow(serverPid);
            pipe.WriteByte(command switch
            {
                "--quit" => (byte)'q',
                "--tray" => (byte)'t',
                "--doctor-auto-off" => (byte)'o',
                "--doctor-auto-codex" => (byte)'c',
                "--doctor-auto-claude" => (byte)'l',
                _ => (byte)'s',
            });
            return 0;
        }
        catch (Exception error) when (error is TimeoutException or IOException or UnauthorizedAccessException)
        {
            DesktopFiles.Log($"could not signal the tray: {error.Message}");
            return 1;
        }
    }

    [DllImport("kernel32.dll")]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(uint processId);
}

internal sealed class DesktopApp : ApplicationContext
{
    private readonly DesktopSettings settings = DesktopSettings.Load();
    private readonly CancellationTokenSource shutdown = new();
    private readonly PanelWindow window;
    private readonly NotifyIcon tray;
    private readonly HotkeyWindow hotkey = new();
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 5 * 60 * 1000 };
    private readonly ToolStripMenuItem startupItem;
    private readonly ContextMenuStrip menu = new();
    private Task? pipeServer;
    private bool closing;
    private bool disposed;

    internal DesktopApp(string address, bool show)
    {
        window = new PanelWindow(settings, shutdown.Token);
        // Own a handle while hidden so signal handlers can always marshal to the desktop thread.
        _ = window.Handle;
        var open = new ToolStripMenuItem("Open WSL Cross Hub", null, (_, _) => window.ShowPanel());
        var refresh = new ToolStripMenuItem("Refresh", null, async (_, _) => await window.RefreshAsync());
        var doctor = new ToolStripMenuItem("Doctor in Windows panel", null,
            async (_, _) => await window.OpenWindowsDoctorAsync());
        var chord = new ToolStripMenuItem("Set global hotkey…", null, (_, _) => EditHotkey());
        var fonts = new ToolStripMenuItem("Data font");
        foreach (string family in new[] { "Consolas", "Cascadia Mono", "Segoe UI" })
        {
            if (PanelWindow.IsFontInstalled(family))
                fonts.DropDownItems.Add(family, null, (_, _) => ChangeDataFont(family));
        }
        fonts.DropDownOpening += (_, _) =>
        {
            foreach (ToolStripMenuItem item in fonts.DropDownItems)
                item.Checked = item.Text == window.DataFontName;
        };
        startupItem = new ToolStripMenuItem("Start with Windows", null, (_, _) => ToggleStartup());
        var taskbarSettings = new ToolStripMenuItem("Taskbar settings", null, (_, _) => OpenTaskbarSettings());
        menu.Items.AddRange(new ToolStripItem[] { open, refresh, doctor, new ToolStripSeparator(), chord, fonts, startupItem, taskbarSettings });
        menu.Opening += (_, _) =>
        {
            startupItem.Checked = settings.StartupEnabled;
            startupItem.Enabled = Environment.ProcessPath?.Equals(DesktopFiles.InstallExe,
                StringComparison.OrdinalIgnoreCase) == true;
        };

        tray = new NotifyIcon
        {
            Text = "WSL Cross Hub", Icon = DesktopFiles.AppIcon,
            ContextMenuStrip = menu, Visible = true,
        };
        tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
                window.ShowPanel();
        };
        hotkey.Pressed += window.TogglePanel;
        RegisterHotkey(settings.Hotkey);
        pipeServer = ListenAsync(address, shutdown.Token);

        timer.Tick += async (_, _) => await window.RefreshAsync();
        timer.Start();
        DesktopFiles.Log("desktop started");
        if (show)
            window.ShowPanel();
        else
            _ = window.RefreshAsync();
    }

    private async Task ListenAsync(string address, CancellationToken cancel)
    {
        while (!cancel.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(address, PipeDirection.In, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(cancel).ConfigureAwait(false);
                var input = new byte[1];
                using var readDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
                readDeadline.CancelAfter(TimeSpan.FromSeconds(2));
                if (await server.ReadAsync(input, readDeadline.Token).ConfigureAwait(false) != 1)
                    continue;
                window.BeginInvoke(() =>
                {
                    if (closing)
                        return;
                    if (input[0] == 'q')
                        ExitThread();
                    else if (input[0] == 's')
                        window.ShowPanel();
                    else if (input[0] is (byte)'o' or (byte)'c' or (byte)'l')
                        window.SetAutomaticDoctor(input[0] switch { (byte)'c' => "codex", (byte)'l' => "claude", _ => "off" });
                });
            }
            catch (OperationCanceledException) when (cancel.IsCancellationRequested) { return; }
            catch (OperationCanceledException) { }
            catch (Exception error) when (error is IOException or InvalidOperationException or UnauthorizedAccessException)
            {
                DesktopFiles.Log($"tray signal failed: {error.Message}");
                if (!cancel.IsCancellationRequested)
                    await Task.Delay(200).ConfigureAwait(false);
            }
        }
    }

    private string? RegisterHotkey(string? chord)
    {
        string? error = hotkey.Register(chord);
        window.SetHotkeyNote(error);
        tray.Text = error is null ? $"WSL Cross Hub ({chord})" : "WSL Cross Hub (hotkey unavailable)";
        if (error is not null)
        {
            DesktopFiles.Log(error);
            tray.ShowBalloonTip(4000, "WSL Cross Hub", error, ToolTipIcon.Warning);
        }
        else
            DesktopFiles.Log($"hotkey registered: {chord}");
        return error;
    }

    private void EditHotkey()
    {
        using var dialog = new Form
        {
            Text = "WSL Cross Hub hotkey", Width = 370, Height = 160,
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog, MinimizeBox = false, MaximizeBox = false,
        };
        var entry = new TextBox { Text = settings.Hotkey, Left = 16, Top = 16, Width = 320, AccessibleName = "Global hotkey" };
        var save = new Button { Text = "Save", Left = 177, Top = 54, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Cancel", Left = 260, Top = 54, DialogResult = DialogResult.Cancel };
        dialog.Controls.AddRange(new Control[] { entry, save, cancel });
        dialog.AcceptButton = save;
        dialog.CancelButton = cancel;
        dialog.Shown += (_, _) => entry.SelectAll();

        if (dialog.ShowDialog() != DialogResult.OK)
            return;
        var old = settings.Hotkey;
        string? error = RegisterHotkey(entry.Text.Trim());
        if (error is not null)
        {
            RegisterHotkey(old);
            MessageBox.Show(error, "WSL Cross Hub", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        settings.Hotkey = entry.Text.Trim();
        SaveSettings();
    }

    private void ChangeDataFont(string family)
    {
        window.SetDataFont(family);
        settings.DataFont = family;
        SaveSettings();
    }

    private void OpenTaskbarSettings()
    {
        try
        {
            using var settingsWindow = Process.Start(new ProcessStartInfo("ms-settings:taskbar")
            {
                UseShellExecute = true,
            });
        }
        catch (Win32Exception error)
        {
            DesktopFiles.Log($"could not open taskbar settings: {error.Message}");
            tray.ShowBalloonTip(5000, "WSL Cross Hub", "Open Taskbar settings from the Windows taskbar.", ToolTipIcon.Warning);
        }
    }

    private void ToggleStartup()
    {
        bool enabled = !settings.StartupEnabled;
        try
        {
            settings.ApplyStartup(enabled);
            settings.StartupEnabled = enabled;
            try
            {
                settings.Save();
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                settings.StartupEnabled = !enabled;
                settings.ApplyStartup(!enabled);
                throw;
            }
            DesktopFiles.Log($"startup enabled: {enabled}");
        }
        catch (Exception error)
        {
            DesktopFiles.Log($"could not set startup: {error.Message}");
            tray.ShowBalloonTip(5000, "WSL Cross Hub", error.Message, ToolTipIcon.Warning);
        }
    }

    private void SaveSettings()
    {
        try { settings.Save(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            DesktopFiles.Log($"could not save settings: {error.Message}");
        }
    }

    protected override void ExitThreadCore()
    {
        closing = true;
        shutdown.Cancel();
        timer.Stop();
        window.AllowClose = true;
        window.Close();
        tray.Visible = false;
        DesktopFiles.Log("desktop stopped");
        base.ExitThreadCore();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            disposed = true;
            shutdown.Cancel();
            timer.Dispose();
            hotkey.Dispose();
            tray.Dispose();
            menu.Dispose();
            window.Dispose();
            if (pipeServer is null || pipeServer.IsCompleted)
                shutdown.Dispose();
        }
        base.Dispose(disposing);
    }
}
