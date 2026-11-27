using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace WslCrossHub.Desktop;

internal sealed partial class PanelWindow
{
    private readonly System.Windows.Forms.Timer doctorTimer = new() { Interval = 60_000 };
    private readonly Label doctorIndicator = new() { AutoSize = true, AccessibleName = "Doctor status" };
    private readonly TableLayoutPanel doctorActions = new()
    {
        AutoSize = true, Dock = DockStyle.Bottom, Visible = false, ColumnCount = 1,
    };
    private readonly ComboBox doctorCheckSelector = DoctorSelector("Doctor check", 170);
    private readonly ComboBox doctorRunnerSelector = DoctorSelector("Manual runner", 95);
    private readonly ComboBox doctorAutoSelector = DoctorSelector("Automatic investigation runner", 95);
    private readonly Button doctorInvestigate = ActionButton("Investigate");
    private readonly Button doctorCure = ActionButton("Cure");
    private readonly Button doctorJournal = ActionButton("Open journal");
    private readonly Button doctorCheckNow = ActionButton("Check now");
    private DoctorReport? doctorReport;
    private DoctorJob? latestDoctorJob;
    private DateTimeOffset? doctorCheckedAt;
    private DateTimeOffset? lastAutomaticObservation;
    private bool doctorDetails;
    private bool doctorRefreshing;
    private bool doctorPolling;
    private bool doctorSubmitting;
    private bool updatingDoctorChecks;
    private string? doctorError;
    private string? doctorJobError;
    private string? doctorEditorError;
    private Process? editorDoctor;
    private string? editorDoctorTitle;
    private bool openingEditor;

    private bool CompactionActive => submitting || latestMaintenance?.IsPending == true;

    private static ComboBox DoctorSelector(string name, int width) => new()
    {
        AccessibleName = name, DropDownStyle = ComboBoxStyle.DropDownList, Width = width,
    };

    private static FlowLayoutPanel DoctorRow(params Control[] children)
    {
        var row = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        row.Controls.AddRange(children);
        return row;
    }

    private void InitializeDoctorControls(Panel viewport)
    {
        doctorIndicator.ForeColor = Secondary;
        doctorActions.Controls.Add(DoctorRow(
            doctorCheckSelector, doctorRunnerSelector, doctorInvestigate, doctorCure));
        var autoLabel = new Label { Text = "Auto-investigate", AutoSize = true, Margin = new Padding(2, 6, 2, 0) };
        doctorActions.Controls.Add(DoctorRow(doctorCheckNow, doctorJournal, autoLabel, doctorAutoSelector));
        viewport.Controls.Add(doctorActions);

        doctorAutoSelector.Items.AddRange(["Off", "Codex", "Claude"]);
        doctorAutoSelector.SelectedIndex = settings.AutoInvestigate switch { "codex" => 1, "claude" => 2, _ => 0 };
        doctorAutoSelector.SelectionChangeCommitted += (_, _) =>
            SetAutomaticDoctor(DoctorRunnerId(doctorAutoSelector));
        doctorCheckSelector.SelectedIndexChanged += (_, _) =>
        {
            if (!updatingDoctorChecks)
                UpdateDoctorRunners();
        };
        doctorRunnerSelector.SelectedIndexChanged += (_, _) => UpdateDoctorActions();
        doctorCheckNow.Click += async (_, _) => await RefreshDoctorAsync(periodic: false);
        doctorInvestigate.Click += async (_, _) => await StartDoctorJobAsync("investigate");
        doctorCure.Click += async (_, _) => await StartDoctorJobAsync("cure");
        doctorJournal.Click += async (_, _) => await OpenDoctorJournalAsync();
        doctorTimer.Tick += async (_, _) => await RefreshDoctorAsync(periodic: true);
        FormClosed += (_, _) => editorDoctor?.Dispose();
        RenderDoctorIndicator();
    }

    internal void SetAutomaticDoctor(string value)
    {
        if (value is not ("off" or "codex" or "claude"))
            return;
        string previous = settings.AutoInvestigate;
        settings.AutoInvestigate = value;
        if (!SaveDoctorSettings())
            settings.AutoInvestigate = previous;
        doctorAutoSelector.SelectedIndex = settings.AutoInvestigate switch { "codex" => 1, "claude" => 2, _ => 0 };
        RenderDoctorDetails();
    }

