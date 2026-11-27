using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace WslCrossHub.Desktop;

internal sealed class PanelWindow : Form
{
    private static readonly TimeSpan StaleAge = TimeSpan.FromMinutes(10);
    private static readonly Color Background = Color.FromArgb(21, 27, 35);
    private static readonly Color Surface = Color.FromArgb(30, 38, 49);
    private static readonly Color Primary = Color.FromArgb(236, 241, 248);
    private static readonly Color Secondary = Color.FromArgb(174, 192, 211);
    private static readonly Color Accent = Color.FromArgb(126, 219, 222);

    private readonly DesktopSettings settings;
    private readonly CancellationToken shutdown;
    private readonly Label disk = new() { AutoSize = true, AccessibleName = "Windows C drive free space" };
    private readonly Label metadata = new() { AutoSize = true, AccessibleName = "Inventory and worker status" };
    private readonly Label message = new() { Dock = DockStyle.Fill, AutoEllipsis = true, AccessibleName = "Cross Hub diagnostics" };
    private readonly ListBox choices = new()
    {
        Dock = DockStyle.Fill, IntegralHeight = false, AccessibleName = "Distributions and diagnostics",
        BorderStyle = BorderStyle.None, DrawMode = DrawMode.OwnerDrawFixed,
    };
    private readonly TextBox details = new()
    {
        Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, WordWrap = true, ScrollBars = ScrollBars.Vertical,
        BorderStyle = BorderStyle.None, AccessibleName = "Cross Hub details", Visible = false,
    };
    private readonly Button refresh = ActionButton("Refresh");
    private readonly Button preview = ActionButton("Preview maintenance");
    private readonly Button probe = ActionButton("Run probe");
    private Font? dataFont;
    private Font? diskFont;
    private Snapshot? snapshot;
    private bool refreshing;
    private bool refreshFailed;
    private bool workerVerified;
    private bool probing;
    private bool previewing;
    private bool positioned;
    private Job? activeProbe;
    private string? operationNote;
    private string? hotkeyNote;

    internal bool AllowClose;
    internal Action? TogglePin;

    internal void SetHotkeyNote(string? note)
    {
        hotkeyNote = note;
        RenderMessage();
    }

