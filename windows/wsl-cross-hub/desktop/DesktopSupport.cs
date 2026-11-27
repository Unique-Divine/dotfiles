using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WslCrossHub.Desktop;

internal sealed record Diagnostic(string Source, string Message);
internal sealed record Distro(string Name, long? VhdLengthBytes, bool? VhdExists, bool? VhdSparse);
internal sealed record Inventory(
    long? CFreeBytes, bool? DockerDesktopRunning, string[]? RunningDistros,
    Distro[]? Distributions, Diagnostic[]? Errors);
internal sealed record Worker(string State, [property: JsonPropertyName("heartbeat_at")] DateTimeOffset? HeartbeatAt, int? Pid);
internal sealed record Job(
    [property: JsonPropertyName("job_id")] string Id,
    string State,
    [property: JsonPropertyName("submitted_at")] DateTimeOffset? SubmittedAt,
    [property: JsonPropertyName("accepted_at")] DateTimeOffset? AcceptedAt,
    [property: JsonPropertyName("finished_at")] DateTimeOffset? FinishedAt,
    JsonElement? Result)
{
    internal bool IsPending => State is "queued" or "accepted" or "running";
}

internal sealed record Measurement(DateTimeOffset ObservedAt, long? CFreeBytes, Distro[]? Distributions);
internal sealed record GuestFilesystem(long TotalBytes, long UsedBytes, long AvailableBytes);
internal sealed record GuestTrim(DateTimeOffset ObservedAt, long Bytes, string Method);
internal sealed record GuestCandidate(string Kind, string Path, long AllocatedBytes, string Note);
internal sealed record GuestMeasurement(
    DateTimeOffset ObservedAt, GuestFilesystem Filesystem,
    GuestTrim? Trim, GuestCandidate[] Candidates, Diagnostic[] Errors);
internal sealed record GuestReport(string Distro, string State, GuestMeasurement? Report, string? Diagnostic);
internal sealed record Snapshot(
    int SchemaVersion, DateTimeOffset? ObservedAt, Inventory? Inventory,
    Worker? Worker, Inventory? PreviousInventory, Job? LatestProbe, Diagnostic[]? Errors,
    bool InventoryStale, Measurement[]? History, GuestReport[]? GuestReports);
internal sealed record Blocker(string Code, string Message);
internal sealed record Preview(string Distro, string Decision, Blocker[] Blockers, string[] Steps);

internal static class DesktopFiles
{
    internal static readonly string Root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WslCrossHub");
    internal static readonly string InstallExe = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs", "WslCrossHub", "wsl-cross-hub-desktop.exe");
    internal static readonly string LogFolder = Path.Combine(Root, "logs");
    internal static readonly string DesktopLog = Path.Combine(LogFolder, "desktop.log");
    internal static readonly string WorkerLog = Path.Combine(LogFolder, "worker.log");
    internal static readonly string SettingsPath = Path.Combine(Root, "desktop-settings.json");
    private static readonly object LogLock = new();
    private const long LogLimit = 1024 * 1024;

    internal static void Log(string message)
    {
        try
        {
            lock (LogLock)
            {
                Directory.CreateDirectory(LogFolder);
                if (File.Exists(DesktopLog) && new FileInfo(DesktopLog).Length >= LogLimit)
                {
                    for (var index = 3; index >= 2; index--)
                    {
                        var previous = $"{DesktopLog}.{index - 1}";
                        if (File.Exists(previous))
                            File.Move(previous, $"{DesktopLog}.{index}", overwrite: true);
                    }
                    File.Move(DesktopLog, DesktopLog + ".1", overwrite: true);
                }

                File.AppendAllText(DesktopLog, $"{DateTimeOffset.UtcNow:O} {message.ReplaceLineEndings(" ")}\n");
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Debug.WriteLine(error.Message);
        }
    }

    internal static string Tail(string path)
    {
        try
        {
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            file.Seek(Math.Max(0, file.Length - 32 * 1024), SeekOrigin.Begin);
            using var reader = new StreamReader(file);
            if (file.Position > 0)
                reader.ReadLine();
            return string.Join(Environment.NewLine, reader.ReadToEnd().Split('\n').TakeLast(30));
        }
        catch (FileNotFoundException) { return "No log has been written yet."; }
        catch (DirectoryNotFoundException) { return "No log has been written yet."; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return $"Log unavailable: {error.Message}";
        }
    }
}

internal sealed class DesktopSettings
{
    internal const string DefaultHotkey = "Ctrl+Alt+F3";
    internal static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public bool StartupEnabled { get; set; } = true;
    public string Hotkey { get; set; } = DefaultHotkey;
    public string DataFont { get; set; } = "Consolas";
    public bool KeepOnTop { get; set; }
    public int? Left { get; set; }
    public int? Top { get; set; }

    internal static DesktopSettings Load()
    {
        try
        {
            return File.Exists(DesktopFiles.SettingsPath)
                ? JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(DesktopFiles.SettingsPath), JsonOptions)
                    ?? new DesktopSettings()
                : new DesktopSettings();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            DesktopFiles.Log($"settings unavailable: {error.Message}");
            return new DesktopSettings();
        }
    }