    internal async Task OpenWindowsDoctorAsync()
    {
        ShowPanel();
        await OpenDoctorAsync();
    }

    private bool NativeDoctorOpen => editorDoctor is { HasExited: false };

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern nint FindWindow(string? className, string windowName);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsIconic(nint handle);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(nint handle, int command);

    private static async Task<bool> FocusEditorAsync(string title)
    {
        for (int attempt = 0; attempt < 5; attempt++)
        {
            nint handle = FindWindow(null, title);
            if (handle != 0)
            {
                if (IsIconic(handle))
                    ShowWindowAsync(handle, 9); // SW_RESTORE
                if (GetForegroundWindow() == handle)
                    return true;
                SetForegroundWindow(handle);
                if (GetForegroundWindow() == handle)
                    return true;
            }
            await Task.Delay(100);
        }
        return false;
    }

    private async Task ShowEditorFallbackAsync(string view, string error)
    {
        DesktopFiles.Log($"Neovim window unavailable: {error}");
        if (view == "doctor")
        {
            doctorEditorError = error;
            await OpenDoctorAsync();
        }
        else
        {
            details.Text += $"{Environment.NewLine}Neovim unavailable. {error}";
        }
    }

    private async Task OpenEditorAsync(string view)
    {
        if (openingEditor)
            return;
        openingEditor = true;
        int requestedView = navigationVersion;
        if (view == "doctor" && NativeDoctorOpen)
        {
            try
            {
                bool focused = editorDoctorTitle is { } title && await FocusEditorAsync(title);
                if (IsDisposed || requestedView != navigationVersion)
                    return;
                if (focused)
                    Hide();
                else
                    await ShowEditorFallbackAsync(view,
                        "Windows could not bring the Doctor terminal forward. Look for WSL Cross Hub Doctor in the taskbar.");
            }
            finally { openingEditor = false; }
            return;
        }
        operationNote = "Opening Neovim…";
        RenderMessage();
        try
        {
            var session = await StatusClient.RunAsync<EditorLaunch>("editor-open", shutdown, "-View", view);
            if (IsDisposed)
                return;
            if (view == "doctor")
            {
                editorDoctor?.Dispose();
                editorDoctor = Process.GetProcessById(session.Pid);
                editorDoctorTitle = session.Title;
                doctorEditorError = null;
            }
            if (requestedView == navigationVersion)
            {
                bool focused = await FocusEditorAsync(session.Title);
                if (IsDisposed || requestedView != navigationVersion)
                    return;
                if (focused)
                    Hide();
                else
                    await ShowEditorFallbackAsync(view,
                        $"Windows could not bring the terminal forward. Look for {session.Title} in the taskbar.");
            }
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (IsDisposed || requestedView != navigationVersion)
                return;
            await ShowEditorFallbackAsync(view, error.Message);
        }
        finally
        {
            openingEditor = false;
            operationNote = null;
            if (!IsDisposed)
                RenderMessage();
        }
    }

    private bool HandleDoctorKey(Keys key)
    {
        Control[] order = [doctorCheckSelector, doctorRunnerSelector, doctorCheckNow,
            doctorInvestigate, doctorCure, doctorAutoSelector, doctorJournal];
        var focused = order.FirstOrDefault(control => control.Focused);
        if (focused is ComboBox { DroppedDown: true })
            return false;
        if (key == Keys.Enter && focused is ComboBox selector)
        {
            selector.DroppedDown = selector.Items.Count > 0;
            return true;
        }
        if (key == Keys.Enter && focused is Button button)
        {
            button.PerformClick();
            return true;
        }
        if (key is not (Keys.J or Keys.K or Keys.Up or Keys.Down))
            return false;
        var enabled = order.Where(control => control.Enabled && control.Visible).ToArray();
        if (enabled.Length == 0)
            return false;
        int current = Array.IndexOf(enabled, focused);
        int direction = key is Keys.K or Keys.Up ? -1 : 1;
        int next = current < 0 ? (direction < 0 ? enabled.Length - 1 : 0)
            : (current + direction + enabled.Length) % enabled.Length;
        enabled[next].Focus();
        return true;
    }