    internal PanelWindow(DesktopSettings settings, CancellationToken shutdown)
    {
        this.settings = settings;
        this.shutdown = shutdown;
        Text = "WSL Cross Hub";
        Icon = SystemIcons.Application;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(630, 395);
        MinimumSize = new Size(485, 335);
        AutoScaleMode = AutoScaleMode.Dpi;
        TopMost = settings.KeepOnTop;
        BackColor = Background;
        ForeColor = Primary;
        Font = new Font("Segoe UI", 10);
        KeyPreview = true;
        MaximizeBox = false;

        disk.ForeColor = Accent;
        metadata.ForeColor = Secondary;
        metadata.Padding = new Padding(0, 1, 0, 11);
        message.ForeColor = Secondary;
        message.TextAlign = ContentAlignment.MiddleLeft;

        choices.BackColor = Surface;
        choices.ForeColor = Primary;
        choices.ItemHeight = 30;
        choices.DrawItem += DrawChoice;
        choices.SelectedIndexChanged += (_, _) => UpdateControls();
        choices.DoubleClick += async (_, _) => await OpenSelectedAsync();
        details.BackColor = Surface;
        details.ForeColor = Primary;
        details.Margin = new Padding(8);
        SetDataFont(settings.DataFont);

        var viewport = new Panel { Dock = DockStyle.Fill, BackColor = Surface, Padding = new Padding(9) };
        viewport.Controls.Add(choices);
        viewport.Controls.Add(details);
        var footer = new FlowLayoutPanel
        {
            AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false, Margin = new Padding(0, 8, 0, 0),
        };
        var pin = ActionButton("Pin");
        pin.AccessibleName = "Keep on top";
        pin.Click += (_, _) => TogglePin?.Invoke();
        footer.Controls.AddRange(new Control[] { refresh, preview, probe, pin });
        refresh.Click += async (_, _) => await RefreshAsync();
        preview.Click += async (_, _) => await PreviewAsync();
        probe.Click += async (_, _) => await ProbeAsync();

        var layout = new TableLayoutPanel { ColumnCount = 1, RowCount = 5, Dock = DockStyle.Fill, Padding = new Padding(14, 12, 14, 11) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        layout.Controls.Add(disk, 0, 0);
        layout.Controls.Add(metadata, 0, 1);
        layout.Controls.Add(viewport, 0, 2);
        layout.Controls.Add(footer, 0, 3);
        layout.Controls.Add(message, 0, 4);
        Controls.Add(layout);
        Render();
    }

    internal string DataFontName => details.Font.Name;

    internal static bool IsFontInstalled(string family)
    {
        using var font = new Font(family, 10.5F);
        return font.Name.Equals(family, StringComparison.OrdinalIgnoreCase);
    }

    internal void SetDataFont(string? family)
    {
        if (string.IsNullOrWhiteSpace(family) || !IsFontInstalled(family))
            family = Font.Name;

        var previousDataFont = dataFont;
        var previousDiskFont = diskFont;
        dataFont = new Font(family, 10.5F);
        diskFont = new Font(family, 20, FontStyle.Bold);
        details.Font = dataFont;
        disk.Font = diskFont;
        choices.Invalidate();
        previousDataFont?.Dispose();
        previousDiskFont?.Dispose();
    }

    private static Button ActionButton(string text) => new()
    {
        Text = text, AutoSize = true, FlatStyle = FlatStyle.Flat, ForeColor = Primary, BackColor = Surface,
        Margin = new Padding(0, 0, 8, 0), Padding = new Padding(7, 2, 7, 2),
        AccessibleName = text, UseVisualStyleBackColor = false,
    };

    private void DrawChoice(object? sender, DrawItemEventArgs e)
    {
        if (e.Index < 0)
            return;
        bool selected = (e.State & DrawItemState.Selected) != 0;
        using var background = new SolidBrush(selected ? Color.FromArgb(47, 69, 85) : choices.BackColor);
        e.Graphics.FillRectangle(background, e.Bounds);
        var bounds = Rectangle.Inflate(e.Bounds, -8, 0);
        var choice = (Choice)choices.Items[e.Index];
        var font = choice.Distro is not null || choice.Guest is not null || choice.Key == "probe"
            ? dataFont : e.Font;
        TextRenderer.DrawText(e.Graphics, choice.Label, font, bounds,
            selected ? Accent : Primary, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        if (selected)
            e.DrawFocusRectangle();
    }

    internal void TogglePanel()
    {
        if (Visible && WindowState != FormWindowState.Minimized)
            HidePanel();
        else
            ShowPanel();
    }

    internal void ShowPanel()
    {
        if (WindowState == FormWindowState.Minimized)
            WindowState = FormWindowState.Normal;
        if (!positioned)
        {
            var initialScreen = Screen.FromPoint(Cursor.Position).WorkingArea;
            var initialLocation = settings.Left is int left && settings.Top is int top
                ? new Point(left, top)
                : new Point(initialScreen.Right - Width - 28, initialScreen.Bottom - Height - 28);
            Location = Fit(initialLocation);
            positioned = true;
        }
        else
            Location = Fit(Location);

        Show();
        BringToFront();
        Activate();
        if (!details.Visible)
            choices.Focus();
        _ = RefreshAsync();
    }

    private void HidePanel()
    {
        SavePosition();
        Hide();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!AllowClose && e.CloseReason is CloseReason.UserClosing)
        {
            e.Cancel = true;
            HidePanel();
        }
        else
            SavePosition();
        base.OnFormClosing(e);
    }

    protected override void OnResizeEnd(EventArgs e)
    {
        base.OnResizeEnd(e);
        SavePosition();
    }

    private void SavePosition()
    {
        if (!positioned || WindowState != FormWindowState.Normal)
            return;
        settings.Left = Left;
        settings.Top = Top;
        try { settings.Save(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            DesktopFiles.Log($"could not save window position: {error.Message}");
        }
    }

    private Point Fit(Point target)
    {
        var area = Screen.FromRectangle(new Rectangle(target, Size)).WorkingArea;
        return ClampPosition(target, Size, area);
    }

    internal static Point ClampPosition(Point target, Size size, Rectangle area) => new(
        Math.Clamp(target.X, area.Left, Math.Max(area.Left, area.Right - size.Width)),
        Math.Clamp(target.Y, area.Top, Math.Max(area.Top, area.Bottom - size.Height)));

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Escape)
        {
            HidePanel();
            return true;
        }
        if (keyData == Keys.F5)
        {
            _ = RefreshAsync();
            return true;
        }

        var nudge = keyData switch
        {
            Keys.Shift | Keys.H => new Point(-24, 0),
            Keys.Shift | Keys.J => new Point(0, 24),
            Keys.Shift | Keys.K => new Point(0, -24),
            Keys.Shift | Keys.L => new Point(24, 0),
            _ => Point.Empty,
        };
        if (nudge != Point.Empty)
        {
            Location = Fit(new Point(Left + nudge.X, Top + nudge.Y));
            SavePosition();
            return true;
        }

        if (keyData is Keys.J or Keys.K)
        {
            if (details.Visible)
                ScrollDetails(keyData == Keys.J ? 1 : -1);
            else if (choices.Items.Count > 0)
                choices.SelectedIndex = Math.Clamp(choices.SelectedIndex + (keyData == Keys.J ? 1 : -1), 0, choices.Items.Count - 1);
            return true;
        }
        if (keyData == Keys.H && details.Visible)
        {
            details.Hide();
            choices.Show();
            choices.Focus();
            return true;
        }
        if ((keyData == Keys.L || (keyData == Keys.Enter && choices.Focused)) && !details.Visible)
        {
            _ = OpenSelectedAsync();
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    private void ScrollDetails(int direction)
    {
        var line = details.GetLineFromCharIndex(details.SelectionStart);
        int next = Math.Clamp(line + direction, 0, Math.Max(0, details.Lines.Length - 1));
        int index = details.GetFirstCharIndexFromLine(next);
        if (index >= 0)
        {
            details.Select(index, 0);
            details.ScrollToCaret();
        }
    }

    internal async Task RefreshAsync()
    {
        if (refreshing || shutdown.IsCancellationRequested)
            return;
        refreshing = true;
        UpdateControls();
        try
        {
            Snapshot current = await StatusClient.RunAsync<Snapshot>("collect", shutdown);
            ApplySnapshot(current);
            refreshFailed = false;
            operationNote = null;
            Render();
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            operationNote = $"Refresh failed. {error.Message}";
            DesktopFiles.Log(operationNote);
            refreshFailed = true;
            workerVerified = false;
            Render();
            if (snapshot is null)
            {
                try
                {
                    ApplySnapshot(await StatusClient.RunAsync<Snapshot>("latest", shutdown));
                }
                catch (Exception fallback) when (fallback is not OperationCanceledException)
                {
                    DesktopFiles.Log($"cached status unavailable: {fallback.Message}");
                }
                catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
            }
            Render();
        }
        finally
        {
            refreshing = false;
            if (!shutdown.IsCancellationRequested)
                UpdateControls();
        }
    }

    private void ApplySnapshot(Snapshot current)
    {
        if (current.SchemaVersion != 1)
            throw new InvalidOperationException("The status helper returned an unsupported snapshot version.");
        snapshot = current;
        workerVerified = true;
        if (!probing)
            activeProbe = current.LatestProbe;
    }

    private async Task PreviewAsync()
    {
        if (choices.SelectedItem is not Choice { Distro: { } distro } || previewing || shutdown.IsCancellationRequested)
            return;
        previewing = true;
        operationNote = $"Checking {distro.Name}…";
        UpdateControls();
        RenderMessage();
        try
        {
            Preview plan = await StatusClient.RunAsync<Preview>("preview", shutdown, "-Distro", distro.Name);
            var result = new StringBuilder();
            result.AppendLine($"{plan.Distro}  ·  {plan.Decision}");
            result.AppendLine();
            foreach (var blocker in plan.Blockers)
                result.AppendLine(blocker.Message);
            foreach (var step in plan.Steps)
                result.AppendLine(step.Replace('-', ' '));
            ShowDetails(result.ToString());
            operationNote = "Preview only";
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            operationNote = $"Preview failed. {error.Message}";
            DesktopFiles.Log(operationNote);
        }
        finally
        {
            previewing = false;
            if (!shutdown.IsCancellationRequested)
            {
                RenderMessage();
                UpdateControls();
            }
        }
    }

    private async Task ProbeAsync()
    {
        if (!CanProbe() || shutdown.IsCancellationRequested)
            return;
        probing = true;
        operationNote = "Submitting probe…";
        RenderMessage();
        UpdateControls();
        try
        {
            activeProbe = await StatusClient.RunAsync<Job>("probe", shutdown);
            DesktopFiles.Log($"probe acknowledged: {activeProbe.Id}");
            Render();
            var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(20);
            while (activeProbe.IsPending && DateTimeOffset.UtcNow < deadline)
            {
                await Task.Delay(350, shutdown);
                activeProbe = await StatusClient.RunAsync<Job>("job", shutdown, "-JobId", activeProbe.Id);
                operationNote = null;
                Render();
            }
            if (activeProbe.IsPending)
                operationNote = "The probe is still pending. Refresh to check its status.";
            else
                DesktopFiles.Log($"probe {activeProbe.State}: {activeProbe.Id}");
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            operationNote = $"Probe status unavailable. {error.Message}";
            DesktopFiles.Log(operationNote);
            try
            {
                Snapshot latest = await StatusClient.RunAsync<Snapshot>("latest", shutdown);
                activeProbe = latest.LatestProbe;
            }
            catch (Exception fallback) when (fallback is not OperationCanceledException)
            {
                DesktopFiles.Log($"could not check last probe: {fallback.Message}");
            }
            catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        }
        finally
        {
            probing = false;
            if (!shutdown.IsCancellationRequested)
                Render();
        }
    }

    private bool CanProbe() => ProbeAvailable(snapshot, workerVerified) && !probing && activeProbe?.IsPending != true;

    internal static bool ProbeAvailable(Snapshot? current, bool verified) =>
        verified && current?.Worker?.State == "ready";

    internal static bool InventoryStale(Snapshot? current, bool failed, DateTimeOffset now) =>
        failed || current?.InventoryStale == true ||
        (current?.ObservedAt is { } timestamp && now - timestamp > StaleAge);

    private void UpdateControls()
    {
        refresh.Enabled = !refreshing;
        preview.Enabled = !previewing && choices.SelectedItem is Choice { Distro: not null };
        probe.Enabled = CanProbe();
    }

    private void Render()
    {
        var inventory = snapshot?.Inventory;
        var previous = snapshot?.PreviousInventory;
        var timestamp = snapshot?.ObservedAt;
        disk.Text = inventory?.CFreeBytes is long bytes
            ? $"C:  {FormatBytes(bytes)} free" + Delta(bytes, previous?.CFreeBytes)
            : "C:  Free space unavailable";
        bool stale = InventoryStale(snapshot, refreshFailed, DateTimeOffset.UtcNow);
        var when = timestamp is { } observed ? $"Updated {observed.ToLocalTime():h:mm tt}" : "Waiting for first sample";
        var docker = inventory?.DockerDesktopRunning switch { true => "running", false => "stopped", null => "unknown" };
        var worker = workerVerified ? snapshot?.Worker?.State ?? "unknown" : "unverified";
        metadata.Text = $"{when}{(stale ? " (stale)" : "")}  ·  Docker {docker}  ·  Worker {worker}";

        var previousSelection = (choices.SelectedItem as Choice)?.Key;
        choices.BeginUpdate();
        try
        {
            choices.Items.Clear();
            foreach (Distro distro in inventory?.Distributions ?? Array.Empty<Distro>())
            {
                var running = inventory?.RunningDistros;
                var status = running is null ? "unknown" :
                    running.Contains(distro.Name, StringComparer.OrdinalIgnoreCase) ? "running" : "stopped";
                Distro? last = previous?.Distributions?.FirstOrDefault(item => string.Equals(item.Name, distro.Name, StringComparison.OrdinalIgnoreCase));
                var size = distro.VhdLengthBytes is long length
                    ? FormatBytes(length) + Delta(length, last?.VhdLengthBytes)
                    : "VHDX size unavailable";
                choices.Items.Add(new Choice("distro:" + distro.Name, $"{distro.Name}   ·   {status}   ·   {size}", distro));
            }
            foreach (GuestReport guest in snapshot?.GuestReports ?? Array.Empty<GuestReport>())
            {
                string space = guest.Report is { } report
                    ? $"{FormatBytes(report.Filesystem.AvailableBytes)} free   ·   " : "";
                choices.Items.Add(new Choice("guest:" + guest.Distro,
                    $"Linux storage · {guest.Distro}   ·   {space}{guest.State}", Guest: guest));
            }

            var job = activeProbe ?? snapshot?.LatestProbe;
            if (job is not null)
                choices.Items.Add(new Choice("probe", $"Latest probe   ·   {job.State}   ·   {Elapsed(job)}"));
            choices.Items.Add(new Choice("history", "Recent measurements"));
            choices.Items.Add(new Choice("diagnostics", "Diagnostics and logs"));
            int matching = Enumerable.Range(0, choices.Items.Count)
                .FirstOrDefault(index => ((Choice)choices.Items[index]!).Key == previousSelection, -1);
            choices.SelectedIndex = matching >= 0 ? matching : 0;
        }
        finally { choices.EndUpdate(); }
        RenderMessage();
        UpdateControls();
    }

    private void RenderMessage()
    {
        message.Text = operationNote ?? hotkeyNote
            ?? (snapshot is not null && snapshot.Worker?.State != "ready"
                ? "Probe unavailable until the Windows worker reports a fresh heartbeat."
                : "j/k Move   l Open   h Back   Esc Hide");
    }

    private async Task OpenSelectedAsync()
    {
        if (choices.SelectedItem is not Choice item)
            return;
        if (item.Distro is not null)
        {
            await PreviewAsync();
            return;
        }
        if (item.Guest is not null)
        {
            ShowDetails(GuestDetails(item.Guest));
            return;
        }
        if (item.Key == "probe" && (activeProbe ?? snapshot?.LatestProbe) is { } job)
        {
            string result = job.Result is { ValueKind: not JsonValueKind.Null } data
                ? JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true }) : "";
            ShowDetails($"Probe {job.Id}{Environment.NewLine}{job.State}  ·  {Elapsed(job)}{Environment.NewLine}{Environment.NewLine}{result}");
            return;
        }

        if (item.Key == "history")
        {
            var measurements = snapshot?.History ?? Array.Empty<Measurement>();
            if (measurements.Length == 0)
            {
                ShowDetails("No disk measurements have been stored yet.");
                return;
            }

            var history = new StringBuilder("Last 24 hours");
            foreach (Measurement sample in measurements.OrderByDescending(sample => sample.ObservedAt))
            {
                var free = sample.CFreeBytes is long bytes ? FormatBytes(bytes) : "Unavailable";
                history.AppendLine().Append(sample.ObservedAt.ToLocalTime().ToString("MMM d, h:mm tt"))
                    .Append("   ·   C: ").Append(free).Append(" free");
                foreach (Distro distro in sample.Distributions ?? Array.Empty<Distro>())
                {
                    var size = distro.VhdLengthBytes is long length ? FormatBytes(length) : "Unavailable";
                    history.AppendLine().Append("    ").Append(distro.Name).Append("   ·   ").Append(size);
                }
                history.AppendLine();
            }
            ShowDetails(history.ToString());
            return;
        }

        var text = new StringBuilder();
        if (snapshot?.Worker?.HeartbeatAt is { } heartbeat)
            text.AppendLine($"Worker heartbeat: {heartbeat.ToLocalTime():MMM d, h:mm:ss tt}");
        if (hotkeyNote is not null)
            text.AppendLine(hotkeyNote);
        foreach (Diagnostic diagnostic in (snapshot?.Errors ?? Array.Empty<Diagnostic>())
            .Concat(snapshot?.Inventory?.Errors ?? Array.Empty<Diagnostic>()).Distinct())
            text.AppendLine($"{diagnostic.Source}: {diagnostic.Message}");
        string info = await Task.Run(() =>
            $"Desktop log{Environment.NewLine}{DesktopFiles.Tail(DesktopFiles.DesktopLog)}{Environment.NewLine}{Environment.NewLine}" +
            $"Worker log{Environment.NewLine}{DesktopFiles.Tail(DesktopFiles.WorkerLog)}");
        if (!shutdown.IsCancellationRequested)
            ShowDetails(text.AppendLine(info).ToString());
    }

