using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
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
    private readonly Label maintenance = new() { AutoSize = true, AccessibleName = "Compaction job status", Visible = false };
    private readonly ProgressBar maintenanceProgress = new()
    {
        Dock = DockStyle.Fill, Height = 8, AccessibleName = "Compaction progress", Visible = false,
    };
    private readonly System.Windows.Forms.Timer maintenanceTimer = new() { Interval = 5000 };
    private readonly Label message = new() { Dock = DockStyle.Fill, AutoEllipsis = true, AccessibleName = "Cross Hub diagnostics" };
    private readonly ListBox choices = new()
    {
        Dock = DockStyle.Fill, IntegralHeight = false, AccessibleName = "Distributions and diagnostics",
        BorderStyle = BorderStyle.None, DrawMode = DrawMode.OwnerDrawFixed,
    };
    private readonly ListBox measurements = new()
    {
        Dock = DockStyle.Fill, IntegralHeight = false, AccessibleName = "Recent measurements",
        BorderStyle = BorderStyle.None, DrawMode = DrawMode.OwnerDrawFixed, Visible = false,
    };
    private readonly Panel columns = new() { Dock = DockStyle.Top, Height = 28, AccessibleName = "Distribution, state, VHDX size" };
    private readonly TextBox details = new()
    {
        Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, WordWrap = true, ScrollBars = ScrollBars.Vertical,
        BorderStyle = BorderStyle.None, AccessibleName = "Cross Hub details", Visible = false,
    };
    private readonly Button cancel = ActionButton("Cancel");
    private readonly Button start = ActionButton("Start compaction");
    private readonly Button testWorker = ActionButton("Test Windows worker");
    private readonly Button help = ActionButton("?");
    private readonly FlowLayoutPanel diagnosticsActions = new()
    {
        AutoSize = true, Dock = DockStyle.Bottom, Padding = new Padding(0, 8, 0, 0), Visible = false,
    };
    private readonly FlowLayoutPanel confirmation = new()
    {
        AutoSize = true, Dock = DockStyle.Bottom, Padding = new Padding(0, 8, 0, 0), Visible = false,
    };
    private Font? dataFont;
    private Font? diskFont;
    private Snapshot? snapshot;
    private bool refreshing;
    private bool maintenanceRefreshing;
    private bool maintenanceDetails;
    private bool measurementDetails;
    private MaintenanceJob? latestMaintenance;
    private bool refreshFailed;
    private bool workerVerified;
    private bool probing;
    private bool diagnosticsDetails;
    private bool previewing;
    private bool submitting;
    private int lastChoice = -1;
    private string? confirmedDistro;
    private int navigationVersion;
    private bool positioned;
    private Job? activeProbe;
    private string? operationNote;
    private string? hotkeyNote;

    internal bool AllowClose;

    internal void SetHotkeyNote(string? note)
    {
        hotkeyNote = note;
        RenderMessage();
    }

    internal PanelWindow(DesktopSettings settings, CancellationToken shutdown)
    {
        this.settings = settings;
        this.shutdown = shutdown;
        var version = typeof(PanelWindow).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "local";
        Text = $"WSL Cross Hub · {version}";
        Icon = DesktopFiles.AppIcon;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(760, 610);
        MinimumSize = new Size(400, 300);
        AutoScaleMode = AutoScaleMode.Dpi;
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
        choices.ItemHeight = 27;
        choices.DrawItem += DrawChoice;
        choices.SelectedIndexChanged += (_, _) =>
        {
            if (choices.SelectedItem is not Choice choice)
                return;
            if (choice.IsHeading)
            {
                choices.SelectedIndex = lastChoice;
                return;
            }
            lastChoice = choices.SelectedIndex;
        };
        columns.Paint += (_, e) => DrawColumns(e.Graphics,
            new Rectangle(0, 0, Math.Min(columns.ClientSize.Width, choices.ClientSize.Width), columns.Height),
            "Linux distribution on WSL", "State", "VHDX size", columns.Font, Secondary);
        choices.ClientSizeChanged += (_, _) => columns.Invalidate();
        choices.DoubleClick += async (_, _) => await OpenSelectedAsync();
        measurements.BackColor = Surface;
        measurements.ForeColor = Primary;
        measurements.ItemHeight = choices.ItemHeight;
        measurements.DrawItem += DrawMeasurement;
        measurements.DoubleClick += (_, _) => OpenMeasurement();
        details.BackColor = Surface;
        details.ForeColor = Primary;
        details.Margin = new Padding(8);
        SetDataFont(settings.DataFont);

        var viewport = new Panel { Dock = DockStyle.Fill, BackColor = Surface, Padding = new Padding(9) };
        viewport.Controls.Add(choices);
        viewport.Controls.Add(measurements);
        viewport.Controls.Add(details);
        viewport.Controls.Add(columns);
        viewport.Controls.Add(confirmation);
        viewport.Controls.Add(diagnosticsActions);
        diagnosticsActions.Controls.Add(testWorker);
        testWorker.AccessibleDescription = "Send a small job to check that the Windows worker responds.";
        testWorker.Click += async (_, _) => await ProbeAsync();
        cancel.DialogResult = DialogResult.None;
        cancel.Click += (_, _) => ShowOverview();
        start.Click += async (_, _) => await SubmitCompactionAsync();
        confirmation.Controls.AddRange([cancel, start]);

        var layout = new TableLayoutPanel { ColumnCount = 1, RowCount = 6, Dock = DockStyle.Fill, Padding = new Padding(14, 12, 14, 11) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(disk, 0, 0);
        layout.Controls.Add(metadata, 0, 1);
        layout.RowStyles[2] = new RowStyle(SizeType.Percent, 100);
        layout.RowStyles[4] = new RowStyle(SizeType.AutoSize);
        layout.Controls.Add(viewport, 0, 2);
        layout.Controls.Add(maintenance, 0, 3);
        layout.Controls.Add(maintenanceProgress, 0, 4);
        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2 };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        help.AccessibleName = "Help";
        help.Margin = new Padding(8, 0, 0, 0);
        help.Click += (_, _) => ShowHelp();
        footer.Controls.Add(message, 0, 0);
        footer.Controls.Add(help, 1, 0);
        layout.Controls.Add(footer, 0, 5);
        Controls.Add(layout);
        maintenanceTimer.Tick += async (_, _) => await RefreshMaintenanceAsync();
        VisibleChanged += async (_, _) =>
        {
            maintenanceTimer.Enabled = Visible;
            if (Visible)
                await RefreshMaintenanceAsync();
        };
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
        diskFont = new Font(family, 16, FontStyle.Bold);
        details.Font = dataFont;
        disk.Font = diskFont;
        choices.Invalidate();
        measurements.Invalidate();
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
        var font = choice.Distro is not null || choice.Guest is not null
            ? dataFont : e.Font;
        var color = selected ? Accent : Primary;
        if (choice.Distro is not null || choice.Guest is not null)
            DrawColumns(e.Graphics, e.Bounds, choice.Label, choice.State ?? "", choice.Size ?? "", font ?? Font, color);
        else if (choice.Description is { } description)
        {
            int labelWidth = choices.Items.Cast<Choice>()
                .Where(item => item.Description is not null)
                .Max(item => TextRenderer.MeasureText(item.Label, e.Font).Width);
            labelWidth = Math.Min(labelWidth + 16, bounds.Width * 2 / 3);
            TextRenderer.DrawText(e.Graphics, choice.Label, font,
                new Rectangle(bounds.Left, bounds.Top, labelWidth, bounds.Height),
                choice.IsHeading ? Secondary : color, ColumnText);
            TextRenderer.DrawText(e.Graphics, description, font,
                new Rectangle(bounds.Left + labelWidth, bounds.Top, bounds.Width - labelWidth, bounds.Height),
                Secondary, ColumnText);
        }
        if (selected)
            e.DrawFocusRectangle();
    }

    private const TextFormatFlags ColumnText = TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis
        | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;

    private void DrawMeasurement(object? sender, DrawItemEventArgs e)
    {
        if (e.Index < 0)
            return;
        bool selected = (e.State & DrawItemState.Selected) != 0;
        using var background = new SolidBrush(selected ? Color.FromArgb(47, 69, 85) : Surface);
        e.Graphics.FillRectangle(background, e.Bounds);
        TextRenderer.DrawText(e.Graphics, measurements.GetItemText(measurements.Items[e.Index]),
            dataFont ?? Font, Rectangle.Inflate(e.Bounds, -8, 0), selected ? Accent : Primary, ColumnText);
        if (selected)
            e.DrawFocusRectangle();
    }

    internal static (Rectangle Name, Rectangle State, Rectangle Size) ColumnBounds(Rectangle row)
    {
        var bounds = Rectangle.Inflate(row, -8, 0);
        int name = bounds.Width * 55 / 100;
        int state = bounds.Width * 20 / 100;
        return (new(bounds.Left, bounds.Top, name, bounds.Height),
            new(bounds.Left + name, bounds.Top, state, bounds.Height),
            new(bounds.Left + name + state, bounds.Top, bounds.Width - name - state, bounds.Height));
    }

    private static void DrawColumns(Graphics graphics, Rectangle row, string name, string state, string size,
        Font font, Color color)
    {
        if (row.Width <= 16)
            return;
        var bounds = ColumnBounds(row);
        TextRenderer.DrawText(graphics, name, font, bounds.Name, color, ColumnText);
        TextRenderer.DrawText(graphics, state, font, bounds.State, color, ColumnText);
        TextRenderer.DrawText(graphics, size, font, bounds.Size, color, ColumnText | TextFormatFlags.Right);
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
        var screen = positioned ? Screen.FromControl(this) : Screen.FromPoint(Cursor.Position);
        var area = screen.WorkingArea;
        int preferredWidth = 760 * DeviceDpi / 96;
        int preferredHeight = 610 * DeviceDpi / 96;
        Size = new Size(Math.Min(area.Width, Math.Max(Width, preferredWidth)),
            Math.Min(area.Height, Math.Max(Height, preferredHeight)));
        if (!positioned)
        {
            var initialLocation = settings.Left is int left && settings.Top is int top
                ? new Point(left, top)
                : new Point(area.Right - Width - 28, area.Bottom - Height - 28);
            Location = Fit(initialLocation);
            positioned = true;
        }
        else
            Location = Fit(Location);

        Show();
        BringToFront();
        Activate();
        ShowOverview();
        _ = RefreshAsync();
    }

    private void HidePanel()
    {
        ShowOverview();
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
        if (IsHelpKey(keyData) || (keyData == Keys.Enter && help.Focused))
        {
            ShowHelp();
            return true;
        }
        if ((measurements.Visible || measurementDetails) && HandleMeasurementKey(keyData))
            return true;
        if (diagnosticsDetails && testWorker.Focused && keyData == Keys.Enter)
        {
            _ = ProbeAsync();
            return true;
        }
        if (keyData == Keys.Escape)
        {
            if (details.Visible || previewing)
                ShowOverview();
            else
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

        if (confirmation.Visible && keyData is (Keys.J or Keys.K or Keys.Enter or Keys.L or Keys.Space))
        {
            if (keyData is Keys.J or Keys.K)
                (start.Focused ? cancel : start).Focus();
            else if (keyData == Keys.Enter)
            {
                if (ConfirmsCompaction(keyData, start.Focused))
                    _ = SubmitCompactionAsync();
                else
                    ShowOverview();
            }
            return true;
        }
        if (keyData is Keys.J or Keys.K or Keys.Down or Keys.Up || PageDirection(keyData) != 0)
        {
            int page = PageDirection(keyData);
            int direction = page != 0 ? page : keyData is Keys.J or Keys.Down ? 1 : -1;
            if (details.Visible)
                ScrollDetails(direction * (page == 0 ? 1 : DetailPageLines));
            else
                MoveChoice(direction, page == 0 ? 1 : Math.Max(1, choices.ClientSize.Height / choices.ItemHeight));
            return true;
        }
        if (keyData == Keys.H && (details.Visible || previewing))
        {
            ShowOverview();
            return true;
        }
        if (keyData == Keys.Space && !details.Visible && choices.SelectedItem is Choice { Key: "compact" })
        {
            _ = PreviewAsync(compaction: true);
            return true;
        }
        if ((keyData == Keys.L || (keyData == Keys.Enter && choices.Focused)) && !details.Visible)
        {
            _ = OpenSelectedAsync();
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    internal static bool ConfirmsCompaction(Keys key, bool startSelected) => key == Keys.Enter && startSelected;

    internal static bool IsHelpKey(Keys key) => key == (Keys.Shift | Keys.OemQuestion);

    protected override void OnKeyPress(KeyPressEventArgs e)
    {
        if (e.KeyChar == '?')
        {
            ShowHelp();
            e.Handled = true;
        }
        base.OnKeyPress(e);
    }

    private void ShowHelp()
    {
        operationNote = null;
        ShowDetails(PanelHelp.Text);
        RenderMessage();
    }

    internal static int PageDirection(Keys key) => key switch
    {
        Keys.PageUp or (Keys.Control | Keys.U) => -1,
        Keys.PageDown or (Keys.Control | Keys.D) => 1,
        _ => 0,
    };

    private void MoveChoice(int direction, int count)
    {
        int index = choices.SelectedIndex;
        for (int step = 0; step < count; step++)
        {
            int next = index + direction;
            while (next >= 0 && next < choices.Items.Count && ((Choice)choices.Items[next]!).IsHeading)
                next += direction;
            if (next < 0 || next >= choices.Items.Count)
                break;
            index = next;
        }
        choices.SelectedIndex = index;
    }

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern IntPtr SendEditMessage(IntPtr handle, uint command, IntPtr wParam, IntPtr lParam);

    private int DetailPageLines => Math.Max(1, details.ClientSize.Height / details.Font.Height);
    private int FirstDetailLine => (int)SendEditMessage(details.Handle, 0xCE, IntPtr.Zero, IntPtr.Zero);
    private int LastDetailLine => Math.Max(0, details.GetLineFromCharIndex(details.TextLength));

    private void ScrollDetails(int distance)
    {
        int first = FirstDetailLine;
        int target = Math.Clamp(first + distance, 0, Math.Max(0, LastDetailLine - DetailPageLines + 1));
        SendEditMessage(details.Handle, 0xB6, IntPtr.Zero, (IntPtr)(target - first));
    }

    internal async Task RefreshAsync()
    {
        if (refreshing || shutdown.IsCancellationRequested)
            return;
        refreshing = true;
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
        if (measurements.Visible)
            PopulateMeasurements(current.History ?? []);
    }

    private async Task RefreshMaintenanceAsync()
    {
        if (maintenanceRefreshing || shutdown.IsCancellationRequested)
            return;
        maintenanceRefreshing = true;
        try
        {
            var status = await StatusClient.RunAsync<MaintenanceSnapshot>("maintenance", shutdown);
            if (IsDisposed)
                return;
            if (submitting && status.Job?.Id != latestMaintenance?.Id && latestMaintenance?.IsPending == true)
                return;
            latestMaintenance = status.Job;
            var message = MaintenanceMessage(status.Job);
            maintenance.Visible = message is not null;
            maintenance.Text = message is null ? "" : message + MaintenanceElapsed(status.Job);
            if (status.Job is { IsPending: true, LastEventAt: { } activity })
                maintenance.Text += $"  ·  Last activity {activity.ToLocalTime():HH:mm:ss}";
            int? percent = status.Job is { State: "accepted", Stage: "diskpart-output" } job
                ? job.Percent : null;
            ShowMaintenanceProgress(submitting || status.Job?.IsPending == true, percent);
            if (maintenanceDetails && details.Visible)
            {
                string timeline = MaintenanceTimeline(status.Job);
                if (details.Text != timeline)
                {
                    int first = FirstDetailLine;
                    bool atEnd = first + DetailPageLines > LastDetailLine;
                    details.Text = timeline;
                    ScrollDetails((atEnd ? LastDetailLine : first) - FirstDetailLine);
                }
            }
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (IsDisposed)
                return;
            if (maintenance.Text != "Compaction job status unavailable")
                DesktopFiles.Log($"maintenance status unavailable: {error.Message}");
            maintenance.Text = "Compaction job status unavailable";
            maintenance.Visible = true;
            maintenanceProgress.Visible = false;
        }
        finally { maintenanceRefreshing = false; }
    }

    private void ShowMaintenanceProgress(bool active, int? percent)
    {
        maintenanceProgress.Visible = active;
        maintenanceProgress.Style = percent.HasValue ? ProgressBarStyle.Continuous : ProgressBarStyle.Marquee;
        if (percent is int value)
            maintenanceProgress.Value = Math.Clamp(value, 0, 100);
    }

    internal static string? MaintenanceMessage(MaintenanceJob? job) => job switch
    {
        null => null,
        { State: "completed", Result: { FreeSpaceChange: long gain, DiskReduction: long shrink } } =>
            $"Last compaction complete  ·  C: {(gain >= 0 ? "+" : "")}{FormatBytes(gain)}  ·  VHDX reduction {FormatBytes(shrink)}",
        { State: "completed" } => "Last compaction complete",
        { State: "failed" or "attention", Result: { CompactionOk: true, RecoveryOk: false } } =>
            "Disk compacted. Ubuntu recovery needs attention.",
        { State: "attention" or "interrupted" } => "Compaction needs attention  ·  Check the Windows journal",
        { State: "acknowledged" } => "Compaction hold cleared",
        { State: "failed", Result.Error: { Length: > 0 } error } => $"Last compaction failed  ·  {error}",
        { State: "failed" } => "Last compaction failed  ·  Check the Windows journal",
        { Stage: "docker-stop-started" } => "Stopping Docker Desktop",
        { Stage: "windows-services-started" or "docker-stopped" } => "Preparing Windows recovery access",
        { Stage: "trim-started" or "trim-completed" } => "Preparing Ubuntu storage",
        { Stage: "shutdown-requested" or "shutdown-observed" } => "Stopping WSL",
        { Stage: "diskpart-output", Percent: int percent } => $"Compacting Ubuntu disk  ·  {percent}%",
        { Stage: "compaction-requested" or "diskpart-started" or "compaction-started" or "diskpart-output" } => "Compacting Ubuntu disk",
        { Stage: "diskpart-exit" or "detach-requested" or "detach-observed" or "diskpart-result" or "windows-result" } => "Verifying disk detachment",
        { Stage: "restart-requested" or "ubuntu-started" or "herdr-launch-requested" or "recovery-waiting" or "recovery-ready" or "windows-ssh-observed" } => "Restarting Ubuntu and checking remote access",
        _ => "Checking compaction prerequisites",
    };

    private static string MaintenanceElapsed(MaintenanceJob? job)
    {
        if (job?.AcceptedAt is not { } accepted || (!job.IsPending && job.FinishedAt is null))
            return "";
        var elapsed = (job.FinishedAt ?? DateTimeOffset.UtcNow) - accepted;
        return $"  ·  {Math.Max(0, (int)elapsed.TotalMinutes)}m {Math.Max(0, elapsed.Seconds):00}s";
    }

    internal static string MaintenanceTimeline(MaintenanceJob? job)
    {
        if (job is null)
            return "No compaction job has been recorded.";

        var text = new StringBuilder().AppendLine(MaintenanceMessage(job) + MaintenanceElapsed(job)).AppendLine();
        foreach (var milestone in job.Milestones ?? [])
        {
            string? label = milestone.Stage switch
            {
                "accepted-on-windows" => "Windows accepted the job",
                "preflight-passed" => "Checked the Ubuntu disk, Docker, and Windows SSH",
                "trim-started" => "Started TRIM to mark unused Ubuntu blocks",
                "trim-completed" => "Ubuntu finished reporting discardable blocks",
                "shutdown-requested" => "Asked WSL to shut down",
                "shutdown-observed" => "Verified that WSL was offline",
                "compaction-started" => "DiskPart began compacting the Ubuntu disk",
                "detach-observed" => milestone.Verified ? "Verified disk detachment" : "Disk detachment could not be verified",
                "windows-result" => "Measured Windows free space and VHDX size",
                "restart-requested" => "Asked Windows to start Ubuntu again",
                "ubuntu-started" => "Ubuntu booted",
                "recovery-waiting" => "Waiting for Linux remote access",
                "recovery-ready" => "Verified Linux SSH, Tailscale, Moshi, and Herdr",
                "phase-failed" => "A compaction step failed",
                "recovery-failed" => "Ubuntu recovery needs attention",
                "recovery-deferred" => "Paused recovery until the disk can be checked",
                "job-finished" => "Windows recorded the final result",
                _ => null,
            };
            if (label is null)
                continue;
            text.AppendLine($"{milestone.At.ToLocalTime():HH:mm:ss}  {label}");
            if (milestone.Note is { Length: > 0 } note)
                text.AppendLine($"          {note}");
        }
        if (job.Id is { } id)
            text.AppendLine().AppendLine($"Job ID {id}");
        return text.ToString();
    }

    private async Task PreviewAsync(bool compaction = false)
    {
        string? distro = (choices.SelectedItem as Choice)?.Distro?.Name;
        if ((!compaction && distro is null) || previewing || submitting || shutdown.IsCancellationRequested)
            return;
        int requestedView = navigationVersion;
        previewing = true;
        operationNote = "Checking maintenance prerequisites…";
        RenderMessage();
        try
        {
            string? blocker = null;
            if (compaction)
            {
                var current = await StatusClient.RunAsync<Snapshot>("collect", shutdown);
                ApplySnapshot(current);
                Render();
                if (requestedView != navigationVersion || !Visible)
                    return;
                distro = current.Compaction?.Distro;
                blocker = CompactBlocker(current, true, latestMaintenance?.IsPending == true);
            }
            var result = new StringBuilder();
            result.AppendLine(compaction ? "Compact Ubuntu disk" : $"Maintenance preview for {distro}").AppendLine();
            if (blocker is not null)
                result.AppendLine(blocker).AppendLine();
            Preview? plan = distro is null || blocker is not null ? null
                : await StatusClient.RunAsync<Preview>("preview", shutdown, "-Distro", distro);
            if (requestedView != navigationVersion || !Visible)
                return;
            if (plan is not null)
                foreach (var item in plan.Blockers)
                    result.AppendLine(item.Message);
            bool eligible = compaction && blocker is null && plan?.Decision == "eligible" && plan.Blockers.Length == 0;
            if (eligible)
                result.AppendLine($"Target {plan!.Distro}").AppendLine(snapshot?.Compaction?.Vhdx)
                    .AppendLine().AppendLine("WSL sessions will disconnect. Windows will trim and compact the disk, then restart Ubuntu.")
                    .AppendLine(snapshot?.Inventory?.DockerDesktopRunning == true
                        ? "Docker Desktop will stop and stay stopped after compaction." : "")
                    .AppendLine().AppendLine("j/k Select   Enter Confirm   Esc Cancel");
            else if (!compaction && plan?.Decision == "eligible")
                result.AppendLine("The disk passed the preview checks. Use Compact Ubuntu disk to review and confirm the action.");
            ShowDetails(result.ToString());
            if (eligible)
            {
                confirmedDistro = distro;
                confirmation.Show();
                cancel.Focus();
            }
            operationNote = null;
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
            }
        }
    }

    private async Task SubmitCompactionAsync()
    {
        if (confirmedDistro is not { } distro || submitting || shutdown.IsCancellationRequested)
            return;
        submitting = true;
        confirmedDistro = null;
        confirmation.Hide();
        ShowOverview();
        maintenance.Text = "Submitting compaction to the Windows worker…";
        maintenance.Visible = true;
        ShowMaintenanceProgress(true, null);
        int requestedView = navigationVersion;
        try
        {
            var job = await StatusClient.RunAsync<MaintenanceJob>("compact", shutdown, "-Distro", distro);
            latestMaintenance = job;
            if (requestedView == navigationVersion && Visible)
            {
                maintenance.Text = MaintenanceMessage(job) + MaintenanceElapsed(job);
                ShowMaintenanceProgress(job.IsPending, null);
            }
            await RefreshMaintenanceAsync();
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            operationNote = $"Could not submit compaction. {error.Message}";
            DesktopFiles.Log(operationNote);
            if (requestedView == navigationVersion && Visible)
                ShowDetails(operationNote);
            RenderMessage();
        }
        finally
        {
            submitting = false;
            if (latestMaintenance?.IsPending != true)
                ShowMaintenanceProgress(false, null);
        }
    }

    private async Task ProbeAsync()
    {
        if (!CanProbe() || shutdown.IsCancellationRequested)
            return;
        probing = true;
        operationNote = "Testing the Windows worker…";
        Render();
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
                operationNote = "The worker test is still pending. Refresh to check its status.";
            else
                DesktopFiles.Log($"probe {activeProbe.State}: {activeProbe.Id}");
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            operationNote = $"Worker test status unavailable. {error.Message}";
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
            {
                Render();
                if (diagnosticsDetails)
                    await RefreshDiagnosticsAsync();
            }
        }
    }

    private bool CanProbe() => ProbeAvailable(snapshot, workerVerified) && !probing && activeProbe?.IsPending != true;

    internal static bool ProbeAvailable(Snapshot? current, bool verified) =>
        verified && current?.Worker?.State == "ready";

    internal static bool InventoryStale(Snapshot? current, bool failed, DateTimeOffset now) =>
        failed || current?.InventoryStale == true ||
        (current?.ObservedAt is { } timestamp && now - timestamp > StaleAge);

    private void Render()
    {
        var inventory = snapshot?.Inventory;
        var previous = snapshot?.PreviousInventory;
        var timestamp = snapshot?.ObservedAt;
        disk.Text = inventory?.CFreeBytes is long bytes
            ? $"C:  {FormatBytes(bytes)} free" + Delta(bytes, previous?.CFreeBytes)
            : "C:  Free space unavailable";
        bool stale = InventoryStale(snapshot, refreshFailed, DateTimeOffset.UtcNow);
        var when = timestamp is { } observed ? $"Updated {observed.ToLocalTime():HH:mm}" : "Waiting for first sample";
        var docker = inventory?.DockerDesktopRunning switch { true => "running", false => "stopped", null => "unknown" };
        var worker = workerVerified ? snapshot?.Worker?.State ?? "unknown" : "unverified";
        metadata.Text = $"{when}{(stale ? " (stale)" : "")}  ·  Docker {docker}  ·  Worker {worker}";

        var previousSelection = (choices.SelectedItem as Choice)?.Key;
        choices.BeginUpdate();
        try
        {
            choices.Items.Clear();
            lastChoice = -1;
            var reports = snapshot?.GuestReports ?? [];
            foreach (Distro distro in (inventory?.Distributions ?? []).OrderByDescending(item => item.VhdLengthBytes))
            {
                var running = inventory?.RunningDistros;
                var status = running is null ? "unknown" :
                    running.Contains(distro.Name, StringComparer.OrdinalIgnoreCase) ? "running" : "stopped";
                var size = distro.VhdLengthBytes is long length ? FormatBytes(length) : "Unavailable";
                choices.Items.Add(new Choice("distro:" + distro.Name, distro.Name, distro, State: status, Size: size));
                foreach (var guest in reports.Where(item => item.Distro.Equals(distro.Name, StringComparison.OrdinalIgnoreCase)))
                    AddGuestRow(guest);
            }
            foreach (var guest in reports.Where(item => !(inventory?.Distributions ?? [])
                .Any(distro => distro.Name.Equals(item.Distro, StringComparison.OrdinalIgnoreCase))))
                AddGuestRow(guest);
            choices.Items.Add(new Choice("heading:space", ""));
            choices.Items.Add(new Choice("heading:actions", "Action", Description: "Description"));
            choices.Items.Add(new Choice("compact", "Compact Ubuntu disk", Description: "Reclaim C: space and restart Ubuntu"));
            choices.Items.Add(new Choice("refresh", "Refresh status", Description: "Read current disk and worker status"));
            choices.Items.Add(new Choice("maintenance", "Compaction details", Description: "Follow the job timeline and result"));
            choices.Items.Add(new Choice("history", "Recent measurements", Description: "Compare previous disk readings"));
            choices.Items.Add(new Choice("diagnostics", "Diagnostics and logs", Description: "Inspect the Windows worker and logs"));
            int matching = Enumerable.Range(0, choices.Items.Count)
                .FirstOrDefault(index => ((Choice)choices.Items[index]!).Key == previousSelection, -1);
            choices.SelectedIndex = matching >= 0 && !((Choice)choices.Items[matching]!).IsHeading
                ? matching : Enumerable.Range(0, choices.Items.Count)
                    .First(index => !((Choice)choices.Items[index]!).IsHeading);
        }
        finally { choices.EndUpdate(); }
        testWorker.Enabled = CanProbe();
        RenderMessage();
    }

    private void AddGuestRow(GuestReport guest)
    {
        string size = guest.Report is { } report
            ? $"{FormatBytes(report.Filesystem.AvailableBytes)} free" : "Unavailable";
        choices.Items.Add(new Choice("guest:" + guest.Distro,
            $"    Linux filesystem · {guest.Distro}", Guest: guest, State: guest.State, Size: size));
    }

    private void RenderMessage()
    {
        if (measurements.Visible || measurementDetails)
        {
            message.Text = measurementDetails ? "j/k Previous or next measurement   h/Esc Back"
                : "j/k Move by measurement   l/Enter Full measurement   h/Esc Back";
            return;
        }
        message.Text = operationNote ?? hotkeyNote
            ?? (workerVerified && snapshot?.Compaction?.State == "missing"
                ? "One-time setup required. Run wsl-cross-hub setup --apply."
                : workerVerified && snapshot?.Compaction?.State == "misconfigured"
                ? "Check compaction configuration in Diagnostics and logs."
                : snapshot is not null && snapshot.Worker?.State != "ready"
                ? "Waiting for the Windows worker. Open Diagnostics and logs for details."
                : "j/k Move   l/Enter Open   Space Preview   h Back   Esc Back or Hide");
    }

    internal static string? CompactBlocker(Snapshot? current, bool verified, bool pending)
    {
        if (pending || current?.Compaction?.State == "busy")
            return "A compaction job is already active. Open Compaction details to follow it.";
        if (current?.Compaction?.State == "missing")
            return "One-time setup required. Run wsl-cross-hub setup --apply.";
        if (current?.Compaction?.State == "blocked")
            return current.Compaction.Hint ?? "Review the previous compaction job before starting another.";
        if (!verified || current?.Worker is not { State: "ready", MaintenanceProtocol: 1 })
            return "The maintenance worker is unavailable. Refresh status and check Diagnostics and logs.";
        if (current.Compaction is not { State: "ready", Distro.Length: > 0, Vhdx.Length: > 0 } target)
            return current.Compaction?.Hint ?? "Windows could not verify the approved compaction target.";
        if (current.Inventory?.DockerDesktopRunning is null || current.Inventory.RunningDistros is not { } running)
            return "Windows could not verify the Docker and WSL state. Refresh and try again.";
        var other = running.Where(name => !name.Equals(target.Distro, StringComparison.OrdinalIgnoreCase)
            && !name.Equals("docker-desktop", StringComparison.OrdinalIgnoreCase)
            && !name.Equals("docker-desktop-data", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (other.Length > 0)
            return $"Other WSL distributions are running. Stop {string.Join(", ", other)} before compaction.";
        return running.Contains(target.Distro, StringComparer.OrdinalIgnoreCase) ? null : $"Start {target.Distro} so Windows can run TRIM before compaction.";
    }

    internal static string CompactionStatus(Snapshot? snapshot, bool verified) =>
        verified ? snapshot?.Compaction?.State switch
        {
            "missing" => "setup required",
            "misconfigured" => "check configuration",
            "ready" when snapshot?.Worker is { State: "ready", MaintenanceProtocol: 1 } => "ready",
            "ready" => "worker unavailable",
            "busy" => "busy",
            "blocked" => "review previous job",
            _ => "unavailable",
        } : "unverified";

    private async Task OpenSelectedAsync()
    {
        if (choices.SelectedItem is not Choice item)
            return;
        switch (item.Key)
        {
            case "compact": await PreviewAsync(compaction: true); return;
            case "refresh": await RefreshAsync(); return;
        }
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
        if (item.Key == "maintenance")
        {
            ShowDetails(MaintenanceTimeline(latestMaintenance), followMaintenance: true);
            await RefreshMaintenanceAsync();
            return;
        }

        if (item.Key == "history")
        {
            var samples = snapshot?.History ?? [];
            if (samples.Length == 0)
            {
                ShowDetails("No disk measurements have been stored yet.");
                return;
            }

            measurements.SelectedIndex = -1;
            ShowMeasurements();
            return;
        }

        ShowDetails("Loading Diagnostics and logs…", followDiagnostics: true);
        await RefreshDiagnosticsAsync();
    }

    private async Task RefreshDiagnosticsAsync()
    {
        int requestedView = navigationVersion;
        var text = new StringBuilder("Diagnostics and logs").AppendLine().AppendLine();
        text.AppendLine("Test Windows worker sends a small job and checks that the worker");
        text.AppendLine("accepts and completes it. WSL stays running. The test does no disk cleanup.");
        text.AppendLine("Use Tab to select the test button and Enter to run it.").AppendLine();
        if (snapshot?.Worker?.HeartbeatAt is { } heartbeat)
            text.AppendLine($"Windows worker last checked in at {heartbeat.ToLocalTime():MMM d, HH:mm:ss}.");
        if (activeProbe is { } job)
            text.AppendLine($"Most recent worker test · {job.State} · {Elapsed(job)}")
                .AppendLine($"Job ID {job.Id}");
        text.AppendLine($"Compaction status · {CompactionStatus(snapshot, workerVerified)}");
        if (snapshot?.Compaction?.Hint is { } hint)
            text.AppendLine(hint);
        if (hotkeyNote is not null)
            text.AppendLine(hotkeyNote);
        foreach (Diagnostic diagnostic in (snapshot?.Errors ?? Array.Empty<Diagnostic>())
            .Concat(snapshot?.Inventory?.Errors ?? Array.Empty<Diagnostic>()).Distinct())
            text.AppendLine($"{diagnostic.Source}: {diagnostic.Message}");
        string info = await Task.Run(() =>
            $"Desktop log{Environment.NewLine}{DesktopFiles.Tail(DesktopFiles.DesktopLog)}{Environment.NewLine}{Environment.NewLine}" +
            $"Worker log{Environment.NewLine}{DesktopFiles.Tail(DesktopFiles.WorkerLog)}");
        if (!shutdown.IsCancellationRequested && requestedView == navigationVersion && diagnosticsDetails)
            details.Text = text.AppendLine().AppendLine(info).ToString();
    }

    internal static string FormatMeasurement(Measurement sample)
    {
        string timestamp = sample.ObservedAt.ToLocalTime()
            .ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
        string host = sample.CFreeBytes is long free ? $"C: {FormatBytes(free)} free" : "C: free space unavailable";
        var distributions = (sample.Distributions ?? []).Select(distro =>
            $"{distro.Name}: {(distro.VhdLengthBytes is long bytes ? FormatBytes(bytes) : "size unavailable")}");
        return string.Join("  |  ", [timestamp, host, .. distributions]);
    }

    private void ShowMeasurements()
    {
        PopulateMeasurements(snapshot?.History ?? []);
        navigationVersion++;
        measurementDetails = false;
        maintenanceDetails = false;
        confirmedDistro = null;
        confirmation.Hide();
        choices.Hide();
        columns.Hide();
        details.Hide();
        measurements.Show();
        measurements.Focus();
        operationNote = null;
        RenderMessage();
    }

    private void PopulateMeasurements(Measurement[] samples)
    {
        var previous = (measurements.SelectedItem as MeasurementRow)?.Sample.ObservedAt;
        measurements.BeginUpdate();
        try
        {
            measurements.Items.Clear();
            int selected = 0;
            foreach (var sample in samples.OrderByDescending(sample => sample.ObservedAt))
            {
                if (sample.ObservedAt == previous)
                    selected = measurements.Items.Count;
                measurements.Items.Add(new MeasurementRow(sample));
            }
            if (measurements.Items.Count > 0)
                measurements.SelectedIndex = selected;
        }
        finally { measurements.EndUpdate(); }
    }

    private void OpenMeasurement()
    {
        if (measurements.SelectedItem is not MeasurementRow row)
            return;
        ShowDetails($"Storage measurement{Environment.NewLine}{Environment.NewLine}{row}");
        measurementDetails = true;
        RenderMessage();
    }

    private bool HandleMeasurementKey(Keys key)
    {
        int page = PageDirection(key);
        if (page != 0 && measurements.Items.Count > 0)
        {
            int count = Math.Max(1, measurements.ClientSize.Height / measurements.ItemHeight);
            measurements.SelectedIndex = Math.Clamp(
                measurements.SelectedIndex + page * count, 0, measurements.Items.Count - 1);
            if (measurementDetails)
                OpenMeasurement();
            return true;
        }
        switch (key)
        {
            case Keys.J:
            case Keys.K:
                if (measurements.Items.Count == 0)
                    return true;
                measurements.SelectedIndex = Math.Clamp(
                    measurements.SelectedIndex + (key == Keys.J ? 1 : -1), 0, measurements.Items.Count - 1);
                if (measurementDetails)
                    OpenMeasurement();
                return true;
            case Keys.L or Keys.Enter when measurements.Visible:
                OpenMeasurement();
                return true;
            case Keys.H or Keys.Escape:
                if (measurementDetails)
                    ShowMeasurements();
                else
                    ShowOverview();
                return true;
            default:
                return false;
        }
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

    private void ShowDetails(string text, bool followMaintenance = false, bool followDiagnostics = false)
    {
        navigationVersion++;
        confirmedDistro = null;
        confirmation.Hide();
        maintenanceDetails = followMaintenance;
        measurementDetails = false;
        measurements.Hide();
        diagnosticsDetails = followDiagnostics;
        diagnosticsActions.Visible = followDiagnostics;
        testWorker.Enabled = CanProbe();
        details.Text = text;
        details.SelectionStart = 0;
        choices.Hide();
        columns.Hide();
        details.Show();
        details.Focus();
    }

    private void ShowOverview()
    {
        navigationVersion++;
        confirmedDistro = null;
        maintenanceDetails = false;
        measurementDetails = false;
        measurements.Hide();
        diagnosticsDetails = false;
        diagnosticsActions.Hide();
        confirmation.Hide();
        details.Hide();
        columns.Show();
        choices.Show();
        choices.Focus();
        operationNote = null;
        RenderMessage();
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
        if (disposing)
            maintenanceTimer.Dispose();
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
        string Key, string Label, Distro? Distro = null, GuestReport? Guest = null,
        string? State = null, string? Size = null, string? Description = null)
    {
        public bool IsHeading => Key.StartsWith("heading:", StringComparison.Ordinal);
        public override string ToString() => Label;
    }

    private sealed record MeasurementRow(Measurement Sample)
    {
        public override string ToString() => FormatMeasurement(Sample);
    }
}

internal static class DesktopSelfTest
{
    internal static int Run()
    {
        if (!HotkeyWindow.Parse(DesktopSettings.DefaultHotkey, out uint modifiers, out uint key)
            || modifiers != 5 || key != 'C')
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
        var oldSettings = DesktopSettings.Read("""
            {"startupEnabled":true,"hotkey":"Control + Alt + F3","keepOnTop":true}
            """);
        using var panel = new PanelWindow(oldSettings, CancellationToken.None);
        if (panel.TopMost || oldSettings.Hotkey != DesktopSettings.DefaultHotkey
            || DesktopSettings.Read("""{"hotkey":"Ctrl+Shift+K"}""").Hotkey != "Ctrl+Shift+K"
            || DesktopSettings.Read("""{"hotkey":"Ctrl+Alt+F3","hotkeyDefaultVersion":1}""").Hotkey != "Ctrl+Alt+F3")
            return 19;
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
        var missing = ready with { Compaction = new("missing", "Set up compaction") };
        var installed = ready with { Compaction = new("ready", null) };
        var configured = installed with { Worker = ready.Worker! with { MaintenanceProtocol = 1 } };
        if (PanelWindow.CompactionStatus(missing, true) != "setup required"
            || PanelWindow.CompactionStatus(installed, true) != "worker unavailable"
            || PanelWindow.CompactionStatus(configured, true) != "ready"
            || PanelWindow.CompactionStatus(configured, false) != "unverified")
            return 10;
        var running = new MaintenanceJob("accepted", "diskpart-output", 42, null);
        var finished = new MaintenanceJob("completed", "job-finished", 100, new(1073741824, 2147483648));
        if (PanelWindow.MaintenanceMessage(running)?.EndsWith("42%") != true
            || PanelWindow.MaintenanceMessage(finished)?.Contains("VHDX reduction 2") != true
            || PanelWindow.MaintenanceMessage(running with { Stage = "restart-requested" })?.StartsWith("Restarting Ubuntu") != true
            || PanelWindow.MaintenanceMessage(finished with { State = "failed", Result = new(null, null, true, false) })
                ?.Contains("recovery needs attention") != true)
            return 11;
        var timeline = PanelWindow.MaintenanceTimeline(finished with { Milestones = [
            new("shutdown-observed", DateTimeOffset.UtcNow, null, false),
            new("recovery-ready", DateTimeOffset.UtcNow, null, false),
        ] });
        if (!timeline.Contains("WSL was offline") || !timeline.Contains("Moshi, and Herdr"))
            return 12;
        if (PanelWindow.PageDirection(Keys.Control | Keys.U) != -1
            || PanelWindow.PageDirection(Keys.Control | Keys.D) != 1
            || PanelWindow.PageDirection(Keys.PageUp) != -1
            || PanelWindow.PageDirection(Keys.PageDown) != 1
            || PanelWindow.PageDirection(Keys.U) != 0)
            return 20;
        if (PanelWindow.ConfirmsCompaction(Keys.Space, true) || PanelWindow.ConfirmsCompaction(Keys.L, true)
            || PanelWindow.ConfirmsCompaction(Keys.Enter, false) || !PanelWindow.ConfirmsCompaction(Keys.Enter, true))
            return 13;
        var compactionReady = configured with {
            Compaction = new("ready", null, "Ubuntu", @"C:\Ubuntu\ext4.vhdx"),
            Inventory = configured.Inventory! with { RunningDistros = ["Ubuntu"] },
        };
        var dockerRunning = compactionReady with { Inventory = compactionReady.Inventory! with { DockerDesktopRunning = true, RunningDistros = ["Ubuntu", "docker-desktop", "docker-desktop-data"] } };
        var otherRunning = compactionReady with { Inventory = compactionReady.Inventory! with { RunningDistros = ["Ubuntu", "Other"] } };
        if (PanelWindow.CompactBlocker(compactionReady, true, false) is not null
            || PanelWindow.CompactBlocker(dockerRunning, true, false) is not null
            || PanelWindow.CompactBlocker(otherRunning, true, false)?.Contains("Other") != true
            || PanelWindow.CompactBlocker(compactionReady, true, true)?.Contains("already active") != true
            || PanelWindow.CompactBlocker(missing, true, false)?.Contains("setup --apply") != true
            || PanelWindow.CompactBlocker(installed, true, false)?.Contains("worker is unavailable") != true)
            return 14;
        foreach (var width in new[] { 400, 720, 1080 })
        {
            var columns = PanelWindow.ColumnBounds(new Rectangle(0, 0, width, 28));
            if (columns.Name.Right != columns.State.Left || columns.State.Right != columns.Size.Left
                || columns.Size.Right != width - 8 || columns.Name.Width <= columns.State.Width)
                return 15;
        }
        var sample = new Measurement(DateTimeOffset.Now, 139586437120,
            [new("Ubuntu-24.04", 515396075520, true, true), new("docker-desktop-data", null, true, true)]);
        var row = PanelWindow.FormatMeasurement(sample);
        if (row.Contains('\n') || !row.Contains($"C: {PanelWindow.FormatBytes(139586437120)} free")
            || !row.Contains($"Ubuntu-24.04: {PanelWindow.FormatBytes(515396075520)}")
            || !row.Contains("docker-desktop-data: size unavailable")
            || PanelWindow.FormatMeasurement(sample with { CFreeBytes = null, Distributions = null })
                .Split('|').Length != 2)
            return 61;
        if (!PanelWindow.IsHelpKey(Keys.Shift | Keys.OemQuestion)
            || PanelWindow.IsHelpKey(Keys.OemQuestion)
            || PanelWindow.IsHelpKey(Keys.Control | Keys.Shift | Keys.OemQuestion)
            || !PanelHelp.Text.Contains("It starts on Cancel.", StringComparison.Ordinal)
            || !PanelHelp.Text.Contains("status-history.json", StringComparison.Ordinal)
            || !PanelHelp.Text.Contains("Test Windows", StringComparison.Ordinal))
            return 62;
        return 0;
    }
}