    private bool SaveDoctorSettings()
    {
        try
        {
            settings.Save();
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            doctorJobError = $"Could not save Doctor settings. {error.Message}";
            DesktopFiles.Log("could not save Doctor settings");
            return false;
        }
    }

    private static string DoctorRunnerId(ComboBox selector) => selector.SelectedItem switch
    {
        "Dotfiles installer" => "managed",
        string choice => choice.ToLowerInvariant(),
        _ => "off",
    };

    private static string DoctorRunnerLabel(string runner) => runner switch
    {
        "claude" => "Claude",
        "managed" => "Dotfiles installer",
        _ => "Codex",
    };

    private DoctorCheck[] DisplayedDoctorChecks() =>
        [.. doctorReport?.Checks ?? [], .. (doctorReport?.Editors ?? []).Select(check => check.ToDoctorCheck())];

    private async Task OpenDoctorAsync()
    {
        ShowDetails("Doctor");
        doctorDetails = true;
        doctorActions.Show();
        PopulateDoctorChecks();
        RenderDoctorDetails();
        doctorCheckNow.Focus();
        await RefreshDoctorAsync(periodic: false);
        await RefreshDoctorJobAsync();
    }

    private void HideDoctorControls()
    {
        doctorDetails = false;
        doctorActions.Hide();
    }

    private void PopulateDoctorChecks()
    {
        string? selected = (doctorCheckSelector.SelectedItem as DoctorCheck)?.Id;
        var checks = DisplayedDoctorChecks();
        updatingDoctorChecks = true;
        doctorCheckSelector.BeginUpdate();
        try
        {
            doctorCheckSelector.Items.Clear();
            doctorCheckSelector.Items.AddRange(checks);
            var match = Array.FindIndex(checks, check => check.Id == selected);
            if (match < 0)
                match = Array.FindIndex(checks, check => check.State == "failed");
            doctorCheckSelector.SelectedIndex = match < 0 && checks.Length > 0 ? 0 : match;
        }
        finally
        {
            doctorCheckSelector.EndUpdate();
            updatingDoctorChecks = false;
        }
        UpdateDoctorRunners();
    }

    private void UpdateDoctorRunners()
    {
        string selected = DoctorRunnerId(doctorRunnerSelector);
        var runners = (doctorCheckSelector.SelectedItem as DoctorCheck)?.Runners ?? [];
        doctorRunnerSelector.Items.Clear();
        foreach (string runner in runners.Where(runner => runner is "codex" or "claude" or "managed").Distinct())
            doctorRunnerSelector.Items.Add(DoctorRunnerLabel(runner));
        int matching = doctorRunnerSelector.Items.IndexOf(DoctorRunnerLabel(selected));
        doctorRunnerSelector.SelectedIndex = doctorRunnerSelector.Items.Count == 0 ? -1 : Math.Max(0, matching);
        UpdateDoctorActions();
    }

    private void UpdateDoctorActions()
    {
        bool ready = !doctorSubmitting && !CompactionActive && latestDoctorJob?.IsPending != true
            && doctorRunnerSelector.SelectedIndex >= 0 && doctorError is null;
        var check = doctorCheckSelector.SelectedItem as DoctorCheck;
        doctorInvestigate.Enabled = ready && check is { IsEditor: false, State: "failed" or "unavailable" };
        doctorCure.Enabled = ready && check?.State == "failed";
        doctorJournal.Enabled = DoctorJobId is not null;
    }

    private string? DoctorJobId => latestDoctorJob?.Id ?? settings.LastDoctorJobId;

    private void RenderDoctorIndicator()
    {
        var checks = DisplayedDoctorChecks();
        int failed = checks.Count(check => check.State == "failed");
        int unavailable = checks.Count(check => check.State == "unavailable");
        string status = doctorError is not null ? "Checks unavailable"
            : doctorReport?.Checks is not { Length: > 0 } ? "Waiting for checks"
            : failed > 0 ? $"{failed} failed"
            : unavailable > 0 ? $"{unavailable} unavailable" : "Healthy";
        doctorIndicator.Text = $"Doctor · {status}"
            + (doctorCheckedAt is { } checkedAt ? $" · Checked {checkedAt.ToLocalTime():HH:mm}" : "")
            + (latestDoctorJob?.IsPending == true ? $" · Agent job {latestDoctorJob.State}" : "");
        doctorIndicator.ForeColor = failed > 0 || doctorError is not null ? Accent : Secondary;
    }