    internal static string GuestDetails(GuestReport guest)
    {
        var text = new StringBuilder($"Linux storage · {guest.Distro} · {guest.State}");
        text.AppendLine();
        if (guest.Diagnostic is not null)
            text.AppendLine(guest.Diagnostic);
        if (guest.Report is not { } report)
            return text.ToString();

        text.AppendLine($"Measured inside WSL: {report.ObservedAt.ToLocalTime():MMM d, h:mm tt}");
        var filesystem = report.Filesystem;
        text.AppendLine($"Linux /: {FormatBytes(filesystem.AvailableBytes)} available · " +
            $"{FormatBytes(filesystem.UsedBytes)} used · {FormatBytes(filesystem.TotalBytes)} total");
        text.AppendLine();
        if (report.Trim is { } trim)
        {
            text.AppendLine($"Last recorded TRIM: {FormatBytes(trim.Bytes)} sent for discard");
            text.AppendLine($"{trim.Method} · {trim.ObservedAt.ToLocalTime():MMM d, h:mm tt}");
            text.AppendLine("Discard bytes do not measure Windows host-space recovery.");
        }
        else
            text.AppendLine("No TRIM result recorded.");

        text.AppendLine();
        if (report.Candidates.Length == 0)
            text.AppendLine("No cleanup candidates were measured.");
        else
        {
            text.AppendLine("Cleanup candidates · allocated size");
            text.AppendLine("Review paths and active builds before cleanup.");
            foreach (var candidate in report.Candidates)
            {
                text.AppendLine($"{FormatBytes(candidate.AllocatedBytes)} · {candidate.Kind} · {candidate.Path}");
                text.AppendLine($"  {candidate.Note}");
            }
        }
        foreach (var error in report.Errors)
            text.AppendLine($"{error.Source}: {error.Message}");
        return text.ToString();
    }