    internal void Save()
    {
        Directory.CreateDirectory(DesktopFiles.Root);
        var temporary = DesktopFiles.SettingsPath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this, JsonOptions));
        File.Move(temporary, DesktopFiles.SettingsPath, overwrite: true);
    }

    internal void ApplyStartup(bool enabled)
    {
        var exe = Environment.ProcessPath!;
        if (!Path.GetFullPath(exe).Equals(DesktopFiles.InstallExe, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Install WSL Cross Hub to change its Startup shortcut.");

        var link = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "WSL Cross Hub.lnk");
        var shellClass = Type.GetTypeFromProgID("WScript.Shell", throwOnError: true)!;
        dynamic shell = Activator.CreateInstance(shellClass)!;
        dynamic shortcut = shell.CreateShortcut(link);
        try
        {
            string target = shortcut.TargetPath;
            if (File.Exists(link) && (string.IsNullOrWhiteSpace(target)
                || !Path.GetFullPath(target).Equals(exe, StringComparison.OrdinalIgnoreCase)
                || (string)shortcut.Arguments != "--tray"))
                throw new InvalidOperationException("A different program owns the WSL Cross Hub Startup shortcut.");

            if (enabled)
            {
                shortcut.TargetPath = exe;
                shortcut.Arguments = "--tray";
                shortcut.WorkingDirectory = Path.GetDirectoryName(exe)!;
                shortcut.Description = "Start WSL Cross Hub";
                shortcut.Save();
            }
            else if (File.Exists(link))
                File.Delete(link);
        }
        finally
        {
            Marshal.FinalReleaseComObject(shortcut);
            Marshal.FinalReleaseComObject(shell);
        }
    }
}

internal static class StatusClient
{
    internal static async Task<T> RunAsync<T>(string operation, CancellationToken cancellation,
        string? option = null, string? value = null)
    {
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var start = new ProcessStartInfo(Path.Combine(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", Path.Combine(AppContext.BaseDirectory, "status.ps1"), "-Operation", operation })
            start.ArgumentList.Add(argument);
        if (option is not null && value is not null)
        {
            start.ArgumentList.Add(option);
            start.ArgumentList.Add(value);
        }

        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start status helper.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(35));
        var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            string output = await stdout.ConfigureAwait(false);
            string errors = await stderr.ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                string message = errors.Trim();
                if (message.Length > 800)
                    message = message[..800];
                throw new InvalidOperationException(message.Length == 0
                    ? $"Status helper exited {process.ExitCode}."
                    : message);
            }
            return JsonSerializer.Deserialize<T>(output, DesktopSettings.JsonOptions)
                ?? throw new InvalidOperationException("The status helper returned no data.");
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) { }
            }
            cancellation.ThrowIfCancellationRequested();
            throw new TimeoutException("The Windows status helper timed out.");
        }
    }
}

internal sealed class HotkeyWindow : NativeWindow, IDisposable
{
    private const uint NoRepeat = 0x4000;
    private const int HotkeyMessage = 0x0312;
    private const int Id = 1;
    private bool registered;

    internal HotkeyWindow() => CreateHandle(new CreateParams());
    internal event Action? Pressed;

    internal static bool Parse(string? chord, out uint modifiers, out uint key)
    {
        modifiers = key = 0;
        if (string.IsNullOrWhiteSpace(chord) || chord.Length > 45)
            return false;

        string[] parts = chord.Split('+', StringSplitOptions.TrimEntries);
        foreach (string part in parts[..^1])
        {
            uint flag = part.ToLowerInvariant() switch
            {
                "alt" => 1,
                "ctrl" or "control" => 2,
                "shift" => 4,
                "win" => 8,
                _ => 0,
            };
            if (flag == 0 || (modifiers & flag) != 0)
                return false;
            modifiers |= flag;
        }

        string last = parts[^1].ToUpperInvariant();
        if (last.Length == 1 && (last[0] is >= 'A' and <= 'Z' or >= '0' and <= '9'))
            key = last[0];
        else if (last.StartsWith('F') && int.TryParse(last.AsSpan(1), NumberStyles.None,
            CultureInfo.InvariantCulture, out var function) && function is >= 1 and <= 24 and not 12)
            key = (uint)(0x6F + function);
        return modifiers != 0 && key != 0;
    }

    internal string? Register(string? chord)
    {
        if (!Parse(chord, out uint modifiers, out uint key))
            return "Use modifiers and a letter, number, or function key, such as Ctrl+Alt+F3.";
        if (registered)
            UnregisterHotKey(Handle, Id);
        registered = RegisterHotKey(Handle, Id, modifiers | NoRepeat, key);
        return registered ? null : $"Windows could not register {chord} (error {Marshal.GetLastWin32Error()}).";
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == HotkeyMessage && message.WParam == Id)
            Pressed?.Invoke();
        base.WndProc(ref message);
    }

    public void Dispose()
    {
        if (registered)
            UnregisterHotKey(Handle, Id);
        DestroyHandle();
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint key);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(nint window, int id);
}