    private void RenderDoctorDetails()
    {
        if (!doctorDetails || !details.Visible)
            return;
        string automatic = settings.AutoInvestigate == "off"
            ? "Off" : DoctorRunnerLabel(settings.AutoInvestigate);
        var text = new StringBuilder("Doctor").AppendLine().AppendLine()
            .AppendLine(doctorIndicator.Text)
            .AppendLine($"Auto-investigate · {automatic}")
            .AppendLine("j/k or Tab moves between controls. Enter opens a picker or action.")
            .AppendLine();
        if (doctorEditorError is { } editorError)
            text.AppendLine($"Neovim unavailable. {editorError}").AppendLine();
        if (CompactionActive)
            text.AppendLine("Doctor pauses during compaction.").AppendLine();
        if (doctorError is { } error)
            text.AppendLine(error).AppendLine();
        foreach (var check in DisplayedDoctorChecks())
        {
            text.AppendLine(check.ToString()).AppendLine(check.Detail);
            if (!check.IsEditor && check.State != "healthy" && check.Runners is not { Length: > 0 })
                text.AppendLine("No agent runner is available for this check.");
            text.AppendLine();
        }
        if (latestDoctorJob is { } job)
        {
            text.AppendLine($"Latest agent job · {job.State}")
                .AppendLine($"Job ID {job.Id}");
            if (DoctorJobMessage(job.Result) is { } result)
                text.AppendLine(result);
        }
        if (doctorJobError is { } jobError)
            text.AppendLine(jobError);
        string content = text.ToString();
        if (details.Text != content)
        {
            int first = FirstDetailLine;
            details.Text = content;
            ScrollDetails(first - FirstDetailLine);
        }
        UpdateDoctorActions();
    }

    private static string? DoctorJobMessage(JsonElement? result)
    {
        if (result is not { ValueKind: JsonValueKind.Object } body)
            return null;
        var parts = new List<string>();
        foreach (string key in new[] { "outcome", "detail", "error" })
            if (body.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
                && value.GetString() is { Length: > 0 } text && !parts.Contains(text))
                parts.Add(text);
        return parts.Count == 0 ? null : string.Join(Environment.NewLine, parts);
    }

    private async Task RefreshDoctorAsync(bool periodic)
    {
        if (IsDisposed || !Visible || CompactionActive || doctorRefreshing || shutdown.IsCancellationRequested
            || (periodic && (openingEditor || NativeDoctorOpen)))
            return;
        doctorRefreshing = true;
        try
        {
            doctorReport = await StatusClient.RunAsync<DoctorReport>("doctor", shutdown);
            doctorCheckedAt = DateTimeOffset.UtcNow;
            doctorError = null;
            if (doctorReport.LatestJob is { Id: not null } job && !doctorSubmitting
                && latestDoctorJob?.IsPending != true)
                latestDoctorJob = job;
            RenderDoctorIndicator();
            if (doctorDetails)
                PopulateDoctorChecks();
            RenderDoctorDetails();
            string runner = settings.AutoInvestigate;
            if (periodic && runner is ("codex" or "claude")
                && !openingEditor && !NativeDoctorOpen
                && (lastAutomaticObservation is null
                    || DateTimeOffset.UtcNow - lastAutomaticObservation >= TimeSpan.FromSeconds(55)))
            {
                lastAutomaticObservation = DateTimeOffset.UtcNow;
                foreach (var check in doctorReport.Checks ?? [])
                {
                    if (IsDisposed || !Visible || CompactionActive || doctorSubmitting || openingEditor || NativeDoctorOpen
                        || latestDoctorJob?.IsPending == true || settings.AutoInvestigate != runner)
                        break;
                    await SubmitDoctorJobAsync("auto", check, runner);
                }
            }
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (IsDisposed)
                return;
            if (doctorError is null)
                DesktopFiles.Log($"Doctor check unavailable: {error.Message}");
            doctorError = $"Could not read Doctor checks. {error.Message}";
            RenderDoctorIndicator();
            RenderDoctorDetails();
        }
        finally { doctorRefreshing = false; }
    }