    private void ShowDetails(string text)
    {
        details.Text = text;
        details.SelectionStart = 0;
        choices.Hide();
        details.Show();
        details.Focus();
    }

    internal static string FormatBytes(long size) => $"{size / (1024D * 1024 * 1024):N1} GiB";

    internal static string Delta(long size, long? previous)
    {
        if (previous is not long earlier || earlier == size)
            return "";
        double change = ((double)size - earlier) / (1024D * 1024 * 1024);
        return " (" + change.ToString("+0.00;-0.00;0.00", CultureInfo.CurrentCulture) + " GiB)";
    }

    private static string Elapsed(Job job)
    {
        var start = job.AcceptedAt ?? job.SubmittedAt;
        var duration = start is null ? TimeSpan.Zero : (job.FinishedAt ?? DateTimeOffset.UtcNow) - start.Value;
        return $"{Math.Max(0, duration.TotalSeconds):0.0}s";
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
        {
            dataFont?.Dispose();
            diskFont?.Dispose();
            dataFont = null;
            diskFont = null;
        }
    }

    private sealed record Choice(
        string Key, string Label, Distro? Distro = null, GuestReport? Guest = null)
    {
        public override string ToString() => Label;
    }
}

internal static class DesktopSelfTest
{
    internal static int Run()
    {
        if (!HotkeyWindow.Parse("Ctrl+Alt+F3", out uint modifiers, out uint key) || modifiers != 3 || key != 0x72)
            return 1;
        if (HotkeyWindow.Parse("Ctrl+Ctrl+F3", out _, out _) || HotkeyWindow.Parse("Ctrl+F12", out _, out _))
            return 2;
        if (PanelWindow.ClampPosition(new Point(-400, 900), new Size(300, 200),
            new Rectangle(-320, 0, 900, 650)) != new Point(-320, 450))
            return 3;
        var fixture = JsonSerializer.Deserialize<Snapshot>(
            """{"schemaVersion":1,"observedAt":null,"inventory":{"cFreeBytes":1073741824,"dockerDesktopRunning":false,"runningDistros":[],"distributions":[{"name":"Ubuntu","vhdLengthBytes":42}],"errors":[]},"worker":{"state":"offline","heartbeat_at":"2026-11-21T14:30:00+00:00"},"latestProbe":{"job_id":"123","state":"queued","accepted_at":null,"finished_at":null},"inventoryStale":true}""",
            DesktopSettings.JsonOptions);
        if (fixture?.Inventory?.Distributions?[0].Name != "Ubuntu" || fixture.Worker?.State != "offline"
            || fixture.Worker?.HeartbeatAt != new DateTimeOffset(2026, 11, 21, 14, 30, 0, TimeSpan.Zero)
            || fixture.LatestProbe is not { Id: "123", IsPending: true } || !fixture.InventoryStale)
            return 4;
        var ready = fixture with { Worker = fixture.Worker! with { State = "ready" }, InventoryStale = false };
        if (!PanelWindow.ProbeAvailable(ready, true) || PanelWindow.ProbeAvailable(ready, false)
            || !PanelWindow.InventoryStale(ready, true, DateTimeOffset.UtcNow))
            return 5;
        var oldSettings = JsonSerializer.Deserialize<DesktopSettings>(
            """{"startupEnabled":true}""", DesktopSettings.JsonOptions)!;
        using var panel = new PanelWindow(oldSettings, CancellationToken.None);
        if (PanelWindow.IsFontInstalled("Consolas") && panel.DataFontName != "Consolas")
            return 6;
        panel.SetDataFont("Missing WSL Cross Hub font");
        if (panel.DataFontName != panel.Font.Name)
            return 7;
        if (PanelWindow.IsFontInstalled("Cascadia Mono"))
        {
            panel.SetDataFont("Cascadia Mono");
            if (panel.DataFontName != "Cascadia Mono")
                return 8;
        }
        var guest = JsonSerializer.Deserialize<GuestReport>(
            """
            {"distro":"Ubuntu","state":"stale","diagnostic":"Old measurement", "report": {
              "observedAt":"2026-11-20T14:30:00+00:00",
              "filesystem":{"totalBytes":4294967296,"usedBytes":1073741824,"availableBytes":3221225472},
              "trim":{"observedAt":"2026-11-20T14:30:00+00:00","bytes":5368709120,"method":"fstrim"},
              "candidates":[{"kind":"rust-target","path":"/home/test/target","allocatedBytes":1073741824,
                             "note":"Review before cleanup"}], "errors":[]}}
            """, DesktopSettings.JsonOptions)!;
        var details = PanelWindow.GuestDetails(guest);
        if (!details.Contains("Linux /") || !details.Contains("sent for discard")
            || !details.Contains("/home/test/target") || !details.Contains("Old measurement"))
            return 9;
        return 0;
    }
}