    private async Task StartDoctorJobAsync(string mode)
    {
        if (doctorCheckSelector.SelectedItem is not DoctorCheck check
            || doctorRunnerSelector.SelectedIndex < 0 || doctorSubmitting || CompactionActive
            || latestDoctorJob?.IsPending == true || doctorError is not null
            || (mode == "cure" && check.State != "failed") || (mode == "investigate" && check.IsEditor)
            || check.State == "healthy")
            return;
        string runner = DoctorRunnerId(doctorRunnerSelector);
        string task = mode == "cure" ? "Cure" : "Investigate";
        string scope = mode == "cure" ? check.Id switch
        {
            "windows-ssh" => "The Windows recovery task can start OpenSSH and Tailscale if installed.",
            "windows-herdr" => "Cross Hub can start the saved Windows Herdr session.",
            "ubuntu-herdr" => "Cross Hub can start Ubuntu's existing Herdr server.",
            "windows-neovim" => "Install the pinned Windows Neovim release and apply the staged dotfiles config.",
            "ubuntu-neovim" => "Install Neovim with the mise lock and restore the managed dotfiles config link.",
            _ => "Cross Hub can run the approved action for this check.",
        } : "The agent can inspect the failure and suggest a next step.";
        if (MessageBox.Show(this, $"{task} {check.Label} on {check.Host} with {DoctorRunnerLabel(runner)}?\n\n{scope}",
            "Doctor", MessageBoxButtons.OKCancel, MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button2) == DialogResult.OK
            && !doctorSubmitting && !CompactionActive && latestDoctorJob?.IsPending != true)
            await SubmitDoctorJobAsync(mode, check, runner);
    }

    private async Task SubmitDoctorJobAsync(string mode, DoctorCheck check, string runner)
    {
        doctorSubmitting = true;
        doctorJobError = null;
        UpdateDoctorActions();
        try
        {
            var job = await StatusClient.RunAsync<DoctorJob>("doctor-job", shutdown,
                "-Mode", mode, "-CheckId", check.Id, "-Runner", runner);
            if (IsDisposed || string.IsNullOrEmpty(job.Id))
                return;
            latestDoctorJob = job;
            settings.LastDoctorJobId = job.Id;
            SaveDoctorSettings();
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            doctorJobError = $"Could not start Doctor job. {error.Message}";
            DesktopFiles.Log($"Doctor job submission failed for check {check.Id}");
        }
        finally
        {
            doctorSubmitting = false;
            if (!IsDisposed)
            {
                RenderDoctorIndicator();
                RenderDoctorDetails();
            }
        }
    }

    private async Task RefreshDoctorJobAsync()
    {
        if (IsDisposed || !Visible || doctorPolling || doctorSubmitting || shutdown.IsCancellationRequested
            || latestDoctorJob is { IsPending: false } || DoctorJobId is not { } id)
            return;
        doctorPolling = true;
        bool wasPending = latestDoctorJob?.IsPending == true;
        try
        {
            var job = await StatusClient.RunAsync<DoctorJob>("job", shutdown, "-JobId", id);
            if (IsDisposed || DoctorJobId != id)
                return;
            latestDoctorJob = job;
            RenderDoctorIndicator();
            RenderDoctorDetails();
            if (wasPending && !job.IsPending)
                await RefreshDoctorAsync(periodic: false);
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (!IsDisposed)
            {
                doctorJobError = $"Could not read Doctor job. {error.Message}";
                RenderDoctorDetails();
            }
        }
        finally { doctorPolling = false; }
    }

    private async Task OpenDoctorJournalAsync()
    {
        if (DoctorJobId is not { } id)
            return;
        ShowDetails($"Loading Doctor journal for {id}…");
        int view = navigationVersion;
        try
        {
            var journal = await StatusClient.RunAsync<DoctorJournal>("doctor-logs", shutdown, "-JobId", id);
            if (!IsDisposed && navigationVersion == view)
                details.Text = $"Doctor journal · {id}{Environment.NewLine}{Environment.NewLine}"
                    + string.Join(Environment.NewLine, journal.Lines ?? []);
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (!IsDisposed && navigationVersion == view)
                details.Text = $"Could not read Doctor journal for {id}. {error.Message}";
        }
    }
}
