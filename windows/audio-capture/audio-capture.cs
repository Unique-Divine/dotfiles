#:property TargetFramework=net10.0-windows
#:property UseWindowsForms=true
#:property OutputType=WinExe
#:property PublishAot=false
#:property Nullable=enable
#:property ApplicationHighDpiMode=PerMonitorV2

// audio-capture: hotkey audio recorder (system audio + mic -> MP3) that
// survives a mic unplug. See README.md next to this file.

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AudioCapture {

  // ------------------------------------------------------------------
  // Entry point and command line
  // ------------------------------------------------------------------

  static class Program {
    public const string Version = "0.1.0";
    const string MutexName = "Local\\audio-capture-single-instance";

    public static readonly string[] SignalNames =
      { "toggle", "start", "stop", "quit" };

    public static string SignalEventName(string signal) =>
      "Local\\audio-capture-" + signal;

    public const string BusyEventName = "Local\\audio-capture-busy";

    [STAThread]
    static int Main(string[] args) {
      Cli cli;
      try {
        cli = Cli.Parse(args);
      } catch (ArgumentException e) {
        Native.EnsureConsole();
        Console.Error.WriteLine("audio-capture: " + e.Message);
        Console.Error.WriteLine(Cli.Usage);
        return 2;
      }

      switch (cli.Command) {
        case "help":
          Native.EnsureConsole();
          Console.WriteLine(Cli.Usage);
          return 0;
        case "version":
          Native.EnsureConsole();
          Console.WriteLine("audio-capture " + Version);
          return 0;
        case "self-test":
          Native.EnsureConsole();
          return SelfTests.Run();
        case "list-devices":
          Native.EnsureConsole();
          return Commands.ListDevices(cli.ConfigPath);
        case "simulate":
          Native.EnsureConsole();
          return Simulator.Run(cli.Argument!);
        case "recover":
          Native.EnsureConsole();
          return Commands.Recover(cli.ConfigPath, cli.Argument!);
      }

      using var mutex = new Mutex(true, MutexName, out bool isFirst);
      if (!isFirst) {
        // A running instance owns the hotkey: pass the command along.
        string signal = cli.Command == "run" ? "toggle" : cli.Command;
        if (cli.Command == "quit-if-idle") {
          if (Commands.IsBusy()) {
            Native.EnsureConsole();
            Console.Error.WriteLine(
              "audio-capture: recording or saving; not quitting");
            return 3;
          }
          signal = "quit";
        }
        if (!Commands.Signal(signal)) {
          return 1;
        }
        // --quit returns once the running instance has saved and exited,
        // so a build can replace the exe right after.
        return signal == "quit" ? Commands.WaitForExit(mutex) : 0;
      }
      if (cli.Command == "quit-if-idle") {
        return 0; // not running: nothing to stop
      }
      if (cli.Command == "stop" || cli.Command == "quit") {
        Native.EnsureConsole();
        Console.Error.WriteLine("audio-capture: not running");
        return 1;
      }

      Log.Info("app.start", $"audio-capture {Version} started", new {
        version = Version, pid = Environment.ProcessId, command = cli.Command,
      });
      try {
        if (StateDir.MigrateConfig(StateDir.OldConfig, StateDir.Config) is
            string migrated) {
          Log.Info("config.migrated", migrated, new {
            from = StateDir.OldConfig, to = StateDir.Config,
          });
        }
      } catch (IOException e) {
        Log.Warn("config.migrate_failed", e.Message);
      }
      LoadedConfig loaded;
      try {
        loaded = ConfigLoader.Load(cli.ConfigPath);
      } catch (Exception e) {
        Log.Error("config.error", e.Message);
        MessageBox.Show(e.Message, "audio-capture: config error",
          MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
      }

      // Release the caller's stdout/stderr pipes: a resident app holding
      // them would keep a WSL or `just` caller waiting forever.
      Native.DetachStdHandles();
      // Never show WinForms' exception dialog: it would take focus, and
      // its Quit button would end the recording. Log and carry on.
      Application.SetUnhandledExceptionMode(
        UnhandledExceptionMode.CatchException);
      Application.ThreadException += (_, e) =>
        Log.Error("app.ui_exception", e.Exception.Message, new {
          type = e.Exception.GetType().FullName,
          stack = e.Exception.ToString(),
        });
      AppDomain.CurrentDomain.UnhandledException += (_, e) => {
        Log.Error("app.fatal_exception", "unhandled exception", new {
          detail = e.ExceptionObject?.ToString(),
        });
        App.Current?.WriteManifestNow();
      };
      Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      using var app = new App(loaded, cli.ConfigPath);
      bool startNow = cli.Command == "toggle" || cli.Command == "start";
      app.Run(startNow);
      Log.Info("app.exit", "audio-capture exited");
      return 0;
    }
  }

  sealed record Cli(string Command, string? ConfigPath, string? Argument) {
    public const string Usage =
@"usage: audio-capture [command] [--config <path>]

With no command, starts the resident app (hotkey + tray icon). If it is
already running, toggles recording instead.

commands:
  --toggle          start or stop recording (starts the app if needed)
  --start           start recording
  --stop            stop recording and save
  --quit            stop recording if needed, save, and exit
  --quit-if-idle    exit if not recording or saving; else exit code 3
  --list-devices    print FFmpeg, DirectShow devices, and the resolved mic
  --recover <dir>   mix an unfinished session directory into an MP3
  --self-test       run the built-in unit tests
  --simulate <name> run a device scenario with fake mics (generated tones)
                    and check the saved MP3: replug, bump, airpods,
                    console-change, or all
  --version, --help";

    public static Cli Parse(string[] args) {
      string command = "run";
      string? config = null;
      string? argument = null;
      for (int i = 0; i < args.Length; i++) {
        string a = args[i];
        switch (a) {
          case "--config":
            if (i + 1 >= args.Length) {
              throw new ArgumentException("--config needs a path");
            }
            config = args[++i];
            break;
          case "--simulate":
            if (i + 1 >= args.Length) {
              throw new ArgumentException("--simulate needs a scenario: " +
                string.Join(", ", Simulator.Scenarios));
            }
            command = "simulate";
            argument = args[++i];
            break;
          case "--recover":
            if (i + 1 >= args.Length) {
              throw new ArgumentException("--recover needs a directory");
            }
            command = "recover";
            argument = args[++i];
            break;
          case "--toggle": command = "toggle"; break;
          case "--start": command = "start"; break;
          case "--stop": command = "stop"; break;
          case "--quit": command = "quit"; break;
          case "--quit-if-idle": command = "quit-if-idle"; break;
          case "--list-devices": command = "list-devices"; break;
          case "--self-test": command = "self-test"; break;
          case "--version": command = "version"; break;
          case "-h":
          case "--help": command = "help"; break;
          default:
            throw new ArgumentException("unknown argument: " + a);
        }
      }
      return new Cli(command, config, argument);
    }
  }

  static class Commands {
    public static bool Signal(string signal) {
      // The first instance may still be creating its events.
      var deadline = DateTime.UtcNow.AddSeconds(5);
      while (true) {
        if (EventWaitHandle.TryOpenExisting(
            Program.SignalEventName(signal), out var handle)) {
          using (handle) {
            handle.Set();
          }
          return true;
        }
        if (DateTime.UtcNow > deadline) {
          Native.EnsureConsole();
          Console.Error.WriteLine(
            "audio-capture: running instance did not answer");
          return false;
        }
        Thread.Sleep(100);
      }
    }

    public static bool IsBusy() {
      if (!EventWaitHandle.TryOpenExisting(Program.BusyEventName,
          out var busy)) {
        return false;
      }
      using (busy) {
        return busy.WaitOne(0);
      }
    }

    public static int WaitForExit(Mutex mutex) {
      try {
        if (!mutex.WaitOne(TimeSpan.FromMinutes(5))) {
          Native.EnsureConsole();
          Console.Error.WriteLine("audio-capture: still running after 5 min");
          return 1;
        }
      } catch (AbandonedMutexException) {
        // It exited without releasing: still gone.
      }
      mutex.ReleaseMutex();
      return 0;
    }

    public static int ListDevices(string? configPath) {
      try {
        var loaded = ConfigLoader.Load(configPath);
        var cfg = loaded.Config;
        Console.WriteLine("config: " + (loaded.Path ?? "(defaults)"));
        foreach (string w in loaded.Warnings) {
          Console.WriteLine("config warning: " + w);
        }
        string ffmpeg = FfmpegLocator.Find(cfg.Ffmpeg);
        Console.WriteLine("ffmpeg: " + ffmpeg);
        var devices = DirectShow.ListAudio(ffmpeg);
        Console.WriteLine("directshow audio devices:");
        foreach (var d in devices) {
          Console.WriteLine($"  {d.Name}  [{d.AlternativeName}]");
        }
        foreach (var role in new[] { CaptureRole.Communications,
            CaptureRole.Console }) {
          var e = CoreAudio.GetDefaultCapture(role);
          Console.WriteLine($"default {role} recording device: " +
            (e == null ? "(none)" : $"{e.FriendlyName} ({e.Id})"));
        }
        Console.WriteLine("active recording devices:");
        foreach (var e in CoreAudio.ListActiveCapture()) {
          Console.WriteLine($"  {e.FriendlyName} ({e.Id})");
        }
        var policy = MicPolicy.Parse(cfg.Mic, new List<string>());
        using var source = new MMDeviceSource();
        var desired = policy.Desired(source);
        var cache = new DshowCache(() => devices, cfg.System);
        var mic = desired != null ? cache.ForEndpoint(desired)
          : policy.Mode == MicMode.Pinned ? cache.ByName(policy.Name) : null;
        Console.WriteLine($"mic policy: {policy}");
        Console.WriteLine("mic now: " + (mic == null
          ? "(none, would wait)"
          : $"{mic.Display} via {mic.Method} -> {mic.Spec}"));
        var sys = DeviceMatch.ResolveByName(cfg.System, devices);
        Console.WriteLine("system: " + (sys?.Spec ?? "(not found)"));
        Console.WriteLine("output: " + Paths.OutputFile(cfg, DateTime.Now));
        return 0;
      } catch (Exception e) {
        Console.Error.WriteLine("audio-capture: " + e.Message);
        return 1;
      }
    }

    public static int Recover(string? configPath, string dir) {
      try {
        var cfg = ConfigLoader.Load(configPath).Config;
        string ffmpeg = FfmpegLocator.Find(cfg.Ffmpeg);
        if (SessionManifest.SavedPath(dir) is string saved) {
          Console.Error.WriteLine(
            $"audio-capture: {dir} was already saved as {saved}");
          return 1;
        }
        var manifest = SessionManifest.Read(Path.Combine(dir,
          SessionManifest.FileName));
        var segments = manifest.ToSegments(dir);
        string output = Paths.OutputFile(cfg, manifest.StartedLocal);
        var result = Mixer.MixAndVerify(ffmpeg, segments, output, dir,
          manifest.StopAt);
        if (result.Ok) {
          SessionManifest.MarkSaved(dir, result.OutputPath!);
        }
        Console.WriteLine(result.Message);
        return result.Ok ? 0 : 1;
      } catch (Exception e) {
        Console.Error.WriteLine("audio-capture: " + e.Message);
        return 1;
      }
    }
  }

  /// JSON Lines log: one object per event with ts, level, event, msg, and
  /// the event's fields. Rotates at 10 MB, keeping three old files.
  static class Log {
    public const long MaxBytes = 10L * 1024 * 1024;
    const int Keep = 3;
    static readonly object Gate = new();
    // Readable in a terminal: no \u escapes for +, <, >, or quotes.
    static readonly JsonSerializerOptions DataOptions = new() {
      Encoder = System.Text.Encodings.Web.JavaScriptEncoder
        .UnsafeRelaxedJsonEscaping,
    };

    public static string LogDir => StateDir.Logs;

    public static string FilePath => Path.Combine(LogDir, "audio-capture.jsonl");

    public static void Info(string evt, string msg, object? data = null) =>
      Write("info", evt, msg, data);

    public static void Warn(string evt, string msg, object? data = null) =>
      Write("warn", evt, msg, data);

    public static void Error(string evt, string msg, object? data = null) =>
      Write("error", evt, msg, data);

    /// One log line. Fields come from an anonymous object; null fields are
    /// left out.
    public static string Format(DateTimeOffset ts, string level, string evt,
        string msg, object? data) {
      using var stream = new MemoryStream();
      using (var w = new Utf8JsonWriter(stream, new JsonWriterOptions {
          Encoder = DataOptions.Encoder,
        })) {
        w.WriteStartObject();
        w.WriteString("ts", ts.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz",
          CultureInfo.InvariantCulture));
        w.WriteString("level", level);
        w.WriteString("event", evt);
        w.WriteString("msg", msg);
        if (data != null) {
          var element = JsonSerializer.SerializeToElement(data, DataOptions);
          if (element.ValueKind == JsonValueKind.Object) {
            foreach (var prop in element.EnumerateObject()) {
              if (prop.Value.ValueKind == JsonValueKind.Null) {
                continue;
              }
              w.WritePropertyName(prop.Name);
              prop.Value.WriteTo(w);
            }
          }
        }
        w.WriteEndObject();
      }
      return Encoding.UTF8.GetString(stream.ToArray());
    }

    public static void Write(string level, string evt, string msg,
        object? data = null) {
      string line = Format(DateTimeOffset.Now, level, evt, msg, data) +
        Environment.NewLine;
      lock (Gate) {
        try {
          Directory.CreateDirectory(LogDir);
          RotateIfNeeded();
          File.AppendAllText(FilePath, line);
        } catch (IOException) {
          // Logging must never break recording.
        }
      }
    }

    static void RotateIfNeeded() {
      var info = new FileInfo(FilePath);
      if (!info.Exists || info.Length < MaxBytes) {
        return;
      }
      string Old(int i) => Path.Combine(LogDir, $"audio-capture.{i}.jsonl");
      File.Delete(Old(Keep));
      for (int i = Keep - 1; i >= 1; i--) {
        if (File.Exists(Old(i))) {
          File.Move(Old(i), Old(i + 1));
        }
      }
      File.Move(FilePath, Old(1));
    }
  }

  // ------------------------------------------------------------------
  // Config: a TOML subset, herdr-style chords, and path templates
  // ------------------------------------------------------------------

  sealed class TomlException : Exception {
    public TomlException(int line, string message)
      : base($"line {line}: {message}") { }
  }

  /// Reads the TOML subset the config uses: [tables], key = value pairs,
  /// basic and literal strings, integers, floats, booleans, and comments.
  /// Keys come back as "table.key".
  static class Toml {
    public static Dictionary<string, object> Parse(string text) {
      var result = new Dictionary<string, object>(StringComparer.Ordinal);
      string table = "";
      string[] lines = text.Replace("\r\n", "\n").Split('\n');
      for (int n = 0; n < lines.Length; n++) {
        int lineNo = n + 1;
        string line = lines[n].Trim();
        if (line.Length == 0 || line.StartsWith('#')) {
          continue;
        }
        if (line.StartsWith('[')) {
          if (line.StartsWith("[[")) {
            throw new TomlException(lineNo, "arrays of tables unsupported");
          }
          int close = line.IndexOf(']');
          if (close < 0) {
            throw new TomlException(lineNo, "unclosed table header");
          }
          string rest = line[(close + 1)..].Trim();
          if (rest.Length > 0 && !rest.StartsWith('#')) {
            throw new TomlException(lineNo, "text after table header");
          }
          table = line[1..close].Trim();
          if (!Regex.IsMatch(table, @"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$")) {
            throw new TomlException(lineNo, $"bad table name '{table}'");
          }
          continue;
        }
        int eq = line.IndexOf('=');
        if (eq <= 0) {
          throw new TomlException(lineNo, "expected key = value");
        }
        string key = ParseKey(line[..eq].Trim(), lineNo);
        int pos = eq + 1;
        object value = ParseValue(line, ref pos, lineNo);
        string tail = line[pos..].Trim();
        if (tail.Length > 0 && !tail.StartsWith('#')) {
          throw new TomlException(lineNo, "text after value");
        }
        string full = table.Length == 0 ? key : table + "." + key;
        if (result.ContainsKey(full)) {
          throw new TomlException(lineNo, $"duplicate key '{full}'");
        }
        result[full] = value;
      }
      return result;
    }

    static string ParseKey(string raw, int lineNo) {
      if (raw.Length >= 2 && raw[0] == '"' && raw[^1] == '"') {
        return raw[1..^1];
      }
      if (!Regex.IsMatch(raw, @"^[A-Za-z0-9_-]+$")) {
        throw new TomlException(lineNo, $"bad key '{raw}'");
      }
      return raw;
    }

    static object ParseValue(string line, ref int pos, int lineNo) {
      while (pos < line.Length && char.IsWhiteSpace(line[pos])) {
        pos++;
      }
      if (pos >= line.Length) {
        throw new TomlException(lineNo, "missing value");
      }
      char c = line[pos];
      if (c == '"') {
        return ParseBasicString(line, ref pos, lineNo);
      }
      if (c == '\'') {
        int end = line.IndexOf('\'', pos + 1);
        if (end < 0) {
          throw new TomlException(lineNo, "unclosed string");
        }
        string s = line[(pos + 1)..end];
        pos = end + 1;
        return s;
      }
      if (c == '[' || c == '{') {
        throw new TomlException(lineNo, "arrays and inline tables unsupported");
      }
      int start = pos;
      while (pos < line.Length && line[pos] != '#' &&
          !char.IsWhiteSpace(line[pos])) {
        pos++;
      }
      string token = line[start..pos];
      if (token == "true") {
        return true;
      }
      if (token == "false") {
        return false;
      }
      string digits = token.Replace("_", "");
      if (long.TryParse(digits, NumberStyles.AllowLeadingSign,
          CultureInfo.InvariantCulture, out long l)) {
        return l;
      }
      if (double.TryParse(digits, NumberStyles.Float,
          CultureInfo.InvariantCulture, out double d)) {
        return d;
      }
      throw new TomlException(lineNo,
        $"bad value '{token}' (strings need quotes)");
    }

    static string ParseBasicString(string line, ref int pos, int lineNo) {
      var sb = new StringBuilder();
      pos++;
      while (pos < line.Length) {
        char c = line[pos++];
        if (c == '"') {
          return sb.ToString();
        }
        if (c != '\\') {
          sb.Append(c);
          continue;
        }
        if (pos >= line.Length) {
          break;
        }
        char e = line[pos++];
        switch (e) {
          case 'n': sb.Append('\n'); break;
          case 't': sb.Append('\t'); break;
          case 'r': sb.Append('\r'); break;
          case '"': sb.Append('"'); break;
          case '\\': sb.Append('\\'); break;
          case 'u':
            if (pos + 4 > line.Length) {
              throw new TomlException(lineNo, "short \\u escape");
            }
            sb.Append((char)Convert.ToInt32(line.Substring(pos, 4), 16));
            pos += 4;
            break;
          default:
            throw new TomlException(lineNo, $"unknown escape \\{e}");
        }
      }
      throw new TomlException(lineNo, "unclosed string");
    }
  }

  /// A global hotkey in herdr's chord syntax, e.g. "ctrl+alt+f2".
  sealed record Chord(uint Modifiers, uint VirtualKey, string Text) {
    public const uint ModAlt = 0x1;
    public const uint ModControl = 0x2;
    public const uint ModShift = 0x4;
    public const uint ModWin = 0x8;

    static readonly Dictionary<string, uint> NamedKeys = new() {
      ["space"] = 0x20, ["enter"] = 0x0D, ["return"] = 0x0D, ["tab"] = 0x09,
      ["esc"] = 0x1B, ["escape"] = 0x1B, ["backspace"] = 0x08,
      ["insert"] = 0x2D, ["delete"] = 0x2E, ["home"] = 0x24, ["end"] = 0x23,
      ["pageup"] = 0x21, ["pagedown"] = 0x22, ["left"] = 0x25, ["up"] = 0x26,
      ["right"] = 0x27, ["down"] = 0x28, ["pause"] = 0x13,
      ["printscreen"] = 0x2C, ["minus"] = 0xBD, ["plus"] = 0xBB,
      ["equal"] = 0xBB, ["comma"] = 0xBC, ["period"] = 0xBE,
      ["slash"] = 0xBF, ["backtick"] = 0xC0, ["semicolon"] = 0xBA,
      ["quote"] = 0xDE, ["leftbracket"] = 0xDB, ["backslash"] = 0xDC,
      ["rightbracket"] = 0xDD,
    };

    public static Chord Parse(string text) {
      string trimmed = text.Trim();
      if (trimmed.Length == 0) {
        throw new FormatException("empty key chord");
      }
      uint mods = 0;
      uint? key = null;
      foreach (string rawPart in trimmed.Split('+')) {
        string part = rawPart.Trim();
        string lower = part.ToLowerInvariant();
        switch (lower) {
          case "ctrl":
          case "control": mods |= ModControl; continue;
          case "alt":
          case "option": mods |= ModAlt; continue;
          case "shift": mods |= ModShift; continue;
          case "win":
          case "super":
          case "cmd": mods |= ModWin; continue;
          case "prefix":
            throw new FormatException(
              "'prefix' is a herdr mode; use a direct chord like ctrl+f2");
          case "":
            throw new FormatException(
              $"empty key in '{text}' (write + as 'plus')");
        }
        if (key != null) {
          throw new FormatException($"more than one key in '{text}'");
        }
        key = KeyCode(part, ref mods, text);
      }
      if (key == null) {
        throw new FormatException($"no key in '{text}', only modifiers");
      }
      return new Chord(mods, key.Value, trimmed);
    }

    static uint KeyCode(string part, ref uint mods, string text) {
      string lower = part.ToLowerInvariant();
      if (part.Length == 1 && char.IsAsciiLetter(part[0])) {
        // herdr reads "prefix+A" as shift+a.
        if (char.IsUpper(part[0])) {
          mods |= ModShift;
        }
        return (uint)char.ToUpperInvariant(part[0]);
      }
      if (part.Length == 1 && char.IsAsciiDigit(part[0])) {
        return part[0];
      }
      var fkey = Regex.Match(lower, @"^f([1-9]|1[0-9]|2[0-4])$");
      if (fkey.Success) {
        return 0x70u + uint.Parse(fkey.Groups[1].Value) - 1;
      }
      if (NamedKeys.TryGetValue(lower, out uint vk)) {
        return vk;
      }
      throw new FormatException($"unknown key '{part}' in '{text}'");
    }
  }

  static class Templates {
    static readonly Dictionary<string, Environment.SpecialFolder> Folders =
      new() {
        ["documents"] = Environment.SpecialFolder.MyDocuments,
        ["music"] = Environment.SpecialFolder.MyMusic,
        ["videos"] = Environment.SpecialFolder.MyVideos,
        ["desktop"] = Environment.SpecialFolder.DesktopDirectory,
        ["home"] = Environment.SpecialFolder.UserProfile,
        ["appdata"] = Environment.SpecialFolder.ApplicationData,
        ["localappdata"] = Environment.SpecialFolder.LocalApplicationData,
      };

    public static string FolderPath(string name) =>
      Folders.TryGetValue(name, out var f)
        ? Environment.GetFolderPath(f)
        : throw new KeyNotFoundException(name);

    /// Replaces {folder} names (documents, music, ...) and treats any other
    /// {token} as a .NET date format, e.g. {yyyy-MM} or {HHmmss}.
    public static string Expand(string template, DateTime now,
        Func<string, string> folder) {
      var sb = new StringBuilder();
      int i = 0;
      while (i < template.Length) {
        char c = template[i];
        if (c == '}') {
          throw new FormatException($"stray '}}' in '{template}'");
        }
        if (c != '{') {
          sb.Append(c);
          i++;
          continue;
        }
        int close = template.IndexOf('}', i + 1);
        if (close < 0) {
          throw new FormatException($"unclosed '{{' in '{template}'");
        }
        string token = template[(i + 1)..close];
        if (token.Length == 0) {
          throw new FormatException($"empty {{}} in '{template}'");
        }
        if (Folders.ContainsKey(token.ToLowerInvariant())) {
          sb.Append(folder(token.ToLowerInvariant()));
        } else {
          if (!Regex.IsMatch(token, @"^[yMdHhmsf\-_.]+$")) {
            throw new FormatException(
              $"unknown token {{{token}}} in '{template}'");
          }
          sb.Append(now.ToString(token, CultureInfo.InvariantCulture));
        }
        i = close + 1;
      }
      return sb.ToString();
    }
  }

  enum PillPosition {
    BottomRight, BottomLeft, BottomCenter, TopRight, TopLeft, TopCenter
  }

  sealed partial record AppConfig {
    public Chord Toggle { get; init; } = Chord.Parse("ctrl+alt+f2");
    public PillPosition Position { get; init; } = PillPosition.BottomRight;
    public string Monitor { get; init; } = "primary";
    public string OutputDir { get; init; } =
      "{documents}/ShareX/Screenshots/{yyyy-MM}";
    public string OutputName { get; init; } = "{yy-MM-dd}__{HHmmss}-audio.mp3";
    public string System { get; init; } = "virtual-audio-capturer";
    public string Mic { get; init; } = "communications";
    public string Ffmpeg { get; init; } = "";
    public bool KeepSession { get; init; }
    public static readonly Color DefaultDotColor = Color.FromArgb(255, 69, 58);
    public Color DotColor { get; init; } = DefaultDotColor;

    static readonly string[] KnownKeys = {
      "keys.toggle", "pill.position", "pill.monitor", "pill.dot_color",
      "output.dir",
      "output.name", "audio.system", "audio.mic", "audio.ffmpeg",
      "debug.keep_session",
    };

    public static (AppConfig, List<string>) FromToml(string text) {
      var values = Toml.Parse(text);
      var warnings = new List<string>();
      foreach (string k in values.Keys) {
        if (!KnownKeys.Contains(k)) {
          warnings.Add($"unknown key '{k}' ignored");
        }
      }
      var cfg = new AppConfig();
      string Str(string key, string fallback) {
        if (!values.TryGetValue(key, out object? v)) {
          return fallback;
        }
        return v as string ?? throw new FormatException(
          $"{key} must be a quoted string");
      }
      try {
        cfg = cfg with { Toggle = Chord.Parse(Str("keys.toggle",
          cfg.Toggle.Text)) };
      } catch (FormatException e) {
        throw new FormatException("keys.toggle: " + e.Message);
      }
      string pos = Str("pill.position", "bottom-right");
      cfg = cfg with {
        Position = pos switch {
          "bottom-right" => PillPosition.BottomRight,
          "bottom-left" => PillPosition.BottomLeft,
          "bottom-center" => PillPosition.BottomCenter,
          "top-right" => PillPosition.TopRight,
          "top-left" => PillPosition.TopLeft,
          "top-center" => PillPosition.TopCenter,
          _ => throw new FormatException(
            $"pill.position '{pos}' must be bottom-right, bottom-left, " +
            "bottom-center, top-right, top-left, or top-center"),
        },
      };
      string monitor = Str("pill.monitor", cfg.Monitor);
      if (monitor != "primary" && monitor != "cursor") {
        throw new FormatException(
          $"pill.monitor '{monitor}' must be primary or cursor");
      }
      cfg = cfg with {
        Monitor = monitor,
        OutputDir = Str("output.dir", cfg.OutputDir),
        OutputName = Str("output.name", cfg.OutputName),
        System = Str("audio.system", cfg.System),
        Mic = Str("audio.mic", cfg.Mic),
        Ffmpeg = Str("audio.ffmpeg", cfg.Ffmpeg),
      };
      string dot = Str("pill.dot_color", "");
      if (dot.Length > 0) {
        Color? parsed = ParseHexColor(dot);
        if (parsed == null) {
          warnings.Add($"pill.dot_color '{dot}' is not #RRGGBB; using default");
        } else {
          cfg = cfg with { DotColor = parsed.Value };
        }
      }
      if (values.TryGetValue("debug.keep_session", out object? keep)) {
        cfg = cfg with {
          KeepSession = keep as bool? ?? throw new FormatException(
            "debug.keep_session must be true or false"),
        };
      }
      MicPolicy.Parse(cfg.Mic, warnings);
      // Fail at load time, not at the end of a recording.
      Templates.Expand(cfg.OutputDir, DateTime.Now, _ => "x");
      Templates.Expand(cfg.OutputName, DateTime.Now, _ => "x");
      return (cfg, warnings);
    }
  }

  partial record AppConfig {
    /// "#RRGGBB" to a color, or null if malformed.
    public static Color? ParseHexColor(string s) {
      var m = Regex.Match(s.Trim(), "^#([0-9a-fA-F]{6})$");
      if (!m.Success) {
        return null;
      }
      int v = Convert.ToInt32(m.Groups[1].Value, 16);
      return Color.FromArgb(255, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
    }
  }

  sealed record LoadedConfig(AppConfig Config, string? Path,
    List<string> Warnings);

  /// Where the app keeps its files: %USERPROFILE%\.audio-capture\, like a
  /// dot directory on Linux. config.toml, logs\, sessions\, simulate\.
  static class StateDir {
    public static string Root => Path.Combine(Environment.GetFolderPath(
      Environment.SpecialFolder.UserProfile), ".audio-capture");
    public static string Config => Path.Combine(Root, "config.toml");
    public static string Logs => Path.Combine(Root, "logs");
    public static string Sessions => Path.Combine(Root, "sessions");
    public static string Simulate => Path.Combine(Root, "simulate");

    /// The config location before 2026-11-13.
    public static string OldConfig => Path.Combine(Environment.GetFolderPath(
      Environment.SpecialFolder.ApplicationData), "audio-capture",
      "audio-capture.toml");

    /// Copies a config from the old location if config.toml doesn't exist
    /// yet. The old file stays in place. A v1 `mic = "default"` becomes
    /// "communications", which is what "default" now means anyway.
    /// Returns a message for the log, or null if nothing happened.
    public static string? MigrateConfig(string oldPath, string newPath) {
      if (File.Exists(newPath) || !File.Exists(oldPath)) {
        return null;
      }
      string text = File.ReadAllText(oldPath);
      string migrated = MigrateText(text);
      Directory.CreateDirectory(Path.GetDirectoryName(newPath)!);
      File.WriteAllText(newPath, migrated);
      return $"copied {oldPath} to {newPath}" + (migrated != text
        ? "; mic = \"default\" became \"communications\"" : "");
    }

    public static string MigrateText(string text) => Regex.Replace(text,
      @"^(\s*mic\s*=\s*)""default""", "$1\"communications\"",
      RegexOptions.Multiline);
  }

  static class ConfigLoader {
    public const string FileName = "audio-capture.toml";

    public static IEnumerable<string> Candidates(string? explicitPath) {
      if (explicitPath != null) {
        yield return explicitPath;
        yield break;
      }
      yield return StateDir.Config;
      yield return Path.Combine(AppContext.BaseDirectory, FileName);
    }

    public static LoadedConfig Load(string? explicitPath) {
      foreach (string path in Candidates(explicitPath)) {
        if (!File.Exists(path)) {
          if (explicitPath != null) {
            throw new FileNotFoundException("config not found: " + path);
          }
          continue;
        }
        try {
          var (cfg, warnings) = AppConfig.FromToml(File.ReadAllText(path));
          return new LoadedConfig(cfg, path, warnings);
        } catch (Exception e) when (e is FormatException or TomlException) {
          throw new FormatException($"{path}: {e.Message}");
        }
      }
      return new LoadedConfig(new AppConfig(), null, new List<string>());
    }
  }

  static class Paths {
    public static string OutputFile(AppConfig cfg, DateTime when) {
      string dir = Templates.Expand(cfg.OutputDir, when, Templates.FolderPath);
      string name = Templates.Expand(cfg.OutputName, when,
        Templates.FolderPath);
      dir = Environment.ExpandEnvironmentVariables(dir);
      return Path.GetFullPath(Path.Combine(dir, name));
    }

    /// Adds -2, -3, ... before the extension until the name is free.
    public static string Unique(string path, Func<string, bool> exists) {
      if (!exists(path)) {
        return path;
      }
      string dir = Path.GetDirectoryName(path) ?? "";
      string stem = Path.GetFileNameWithoutExtension(path);
      string ext = Path.GetExtension(path);
      for (int i = 2; ; i++) {
        string candidate = Path.Combine(dir, $"{stem}-{i}{ext}");
        if (!exists(candidate)) {
          return candidate;
        }
      }
    }

    public static string SessionsDir => StateDir.Sessions;
  }

  // ------------------------------------------------------------------
  // Devices: DirectShow names, the Windows default mic, and matching
  // ------------------------------------------------------------------

  sealed record DshowDevice(string Name, string? AlternativeName);

  sealed record Endpoint(string Id, string FriendlyName, int State);

  /// What FFmpeg opens: Spec goes after "audio=".
  sealed record DeviceTarget(string Spec, string Display, string Method,
    string? EndpointId);

  static class DirectShow {
    public static List<DshowDevice> Parse(string ffmpegOutput) {
      var devices = new List<DshowDevice>();
      string? pending = null;
      foreach (string line in ffmpegOutput.Split('\n')) {
        var audio = Regex.Match(line, "\"(?<name>[^\"]+)\"\\s+\\(audio\\)");
        if (audio.Success) {
          if (pending != null) {
            devices.Add(new DshowDevice(pending, null));
          }
          pending = audio.Groups["name"].Value;
          continue;
        }
        if (Regex.IsMatch(line, "\"[^\"]+\"\\s+\\((video|none)\\)")) {
          if (pending != null) {
            devices.Add(new DshowDevice(pending, null));
          }
          pending = null;
          continue;
        }
        if (pending != null) {
          var alt = Regex.Match(line,
            "Alternative name\\s+\"(?<name>[^\"]+)\"");
          if (alt.Success) {
            devices.Add(new DshowDevice(pending, alt.Groups["name"].Value));
            pending = null;
          }
        }
      }
      if (pending != null) {
        devices.Add(new DshowDevice(pending, null));
      }
      return devices;
    }

    public static List<DshowDevice> ListAudio(string ffmpeg) {
      var run = Proc.Run(ffmpeg, new[] {
        "-hide_banner", "-nostdin", "-list_devices", "true", "-f", "dshow",
        "-i", "dummy",
      }, 15000);
      return Parse(run.Stdout + "\n" + run.Stderr);
    }
  }

  static class DeviceMatch {
    static readonly Regex GuidPattern = new(
      "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-" +
      "[0-9a-fA-F]{12}");

    /// The last GUID in an endpoint ID ({0.0.1.00000000}.{guid}) or a
    /// DirectShow alternative name (@device_cm_{category}\wave_{guid}).
    public static string? LastGuid(string? s) {
      if (string.IsNullOrEmpty(s)) {
        return null;
      }
      var all = GuidPattern.Matches(s);
      return all.Count == 0 ? null : all[^1].Value.ToLowerInvariant();
    }

    /// Lowercase alphanumerics, without a "2- " style prefix that Windows
    /// adds when two devices share a name.
    public static string NormalizeName(string s) {
      string stripped = Regex.Replace(s.Trim(), @"^\d+-\s*", "");
      return Regex.Replace(stripped.ToLowerInvariant(), "[^a-z0-9]", "");
    }

    static DeviceTarget Target(DshowDevice d, string method, string? id) =>
      new(d.AlternativeName ?? d.Name, d.Name, method, id);

    public static DeviceTarget? ResolveByName(string name,
        IReadOnlyList<DshowDevice> devices) {
      foreach (var d in devices) {
        if (string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(d.AlternativeName, name,
              StringComparison.OrdinalIgnoreCase)) {
          // virtual-audio-capturer is a software filter: its name is stable.
          return new DeviceTarget(d.Name, d.Name, "Name", null);
        }
      }
      return null;
    }

    /// The DirectShow device for a Windows endpoint: by the GUID shared by
    /// the endpoint ID and the DirectShow alternative name, then by name.
    public static DeviceTarget? ForEndpoint(Endpoint e,
        IReadOnlyList<DshowDevice> devices, string systemName) {
      var eligible = devices.Where(d => !string.Equals(d.Name, systemName,
        StringComparison.OrdinalIgnoreCase)).ToList();
      string? guid = LastGuid(e.Id);
      DeviceTarget Make(DshowDevice d, string method) =>
        new(d.AlternativeName ?? d.Name, e.FriendlyName, method, e.Id);
      if (guid != null) {
        var byGuid = eligible.Where(d =>
          LastGuid(d.AlternativeName) == guid).ToList();
        if (byGuid.Count == 1) {
          return Make(byGuid[0], "EndpointGuid");
        }
      }
      var byName = eligible.Where(d => string.Equals(d.Name, e.FriendlyName,
        StringComparison.OrdinalIgnoreCase)).ToList();
      if (byName.Count == 1) {
        return Make(byName[0], "FriendlyName");
      }
      var byNorm = eligible.Where(d => NormalizeName(d.Name) ==
        NormalizeName(e.FriendlyName)).ToList();
      return byNorm.Count == 1 ? Make(byNorm[0], "NormalizedName") : null;
    }

    /// A pinned mic by its DirectShow name, when no endpoint matches it.
    public static DeviceTarget? ByName(string name,
        IReadOnlyList<DshowDevice> devices, string systemName) {
      var eligible = devices.Where(d => !string.Equals(d.Name, systemName,
        StringComparison.OrdinalIgnoreCase)).ToList();
      var d = eligible.FirstOrDefault(x =>
          string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase) ||
          string.Equals(x.AlternativeName, name,
            StringComparison.OrdinalIgnoreCase))
        ?? eligible.FirstOrDefault(x =>
          NormalizeName(x.Name) == NormalizeName(name));
      return d == null ? null
        : new DeviceTarget(d.AlternativeName ?? d.Name, d.Name, "DshowName",
          null);
    }

    /// "Yeti Microphone - Main (Yeti Stereo Microphone)" -> "Yeti
    /// Microphone - Main"; "Microphone (Surface Stereo Microphones)" ->
    /// "Surface Stereo Microphones". For the pill's switch label.
    public static string ShortName(string name) {
      var m = Regex.Match(name.Trim(), @"^(?<head>.*?)\s*\((?<inner>[^()]*)\)$");
      if (!m.Success) {
        return name.Trim();
      }
      string head = Regex.Replace(m.Groups["head"].Value, @"^\d+-\s*", "");
      bool generic = Regex.IsMatch(head,
        @"^(microphone( array)?|headset( microphone)?|mic|line in|" +
        @"external mic|headset mic|hands-free.*)$", RegexOptions.IgnoreCase);
      return generic || head.Length == 0 ? m.Groups["inner"].Value : head;
    }
  }

  /// Windows' two default-recording-device roles. Sound settings calls
  /// them "Default Device" (eConsole: most apps) and "Default Communication
  /// Device" (eCommunications: call apps like Zoom and Teams).
  enum CaptureRole { Console = 0, Communications = 2 }

  /// Recording endpoints and changes to them. MMDeviceSource is the real
  /// one; FakeEndpointSource scripts devices for tests.
  interface IEndpointSource : IDisposable {
    /// The default recording endpoint for a role, or null if none.
    Endpoint? GetDefault(CaptureRole role);
    /// DEVICE_STATE_* for an endpoint ID, or -1 if unknown.
    int GetState(string id);
    IReadOnlyList<Endpoint> ListActive();
    /// Fires on any thread when a default, a state, or the device set
    /// changes. The string says what happened, for the log.
    event Action<string>? Changed;
  }

  static class CoreAudio {
    public const int DeviceStateActive = 1;
    public const int DeviceStateNotPresent = 4;
    public const int DeviceStateUnplugged = 8;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator {
      int EnumAudioEndpoints(int flow, int stateMask,
        out IMMDeviceCollection devices);
      int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
      int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id,
        out IMMDevice device);
      int RegisterEndpointNotificationCallback(IMMNotificationClient client);
      int UnregisterEndpointNotificationCallback(
        IMMNotificationClient client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection {
      int GetCount(out int count);
      int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice {
      int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
        [MarshalAs(UnmanagedType.IUnknown)] out object result);
      int OpenPropertyStore(int access, out IPropertyStore store);
      int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
      int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore {
      int GetCount(out int count);
      int GetAt(int index, out PropertyKey key);
      int GetValue(ref PropertyKey key, out PropVariant value);
    }

    [ComImport, Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMNotificationClient {
      void OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id,
        int newState);
      void OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
      void OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
      void OnDefaultDeviceChanged(int flow, int role,
        [MarshalAs(UnmanagedType.LPWStr)] string? defaultId);
      void OnPropertyValueChanged(
        [MarshalAs(UnmanagedType.LPWStr)] string id, PropertyKey key);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey {
      public Guid FormatId;
      public int PropertyId;
    }

    /// PROPVARIANT is 24 bytes on 64-bit Windows (16 on 32-bit); the
    /// callee writes all of it, so the struct must be that big.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct PropVariant {
      [FieldOffset(0)] public ushort VarType;
      [FieldOffset(8)] public IntPtr Pointer;
    }

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PropVariant value);

    internal static int PropVariantSize => Marshal.SizeOf<PropVariant>();

    internal static IMMDeviceEnumerator Enumerator() =>
      (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();

    /// Releases COM objects now instead of at some later GC, since the
    /// app queries these for hours.
    internal static void Release(params object?[] objects) {
      foreach (object? o in objects) {
        if (o != null && Marshal.IsComObject(o)) {
          Marshal.ReleaseComObject(o);
        }
      }
    }

    static Endpoint Describe(IMMDevice device) {
      Marshal.ThrowExceptionForHR(device.GetId(out string id));
      Marshal.ThrowExceptionForHR(device.GetState(out int state));
      IPropertyStore? store = null;
      try {
        Marshal.ThrowExceptionForHR(device.OpenPropertyStore(0, out store));
        var key = new PropertyKey {
          FormatId = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
          PropertyId = 14, // PKEY_Device_FriendlyName
        };
        Marshal.ThrowExceptionForHR(store.GetValue(ref key, out var value));
        string name = value.Pointer == IntPtr.Zero
          ? ""
          : Marshal.PtrToStringUni(value.Pointer) ?? "";
        PropVariantClear(ref value);
        return new Endpoint(id, name, state);
      } finally {
        Release(store);
      }
    }

    /// The default recording endpoint for a role, or null if there is none.
    public static Endpoint? GetDefaultCapture(CaptureRole role) {
      var enumerator = Enumerator();
      IMMDevice? device = null;
      try {
        // eCapture = 1. E_NOTFOUND when no recording device exists.
        if (enumerator.GetDefaultAudioEndpoint(1, (int)role, out device) != 0) {
          return null;
        }
        return Describe(device);
      } finally {
        Release(device, enumerator);
      }
    }

    public static int GetState(string id) {
      var enumerator = Enumerator();
      IMMDevice? device = null;
      try {
        if (enumerator.GetDevice(id, out device) != 0) {
          return -1;
        }
        return device.GetState(out int state) == 0 ? state : -1;
      } catch (COMException) {
        return -1;
      } finally {
        Release(device, enumerator);
      }
    }

    public static List<Endpoint> ListActiveCapture() {
      var result = new List<Endpoint>();
      var enumerator = Enumerator();
      IMMDeviceCollection? collection = null;
      try {
        // eCapture = 1, DEVICE_STATE_ACTIVE = 1
        Marshal.ThrowExceptionForHR(
          enumerator.EnumAudioEndpoints(1, 1, out collection));
        Marshal.ThrowExceptionForHR(collection.GetCount(out int count));
        for (int i = 0; i < count; i++) {
          IMMDevice? device = null;
          try {
            Marshal.ThrowExceptionForHR(collection.Item(i, out device));
            result.Add(Describe(device));
          } finally {
            Release(device);
          }
        }
      } finally {
        Release(collection, enumerator);
      }
      return result;
    }
  }

  /// Receives MMDevice notifications. Windows calls it on its own threads,
  /// so it only forwards a description.
  [ComVisible(true)]
  sealed class EndpointNotifications : CoreAudio.IMMNotificationClient {
    readonly Action<string> forward;

    public EndpointNotifications(Action<string> forward) {
      this.forward = forward;
    }

    public void OnDeviceStateChanged(string id, int newState) =>
      forward($"state {newState} for {id}");

    public void OnDeviceAdded(string id) => forward("added " + id);

    public void OnDeviceRemoved(string id) => forward("removed " + id);

    public void OnDefaultDeviceChanged(int flow, int role, string? defaultId) {
      if (flow == 1) { // eCapture
        forward($"default {(CaptureRole)role} capture is {defaultId ?? "none"}");
      }
    }

    public void OnPropertyValueChanged(string id,
        CoreAudio.PropertyKey key) {
      // Fires constantly (volume, format); defaults and states are enough.
    }
  }

  sealed class MMDeviceSource : IEndpointSource {
    readonly CoreAudio.IMMDeviceEnumerator? notifier;
    readonly EndpointNotifications? client;
    readonly System.Threading.Timer? poll;
    string lastDefaults = "";

    public event Action<string>? Changed;
    public bool UsesNotifications => client != null;

    public MMDeviceSource() {
      try {
        var enumerator = CoreAudio.Enumerator();
        var c = new EndpointNotifications(e => Changed?.Invoke(e));
        int hr = enumerator.RegisterEndpointNotificationCallback(c);
        if (hr != 0) {
          Marshal.ThrowExceptionForHR(hr);
        }
        notifier = enumerator;
        client = c;
      } catch (Exception e) {
        // Fall back to checking the defaults once a second.
        Log.Warn("devices.polling",
          "endpoint notifications unavailable; polling defaults every 1 s",
          new { error = e.Message });
        lastDefaults = DefaultsKey();
        poll = new System.Threading.Timer(_ => {
          string now = DefaultsKey();
          if (now != lastDefaults) {
            lastDefaults = now;
            Changed?.Invoke("poll: defaults now " + now);
          }
        }, null, 1000, 1000);
      }
    }

    static string DefaultsKey() {
      try {
        return (CoreAudio.GetDefaultCapture(CaptureRole.Console)?.Id ?? "-") +
          "|" + (CoreAudio.GetDefaultCapture(CaptureRole.Communications)?.Id
            ?? "-");
      } catch (Exception) {
        return "error";
      }
    }

    public Endpoint? GetDefault(CaptureRole role) =>
      CoreAudio.GetDefaultCapture(role);

    public int GetState(string id) => CoreAudio.GetState(id);

    public IReadOnlyList<Endpoint> ListActive() =>
      CoreAudio.ListActiveCapture();

    public void Dispose() {
      poll?.Dispose();
      if (notifier != null && client != null) {
        try {
          notifier.UnregisterEndpointNotificationCallback(client);
        } catch (Exception) {
        }
        CoreAudio.Release(notifier);
      }
    }
  }

  /// A scripted set of recording endpoints for tests and --simulate.
  sealed class FakeEndpointSource : IEndpointSource {
    readonly object gate = new();
    readonly Dictionary<string, Endpoint> devices = new();
    readonly Dictionary<CaptureRole, string?> defaults = new();

    public event Action<string>? Changed;

    public void Add(string id, string name) {
      lock (gate) {
        devices[id] = new Endpoint(id, name, CoreAudio.DeviceStateActive);
      }
      Changed?.Invoke("added " + id);
    }

    public void SetState(string id, int state) {
      lock (gate) {
        devices[id] = devices[id] with { State = state };
      }
      Changed?.Invoke($"state {state} for {id}");
    }

    public void SetDefault(CaptureRole role, string? id) {
      lock (gate) {
        defaults[role] = id;
      }
      Changed?.Invoke($"default {role} capture is {id ?? "none"}");
    }

    public Endpoint? GetDefault(CaptureRole role) {
      lock (gate) {
        return defaults.TryGetValue(role, out string? id) && id != null &&
          devices.TryGetValue(id, out var e) ? e : null;
      }
    }

    public int GetState(string id) {
      lock (gate) {
        return devices.TryGetValue(id, out var e) ? e.State : -1;
      }
    }

    public IReadOnlyList<Endpoint> ListActive() {
      lock (gate) {
        return devices.Values
          .Where(e => e.State == CoreAudio.DeviceStateActive).ToList();
      }
    }

    public void Dispose() { }
  }

  enum MicMode { Communications, DefaultDevice, Pinned, None }

  /// Which mic to record: follow one of Windows' default roles, or pin a
  /// device by name.
  sealed record MicPolicy(MicMode Mode, string Name) {
    public static MicPolicy Parse(string setting, List<string> warnings) {
      string s = setting.Trim();
      switch (s.ToLowerInvariant()) {
        case "communications":
          return new MicPolicy(MicMode.Communications, "");
        case "default-device":
          return new MicPolicy(MicMode.DefaultDevice, "");
        case "default":
          warnings.Add("audio.mic \"default\" is ambiguous; following the " +
            "Default Communication Device. Write \"communications\" or " +
            "\"default-device\".");
          return new MicPolicy(MicMode.Communications, "");
        case "":
        case "none":
          return new MicPolicy(MicMode.None, "");
        default:
          return new MicPolicy(MicMode.Pinned, s);
      }
    }

    public CaptureRole? Role => Mode switch {
      MicMode.Communications => CaptureRole.Communications,
      MicMode.DefaultDevice => CaptureRole.Console,
      _ => null,
    };

    public override string ToString() => Mode switch {
      MicMode.Pinned => $"pinned to \"{Name}\"",
      MicMode.None => "none",
      _ => $"follow {Role} default",
    };

    /// The endpoint the mic should be on right now, or null to wait.
    public Endpoint? Desired(IEndpointSource source) {
      if (Role is CaptureRole role) {
        var e = source.GetDefault(role);
        return e != null && e.State == CoreAudio.DeviceStateActive ? e : null;
      }
      if (Mode != MicMode.Pinned) {
        return null;
      }
      var active = source.ListActive();
      return active.FirstOrDefault(e => string.Equals(e.FriendlyName, Name,
          StringComparison.OrdinalIgnoreCase))
        ?? active.FirstOrDefault(e => DeviceMatch.NormalizeName(
          e.FriendlyName) == DeviceMatch.NormalizeName(Name));
    }
  }

  /// Maps endpoints to something FFmpeg can open.
  interface IDeviceResolver {
    DeviceTarget? ForEndpoint(Endpoint e);
    DeviceTarget? ByName(string name);
  }

  /// For --simulate: every fake endpoint is an FFmpeg lavfi tone.
  sealed class FakeResolver : IDeviceResolver {
    readonly Func<Endpoint, string?> lavfi;

    public FakeResolver(Func<Endpoint, string?> lavfi) {
      this.lavfi = lavfi;
    }

    public DeviceTarget? ForEndpoint(Endpoint e) =>
      lavfi(e) is string expr
        ? new DeviceTarget("lavfi:" + expr, e.FriendlyName, "Fake", e.Id)
        : null;

    public DeviceTarget? ByName(string name) => null;
  }

  /// DirectShow names for endpoints. FFmpeg lists devices only when an
  /// endpoint isn't in the cached list, not on a timer.
  sealed class DshowCache : IDeviceResolver {
    readonly Func<List<DshowDevice>> list;
    readonly string systemName;
    List<DshowDevice>? devices;

    public DshowCache(Func<List<DshowDevice>> list, string systemName) {
      this.list = list;
      this.systemName = systemName;
    }

    public int Refreshes { get; private set; }

    List<DshowDevice> Refresh() {
      Refreshes++;
      devices = list();
      return devices;
    }

    public DeviceTarget? ForEndpoint(Endpoint e) {
      bool fresh = devices == null;
      var t = DeviceMatch.ForEndpoint(e, devices ?? Refresh(), systemName);
      if (t == null && !fresh) {
        t = DeviceMatch.ForEndpoint(e, Refresh(), systemName);
      }
      return t;
    }

    public DeviceTarget? ByName(string name) {
      var t = DeviceMatch.ByName(name, devices ?? Refresh(), systemName);
      return t ?? DeviceMatch.ByName(name, Refresh(), systemName);
    }
  }

  // ------------------------------------------------------------------
  // FFmpeg: discovery, child processes, and PCM capture
  // ------------------------------------------------------------------

  static class FfmpegLocator {
    public static IEnumerable<string> Candidates(string configured,
        string? pathVariable, string? programFiles, string? programFilesX86) {
      if (!string.IsNullOrWhiteSpace(configured)) {
        yield return Environment.ExpandEnvironmentVariables(configured);
      }
      foreach (string dir in (pathVariable ?? "").Split(';',
          StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) {
        yield return Path.Combine(dir, "ffmpeg.exe");
      }
      if (!string.IsNullOrEmpty(programFiles)) {
        yield return Path.Combine(programFiles, "ShareX", "ffmpeg.exe");
      }
      if (!string.IsNullOrEmpty(programFilesX86)) {
        yield return Path.Combine(programFilesX86, "ShareX", "ffmpeg.exe");
      }
    }

    public static string Find(string configured) {
      if (!string.IsNullOrWhiteSpace(configured)) {
        string p = Environment.ExpandEnvironmentVariables(configured);
        return File.Exists(p) ? p
          : throw new FileNotFoundException("audio.ffmpeg not found: " + p);
      }
      foreach (string c in Candidates("",
          Environment.GetEnvironmentVariable("PATH"),
          Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
          Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86))) {
        if (File.Exists(c)) {
          return c;
        }
      }
      throw new FileNotFoundException(
        "ffmpeg.exe not found in audio.ffmpeg, PATH, or ShareX's folder. " +
        "Install it with: winget install Gyan.FFmpeg");
    }
  }

  sealed record ProcResult(int ExitCode, string Stdout, string Stderr);

  static class Proc {
    public static ProcessStartInfo Info(string exe, IEnumerable<string> args) {
      var info = new ProcessStartInfo(exe) {
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        RedirectStandardInput = true,
      };
      foreach (string a in args) {
        info.ArgumentList.Add(a);
      }
      return info;
    }

    public static ProcResult Run(string exe, IEnumerable<string> args,
        int timeoutMs, string? workingDir = null) {
      var info = Info(exe, args);
      if (workingDir != null) {
        info.WorkingDirectory = workingDir;
      }
      using var p = Process.Start(info)
        ?? throw new InvalidOperationException("could not start " + exe);
      JobObject.Shared.Add(p);
      p.StandardInput.Close();
      var stdout = p.StandardOutput.ReadToEndAsync();
      var stderr = p.StandardError.ReadToEndAsync();
      if (!p.WaitForExit(timeoutMs)) {
        try {
          p.Kill(true);
        } catch (InvalidOperationException) {
        }
        throw new TimeoutException($"{Path.GetFileName(exe)} timed out");
      }
      p.WaitForExit();
      return new ProcResult(p.ExitCode, stdout.Result, stderr.Result);
    }
  }

  /// Kills every FFmpeg child if this app dies, so no recorder is orphaned.
  sealed class JobObject {
    public static readonly JobObject Shared = new();
    readonly IntPtr handle;

    JobObject() {
      handle = Native.CreateJobObject(IntPtr.Zero, null);
      var info = new Native.JobExtendedLimitInformation();
      info.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
      int size = Marshal.SizeOf<Native.JobExtendedLimitInformation>();
      IntPtr ptr = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(info, ptr, false);
        if (!Native.SetInformationJobObject(handle, 9, ptr, (uint)size)) {
          Log.Warn("job.setup_failed", "job object setup failed",
            new { win32_error = Marshal.GetLastWin32Error() });
        }
      } finally {
        Marshal.FreeHGlobal(ptr);
      }
    }

    public void Add(Process p) {
      try {
        if (!Native.AssignProcessToJobObject(handle, p.Handle)) {
          Log.Warn("job.assign_failed", "could not add a process to the job",
            new { win32_error = Marshal.GetLastWin32Error() });
        }
      } catch (InvalidOperationException) {
        // The process already exited.
      }
    }
  }

  /// Startline and drift estimates from (arrival time, total bytes) pairs.
  /// arrival = start + duration(bytes) + latency, latency >= 0, so the
  /// smallest (arrival - duration) seen is the best start estimate. Its
  /// slope over time measures clock drift against the PC clock.
  sealed class TimingEstimator {
    public const double WindowSeconds = 5;
    double windowStart = double.NaN;
    double windowMin = double.PositiveInfinity;
    double windowMinAt;
    (double At, double Min)? first;
    (double At, double Min)? last;

    public void Add(double arrival, double mediaSeconds) {
      double est = arrival - mediaSeconds;
      if (double.IsNaN(windowStart)) {
        windowStart = arrival;
      }
      if (est < windowMin) {
        windowMin = est;
        windowMinAt = arrival;
      }
      if (arrival - windowStart >= WindowSeconds) {
        var w = (windowMinAt, windowMin);
        first ??= w;
        last = w;
        windowStart = arrival;
        windowMin = double.PositiveInfinity;
      }
    }

    public double? Start =>
      first?.Min ?? (double.IsInfinity(windowMin) ? null : windowMin);

    /// Seconds of wall time per second of media, minus 1. Positive means
    /// the device delivered fewer samples than the clock says it should.
    public double? Slope(double minSpanSeconds) {
      if (first == null || last == null) {
        return null;
      }
      double span = last.Value.At - first.Value.At;
      if (span < minSpanSeconds) {
        return null;
      }
      return (last.Value.Min - first.Value.Min) / span;
    }
  }

  /// One recorded stretch of one input. End caps the segment (session
  /// seconds) when a newer segment took over mid-stream.
  sealed record SegmentInfo(string Kind, string Path, string Device,
    double Start, long Bytes, double? Slope, double? End = null,
    string? EndpointId = null) {
    public const int SampleRate = 48000;
    public const int Channels = 2;
    public const int BytesPerSecond = SampleRate * Channels * 2;
    public double MediaSeconds => (double)Bytes / BytesPerSecond;
  }

  /// One FFmpeg process reading one DirectShow device. FFmpeg writes raw
  /// 48 kHz stereo s16le into a named pipe this app owns, and the app writes
  /// it to the segment file, so a killed process still leaves a usable
  /// segment. FFmpeg's stdout stays separate because virtual-audio-capturer
  /// prints text there ("Received stop event after N passes").
  sealed class PcmCapture : IDisposable {
    public const double StallSeconds = 1.5;
    public const double StartupSeconds = 8;
    static int counter;
    static readonly Regex FatalStderr = new(
      "I/O error|Could not|device lost|Error during demuxing|" +
      "Error opening input|not find|Immediate exit",
      RegexOptions.IgnoreCase);
    static readonly Regex DropStderr = new(
      "drop|real-time buffer|overrun|underrun|discontinuit",
      RegexOptions.IgnoreCase);

    public readonly string Kind;
    public readonly DeviceTarget Target;
    public readonly string FilePath;
    readonly long origin;
    readonly string pipeName;
    readonly TimingEstimator timing = new();
    readonly object levelGate = new();
    readonly CancellationTokenSource connectCancel = new();
    NamedPipeServerStream? pipe;
    float pendingPeak;
    Process? process;
    Thread? reader;
    long bytes;
    long startedTicks;
    long lastArrivalTicks;
    int dropWarnings;
    volatile string? fatalLine;
    volatile bool exited;
    volatile bool stopping;

    public PcmCapture(string kind, DeviceTarget target, string filePath,
        long origin) {
      Kind = kind;
      Target = target;
      FilePath = filePath;
      this.origin = origin;
      pipeName = $"audio-capture-{Environment.ProcessId}-" +
        Interlocked.Increment(ref counter);
    }

    public int Pid { get; private set; }
    public long Bytes => Interlocked.Read(ref bytes);
    public int DropWarnings => Volatile.Read(ref dropWarnings);
    public string? FatalLine => fatalLine;
    string SessionName =>
      Path.GetFileName(Path.GetDirectoryName(FilePath)) ?? "";

    /// FFmpeg arguments. A "lavfi:" spec is a generated test signal paced
    /// in real time (--simulate); anything else is a DirectShow device.
    public static List<string> Args(string spec, string output) {
      var args = new List<string> { "-hide_banner", "-loglevel", "warning",
        "-y" };
      if (spec.StartsWith("lavfi:", StringComparison.Ordinal)) {
        // No initial burst: a real device delivers audio as it happens.
        args.AddRange(new[] { "-re", "-readrate_initial_burst", "0", "-f",
          "lavfi", "-i", spec[6..] });
      } else {
        args.AddRange(new[] {
          "-f", "dshow", "-thread_queue_size", "1024", "-rtbufsize", "256M",
          "-audio_buffer_size", "40", "-i", "audio=" + spec,
        });
      }
      args.AddRange(new[] {
        "-vn", "-ac",
        SegmentInfo.Channels.ToString(CultureInfo.InvariantCulture),
        "-ar", SegmentInfo.SampleRate.ToString(CultureInfo.InvariantCulture),
        "-f", "s16le", "-flush_packets", "1", output,
      });
      return args;
    }

    /// Starts FFmpeg and the reader threads. On failure it kills what it
    /// started and closes the pipe before rethrowing.
    public void Start(string ffmpeg) {
      try {
        StartCore(ffmpeg);
      } catch {
        try {
          process?.Kill();
        } catch (Exception e) when (e is InvalidOperationException or
            System.ComponentModel.Win32Exception) {
        }
        connectCancel.Cancel();
        pipe?.Dispose();
        throw;
      }
    }

    void StartCore(string ffmpeg) {
      pipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1,
        PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1 << 20, 0);
      var p = Process.Start(Proc.Info(ffmpeg,
          Args(Target.Spec, @"\\.\pipe\" + pipeName)))
        ?? throw new InvalidOperationException("could not start ffmpeg");
      JobObject.Shared.Add(p);
      process = p;
      Pid = p.Id;
      startedTicks = Stopwatch.GetTimestamp();
      var log = new StreamWriter(FilePath + ".ffmpeg.log") {
        AutoFlush = true,
      };
      var logGate = new object();
      void Drain(StreamReader source, string tag, bool watch) {
        try {
          string? line;
          while ((line = source.ReadLine()) != null) {
            lock (logGate) {
              log.WriteLine(tag + line);
            }
            Log.Write(watch ? "warn" : "info",
              watch ? "ffmpeg.stderr" : "ffmpeg.stdout", line, new {
                session = SessionName, kind = Kind, pid = Pid,
                file = Path.GetFileName(FilePath),
              });
            if (!watch) {
              continue;
            }
            if (DropStderr.IsMatch(line)) {
              Interlocked.Increment(ref dropWarnings);
            }
            if (fatalLine == null && FatalStderr.IsMatch(line)) {
              fatalLine = line;
              Log.Warn("ffmpeg.fatal_line", line.Trim(), new {
                session = SessionName, kind = Kind, pid = Pid,
                file = Path.GetFileName(FilePath),
              });
            }
          }
        } catch (Exception e) when (e is IOException or
            ObjectDisposedException or InvalidOperationException) {
        }
      }
      var errThread = new Thread(() => Drain(p.StandardError, "", true)) {
        IsBackground = true, Name = Kind + "-stderr",
      };
      var outThread = new Thread(() => Drain(p.StandardOutput, "stdout: ",
          false)) {
        IsBackground = true, Name = Kind + "-stdout",
      };
      errThread.Start();
      outThread.Start();
      reader = new Thread(() => {
        ReadLoop();
        errThread.Join(2000);
        outThread.Join(2000);
        lock (logGate) {
          log.Dispose();
        }
      }) { IsBackground = true, Name = Kind + "-pcm" };
      reader.Start();
      // If FFmpeg dies before it opens the pipe, stop waiting for it.
      p.EnableRaisingEvents = true;
      p.Exited += (_, _) => {
        try {
          connectCancel.Cancel();
        } catch (ObjectDisposedException) {
        }
      };
      if (p.HasExited) {
        connectCancel.Cancel();
      }
    }

    void ReadLoop() {
      var buffer = new byte[16384];
      int carry = 0; // bytes of a split 4-byte frame
      long lastFlush = Stopwatch.GetTimestamp();
      try {
        using var file = new FileStream(FilePath, FileMode.Create,
          FileAccess.Write, FileShare.Read, 1 << 20);
        pipe!.WaitForConnectionAsync(connectCancel.Token).GetAwaiter()
          .GetResult();
        while (true) {
          int n = pipe.Read(buffer, carry, buffer.Length - carry);
          if (n <= 0) {
            break;
          }
          long now = Stopwatch.GetTimestamp();
          int total = carry + n;
          int whole = total - total % 4;
          file.Write(buffer, 0, whole);
          long newBytes = Interlocked.Add(ref bytes, whole);
          Interlocked.Exchange(ref lastArrivalTicks, now);
          float peak = 0;
          for (int i = 0; i + 1 < whole; i += 2) {
            int s = Math.Abs((int)BitConverter.ToInt16(buffer, i));
            if (s > peak) {
              peak = s;
            }
          }
          lock (levelGate) {
            pendingPeak = Math.Max(pendingPeak, peak / 32768f);
            timing.Add(Clock.Seconds(now - origin),
              (double)newBytes / SegmentInfo.BytesPerSecond);
          }
          carry = total - whole;
          if (carry > 0) {
            Buffer.BlockCopy(buffer, whole, buffer, 0, carry);
          }
          if (Clock.Seconds(now - lastFlush) > 2) {
            file.Flush();
            lastFlush = now;
          }
        }
      } catch (Exception e) when (e is IOException or
          ObjectDisposedException or OperationCanceledException or
          InvalidOperationException) {
        // FFmpeg died, or Release() closed the pipe.
      } finally {
        exited = true;
      }
    }

    /// Peak level since the last call, 0..1.
    public float TakePeak() {
      lock (levelGate) {
        float p = pendingPeak;
        pendingPeak = 0;
        return p;
      }
    }

    /// Why this capture counts as lost right now, or null if it is healthy.
    public string? LossReason(long nowTicks) {
      if (stopping) {
        return null;
      }
      return Health.LossReason(
        Clock.Seconds(nowTicks - startedTicks),
        Bytes > 0
          ? Clock.Seconds(nowTicks - Interlocked.Read(ref lastArrivalTicks))
          : null,
        exited || (process?.HasExited ?? false),
        fatalLine);
    }

    /// Asks FFmpeg to finish ("q"), then kills it after the timeout.
    /// Blocks: call it off the UI thread.
    public void Stop(int timeoutMs) {
      stopping = true;
      try {
        process?.StandardInput.Write("q\n");
        process?.StandardInput.Flush();
      } catch (Exception e) when (e is IOException or
          InvalidOperationException or ObjectDisposedException) {
      }
      if (!(reader?.Join(timeoutMs) ?? true)) {
        Kill();
      }
    }

    /// Kills FFmpeg and waits for the reader. If the reader is still stuck,
    /// closes the pipe under it. Blocks: call it off the UI thread.
    public void Kill() {
      stopping = true;
      try {
        connectCancel.Cancel();
        process?.Kill();
      } catch (Exception e) when (e is InvalidOperationException or
          System.ComponentModel.Win32Exception or ObjectDisposedException) {
      }
      if (!(reader?.Join(3000) ?? true)) {
        Log.Warn("capture.reader_stuck", "reader stuck after kill; closing " +
          "its pipe", new { session = SessionName, kind = Kind, pid = Pid });
        pipe?.Dispose();
        reader?.Join(3000);
      }
    }

    /// Session seconds of this capture's first sample, once audio flows.
    public double? StartEstimate {
      get {
        lock (levelGate) {
          return timing.Start;
        }
      }
    }

    public SegmentInfo ToSegment(double? end = null) {
      lock (levelGate) {
        double start = timing.Start ?? Clock.Seconds(startedTicks - origin);
        return new SegmentInfo(Kind, FilePath, Target.Display, start, Bytes,
          timing.Slope(Mixer.MinDriftSpanSeconds), end, Target.EndpointId);
      }
    }

    public void Dispose() {
      try {
        process?.StandardInput.Dispose();
      } catch (Exception e) when (e is IOException or
          InvalidOperationException) {
      }
      process?.Dispose();
      pipe?.Dispose();
      connectCancel.Dispose();
    }
  }

  static class Health {
    /// A fatal-looking stderr line only counts once audio has also stopped
    /// (0.5 s gap) or FFmpeg exited: dshow prints some scary warnings while
    /// it keeps recording.
    public const double FatalGapSeconds = 0.5;

    public static string? LossReason(double sinceStart, double? sinceLastByte,
        bool exited, string? fatalLine) {
      // Before the first byte only an exit or the startup timeout counts:
      // dshow prints warnings while it opens a healthy device.
      bool gap = sinceLastByte == null
        ? sinceStart > PcmCapture.StartupSeconds
        : sinceLastByte > FatalGapSeconds;
      if (fatalLine != null && (exited || gap)) {
        return "ffmpeg: " + fatalLine.Trim();
      }
      if (exited) {
        return "ffmpeg exited";
      }
      if (sinceLastByte == null) {
        return sinceStart > PcmCapture.StartupSeconds
          ? $"no audio {PcmCapture.StartupSeconds:0} s after start"
          : null;
      }
      return sinceLastByte > PcmCapture.StallSeconds
        ? $"no audio for {sinceLastByte:0.0} s"
        : null;
    }
  }

  static class Clock {
    public static double Seconds(long ticks) =>
      (double)ticks / Stopwatch.Frequency;
  }

  // ------------------------------------------------------------------
  // Mixing: place each segment at its time offset, mix, encode, verify
  // ------------------------------------------------------------------

  sealed record MixResult(bool Ok, string Message, string? OutputPath);

  static class Mixer {
    /// Drift is corrected only on segments long enough to measure it.
    public const double MinDriftSpanSeconds = 60;
    public const double DriftThreshold = 100e-6;
    /// Above this, the "drift" is more likely dropped audio than a clock:
    /// correcting it would shift pitch for nothing.
    public const double MaxDrift = 500e-6;

    public static bool CorrectsDrift(double? slope) =>
      slope is double v && Math.Abs(v) > DriftThreshold &&
      Math.Abs(v) <= MaxDrift;

    static string Num(double v, string fmt) =>
      v.ToString(fmt, CultureInfo.InvariantCulture);

    /// Segments that hold audio before the stop time (null: no stop time).
    public static List<SegmentInfo> Usable(IEnumerable<SegmentInfo> all,
        double? stopAt) =>
      all.Where(s => s.Bytes > 0 && s.Start < EndOf(s, stopAt) - 0.001)
        .ToList();

    /// Where a segment's audio ends in session seconds: its own length,
    /// cut by its End cap and the session's stop time.
    public static double EndOf(SegmentInfo s, double? stopAt) {
      double end = s.Start + WallSeconds(s);
      if (s.End is double cap) {
        end = Math.Min(end, cap);
      }
      if (stopAt is double stop) {
        end = Math.Min(end, stop);
      }
      return end;
    }

    /// The -filter_complex graph: per segment, an optional drift fix, a
    /// trim at the stop time, and a delay to its offset from the earliest
    /// segment; then amix (no normalization, like ShareX's command) and a
    /// limiter. FFmpeg keeps capturing for a moment after it gets "q", and
    /// the trim drops that tail.
    public static string BuildFilter(IReadOnlyList<SegmentInfo> segments,
        double? stopAt = null) {
      if (segments.Count == 0) {
        throw new ArgumentException("no segments to mix");
      }
      double origin = segments.Min(s => s.Start);
      var parts = new List<string>();
      var labels = new StringBuilder();
      for (int i = 0; i < segments.Count; i++) {
        var s = segments[i];
        var chain = new List<string>();
        if (CorrectsDrift(s.Slope)) {
          double slope = s.Slope!.Value;
          // N samples really took (1 + slope) times longer: play them at
          // the rate they were captured, then resample back to 48 kHz.
          int rate = (int)Math.Round(SegmentInfo.SampleRate / (1 + slope));
          chain.Add($"asetrate={rate}");
          chain.Add($"aresample={SegmentInfo.SampleRate}");
        }
        double end = EndOf(s, stopAt);
        if (end < s.Start + WallSeconds(s)) {
          chain.Add($"atrim=end={Num(end - s.Start, "0.000")}");
        }
        long delayMs = (long)Math.Round((s.Start - origin) * 1000);
        if (delayMs > 0) {
          chain.Add($"adelay=delays={delayMs}:all=1");
        }
        if (chain.Count == 0) {
          chain.Add("anull");
        }
        parts.Add($"[{i}:a]{string.Join(",", chain)}[s{i}]");
        labels.Append($"[s{i}]");
      }
      parts.Add($"{labels}amix=inputs={segments.Count}:duration=longest:" +
        "dropout_transition=0:normalize=0,alimiter=limit=0.95[mixed]");
      return string.Join(";", parts);
    }

    public const string FilterFile = "mix-filter.txt";

    /// FFmpeg runs in the session folder: inputs are bare file names and
    /// the graph comes from a file, so the command line stays far below
    /// Windows' 32,767-character limit even with hundreds of segments.
    /// `-/filter_complex <file>` needs FFmpeg 7 or newer.
    public static List<string> BuildArgs(IReadOnlyList<SegmentInfo> segments,
        string outputPath) {
      var args = new List<string> { "-hide_banner", "-nostdin", "-y" };
      foreach (var s in segments) {
        args.AddRange(new[] {
          "-f", "s16le", "-ar", SegmentInfo.SampleRate.ToString(
            CultureInfo.InvariantCulture),
          "-ac", SegmentInfo.Channels.ToString(CultureInfo.InvariantCulture),
          "-i", Path.GetFileName(s.Path),
        });
      }
      args.AddRange(new[] {
        "-/filter_complex", FilterFile, "-map", "[mixed]",
        "-c:a", "libmp3lame", "-qscale:a", "4", "-f", "mp3", outputPath,
      });
      return args;
    }

    /// Expected output length: from the earliest segment start to the
    /// latest segment end, in wall-clock seconds.
    public static double ExpectedSeconds(IReadOnlyList<SegmentInfo> segments,
        double? stopAt = null) {
      double origin = segments.Min(s => s.Start);
      return segments.Max(s => EndOf(s, stopAt)) - origin;
    }

    public static double WallSeconds(SegmentInfo s) =>
      CorrectsDrift(s.Slope) ? s.MediaSeconds * (1 + s.Slope!.Value)
        : s.MediaSeconds;

    /// The decoded length: the last "time=" in FFmpeg's progress output.
    /// Unlike the container's "Duration:", it counts what actually decoded.
    public static double? ParseDecodedTime(string ffmpegStderr) {
      var all = Regex.Matches(ffmpegStderr,
        @"time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)");
      if (all.Count == 0) {
        return null;
      }
      var m = all[^1];
      return int.Parse(m.Groups[1].Value) * 3600 +
        int.Parse(m.Groups[2].Value) * 60 +
        double.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
    }

    /// MP3 framing adds up to ~50 ms; allow 0.3 s plus 0.2% for timing
    /// estimates on long recordings.
    public static bool DurationMatches(double actual, double expected) =>
      Math.Abs(actual - expected) <= 0.3 + expected * 0.002;

    public static MixResult MixAndVerify(string ffmpeg,
        IReadOnlyList<SegmentInfo> all, string outputPath, string sessionDir,
        double? stopAt) {
      var segments = Usable(all, stopAt);
      if (segments.Count == 0) {
        return new MixResult(false, "nothing was recorded", null);
      }
      Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
      string final = Paths.Unique(outputPath, File.Exists);
      string partial = final + ".partial";
      if (segments.Any(s => !string.Equals(Path.GetDirectoryName(s.Path),
          Path.GetFullPath(sessionDir).TrimEnd('\\'),
          StringComparison.OrdinalIgnoreCase))) {
        return new MixResult(false, "segments outside " + sessionDir, null);
      }
      File.WriteAllText(Path.Combine(sessionDir, FilterFile),
        BuildFilter(segments, stopAt));
      var args = BuildArgs(segments, partial);
      File.WriteAllText(Path.Combine(sessionDir, "mix-command.txt"),
        "cd " + Quote(sessionDir) + Environment.NewLine +
        "ffmpeg " + string.Join(" ", args.Select(Quote)) + Environment.NewLine);
      var sw = Stopwatch.StartNew();
      var mix = Proc.Run(ffmpeg, args, 60 * 60 * 1000, sessionDir);
      File.WriteAllText(Path.Combine(sessionDir, "mix.log"), mix.Stderr);
      if (mix.ExitCode != 0) {
        return new MixResult(false,
          $"mix failed (exit {mix.ExitCode}); see {sessionDir}", null);
      }
      var check = Proc.Run(ffmpeg, new[] {
        "-hide_banner", "-nostdin", "-v", "info", "-stats", "-i", partial,
        "-f", "null", "-",
      }, 30 * 60 * 1000);
      double expected = ExpectedSeconds(segments, stopAt);
      double? actual = ParseDecodedTime(check.Stderr);
      if (check.ExitCode != 0 || actual == null ||
          !DurationMatches(actual.Value, expected)) {
        return new MixResult(false,
          $"verify failed: duration {actual?.ToString("0.00") ?? "?"} s, " +
          $"expected {expected:0.00} s; kept {partial} and {sessionDir}",
          null);
      }
      File.Move(partial, final);
      return new MixResult(true,
        $"saved {final} ({actual:0.0} s, expected {expected:0.0} s, " +
        $"{segments.Count} segments, mixed in {sw.Elapsed.TotalSeconds:0.0} s)",
        final);
    }

    static string Quote(string a) =>
      a.Length > 0 && !a.Any(c => char.IsWhiteSpace(c) || c == '"' ||
        c == ';' || c == '[')
        ? a
        : "\"" + a.Replace("\"", "\\\"") + "\"";
  }

  /// session.json: enough to mix a session again with --recover.
  sealed class SessionManifest {
    public const string FileName = "session.json";
    public DateTime StartedLocal { get; set; }
    /// Session seconds when the user pressed stop; null while recording.
    public double? StopAt { get; set; }
    public List<ManifestSegment> Segments { get; set; } = new();

    public sealed class ManifestSegment {
      public string Kind { get; set; } = "";
      public string File { get; set; } = "";
      public string Device { get; set; } = "";
      public double Start { get; set; }
      public double? Slope { get; set; }
      public long Bytes { get; set; }
      public double? End { get; set; }
      public string? EndpointId { get; set; }
    }

    static readonly JsonSerializerOptions Options = new() {
      WriteIndented = true,
    };

    public const string SavedMarker = "saved.txt";

    /// Records that a session became an MP3, so it isn't mixed twice.
    public static void MarkSaved(string dir, string output) =>
      File.WriteAllText(Path.Combine(dir, SavedMarker), output +
        Environment.NewLine);

    public static string? SavedPath(string dir) {
      string marker = Path.Combine(dir, SavedMarker);
      return File.Exists(marker) ? File.ReadAllText(marker).Trim() : null;
    }

    /// Session folders with a manifest that never got saved.
    public static List<string> Unfinished(string sessionsDir) {
      if (!Directory.Exists(sessionsDir)) {
        return new List<string>();
      }
      return Directory.GetDirectories(sessionsDir)
        .Where(d => File.Exists(Path.Combine(d, FileName)) &&
          SavedPath(d) == null)
        .OrderBy(d => d)
        .ToList();
    }

    public void Write(string path) {
      string tmp = $"{path}.{Guid.NewGuid():N}.tmp";
      File.WriteAllText(tmp, JsonSerializer.Serialize(this, Options));
      File.Move(tmp, path, true);
    }

    public static SessionManifest Read(string path) =>
      JsonSerializer.Deserialize<SessionManifest>(File.ReadAllText(path))
        ?? throw new InvalidDataException("empty manifest: " + path);

    /// Byte counts come from file sizes, since the app may have died before
    /// a segment ended.
    public List<SegmentInfo> ToSegments(string dir) =>
      Segments.Select(m => {
        string path = Path.Combine(dir, m.File);
        long size = File.Exists(path) ? new FileInfo(path).Length : 0;
        return new SegmentInfo(m.Kind, path, m.Device, m.Start,
          size - size % 4, m.Slope, m.End, m.EndpointId);
      }).ToList();
  }

  // ------------------------------------------------------------------
  // Recording session
  // ------------------------------------------------------------------

  /// One input (system audio or mic) over a session: its live capture, a
  /// pending capture that will take over (a mic switch), and the segments
  /// it has finished.
  sealed class Source {
    public readonly string Kind;
    public DeviceTarget? Target;
    public PcmCapture? Live;
    public PcmCapture? Pending;
    public string PendingReason = "";
    public readonly List<SegmentInfo> Finished = new();
    /// Segments being closed off the UI thread; Stop waits for them.
    public readonly List<Task> Closing = new();
    public int Failures;
    public int Count;
    public long NextRetryTicks;
    public bool WaitingLogged;
    public string? LastDevice;

    public Source(string kind) {
      Kind = kind;
    }
  }

  enum RecorderState { Idle, Recording, Saving }

  /// One recording: its folder, clock origin, inputs, and stop time. A
  /// session keeps saving in the background after the next one starts.
  sealed class Session {
    public readonly int Id;
    public readonly string Dir;
    public readonly long Origin;
    public readonly DateTime StartedLocal;
    public readonly MicPolicy Policy;
    public readonly IDeviceResolver Resolver;
    public readonly object Gate = new(); // Finished, Live, and session.json
    public Source? System;
    public Source? Mic;
    public double? StopAt;
    /// Session seconds of system audio's first sample: the file's 0:00.
    public double? TimeZero;

    /// The folder name, e.g. 20261113-191849-432: the session's id in logs.
    public string Name => Path.GetFileName(Dir);

    public Session(int id, string dir, long origin, DateTime startedLocal,
        MicPolicy policy, IDeviceResolver resolver) {
      Id = id;
      Dir = dir;
      Origin = origin;
      StartedLocal = startedLocal;
      Policy = policy;
      Resolver = resolver;
    }

    public double Elapsed => Clock.Seconds(Stopwatch.GetTimestamp() - Origin);

    public IEnumerable<Source> Sources =>
      new[] { System, Mic }.Where(x => x != null).Select(x => x!);

    /// Writes session.json from finished and live segments, under the lock
    /// so a segment moving from live to finished is never listed twice.
    public void WriteManifest() {
      try {
        lock (Gate) {
          var manifest = new SessionManifest {
            StartedLocal = StartedLocal, StopAt = StopAt,
          };
          foreach (var src in Sources) {
            var segs = src.Finished.ToList();
            if (src.Live != null) {
              segs.Add(src.Live.ToSegment());
            }
            foreach (var x in segs.OrderBy(x => x.Start)) {
              manifest.Segments.Add(new SessionManifest.ManifestSegment {
                Kind = x.Kind, File = Path.GetFileName(x.Path),
                Device = x.Device, Start = x.Start, Slope = x.Slope,
                Bytes = x.Bytes, End = x.End, EndpointId = x.EndpointId,
              });
            }
          }
          manifest.Write(Path.Combine(Dir, SessionManifest.FileName));
        }
      } catch (Exception e) {
        Log.Error("manifest.write_failed", e.Message, new { session = Name });
      }
    }
  }

  sealed class Recorder {
    readonly Control ui;
    readonly Action<string> status;
    readonly IEndpointSource endpoints;
    readonly Func<string, AppConfig, IDeviceResolver> resolverFor;
    readonly System.Windows.Forms.Timer reconcileTimer = new();
    readonly List<string> reconcileReasons = new();
    readonly List<Action> afterSaves = new();
    /// Set while recording or saving, so `--quit-if-idle` can see it.
    readonly EventWaitHandle busy = new(false, EventResetMode.ManualReset,
      Program.BusyEventName);
    AppConfig cfg;
    string ffmpeg = "";
    Session? current;
    int sessionCounter;
    int savesRunning;
    long lastManifestTicks;
    bool reconcileBusy;
    bool reconcileAgain;

    public Pill? Pill { get; private set; }
    public MixResult? LastResult { get; private set; }
    public List<MixResult> Results { get; } = new();
    public List<SegmentInfo> LastSegments { get; private set; } = new();
    public int? MicPid => current?.Mic?.Live?.Pid;
    /// Set when the app is quitting: no new recordings.
    public bool Closing { get; set; }

    public RecorderState State => current != null ? RecorderState.Recording
      : savesRunning > 0 ? RecorderState.Saving : RecorderState.Idle;

    public Recorder(Control ui, AppConfig cfg, IEndpointSource endpoints,
        Action<string> status,
        Func<string, AppConfig, IDeviceResolver>? resolverFor = null) {
      this.resolverFor = resolverFor ?? ((exe, c) =>
        new DshowCache(() => DirectShow.ListAudio(exe), c.System));
      this.ui = ui;
      this.cfg = cfg;
      this.endpoints = endpoints;
      this.status = status;
      reconcileTimer.Tick += (_, _) => {
        reconcileTimer.Stop();
        string reason = string.Join("; ", reconcileReasons.Distinct());
        reconcileReasons.Clear();
        Reconcile(reason);
      };
      endpoints.Changed += e => Post(() => OnDeviceEvent(e));
    }

    public void UpdateConfig(AppConfig next) {
      cfg = next;
    }

    public double Elapsed => current?.Elapsed ?? 0;

    /// Starts a recording, or stops the current one. A previous session
    /// still saving doesn't block a new recording.
    public void Toggle() {
      if (current != null) {
        Stop();
      } else {
        Start();
      }
    }

    public void Start() {
      if (current != null || Closing) {
        return;
      }
      try {
        ffmpeg = FfmpegLocator.Find(cfg.Ffmpeg);
      } catch (FileNotFoundException e) {
        Log.Error("ffmpeg.not_found", e.Message);
        ShowPill().ShowError("ffmpeg not found");
        return;
      }
      long origin = Stopwatch.GetTimestamp();
      var startedLocal = DateTime.Now;
      string dir = Path.Combine(Paths.SessionsDir,
        startedLocal.ToString("yyyyMMdd-HHmmss-fff",
          CultureInfo.InvariantCulture));
      Directory.CreateDirectory(dir);
      var ses = new Session(++sessionCounter, dir, origin, startedLocal,
        MicPolicy.Parse(cfg.Mic, new List<string>()),
        resolverFor(ffmpeg, cfg));
      current = ses;
      busy.Set();
      lastManifestTicks = origin;
      reconcileBusy = false;
      reconcileAgain = false;
      Native.KeepAwake(true);
      CheckDiskSpace(dir);
      Log.Info("recording.start", "recording started", new {
        session = ses.Name, dir, mic_policy = ses.Policy.ToString(),
        earlier_saves_running = savesRunning,
      });
      ShowPill().ShowRecording();
      status("recording");

      ses.System = new Source("system") {
        // virtual-audio-capturer is a fixed software name: start it now.
        Target = new DeviceTarget(cfg.System, cfg.System, "Config", null),
      };
      StartLive(ses, ses.System, ses.System.Target, "start");
      if (ses.Policy.Mode == MicMode.None) {
        Pill?.SetMicMissing();
      } else {
        ses.Mic = new Source("mic");
        Reconcile("start");
      }
    }

    static void CheckDiskSpace(string dir) {
      try {
        var drive = new DriveInfo(Path.GetPathRoot(dir)!);
        long free = drive.AvailableFreeSpace;
        if (free < 3L * 1024 * 1024 * 1024) {
          Log.Warn("disk.low", "little free space for temp audio (about " +
            "1.4 GB per hour)", new { free_mb = free / (1024 * 1024) });
        }
      } catch (Exception e) {
        Log.Warn("disk.check_failed", e.Message);
      }
    }

    void Post(Action action) {
      try {
        ui.BeginInvoke(action);
      } catch (InvalidOperationException) {
        // UI is gone: the app is exiting.
      }
    }

    PcmCapture? StartCapture(Session ses, Source src, DeviceTarget target) {
      src.Count++;
      string file = Path.Combine(ses.Dir, $"{src.Kind}-{src.Count:00}.pcm");
      var cap = new PcmCapture(src.Kind, target, file, ses.Origin);
      try {
        cap.Start(ffmpeg);
      } catch (Exception e) {
        Log.Error("segment.start_failed", e.Message, new {
          session = ses.Name, kind = src.Kind, device = target.Display,
          endpoint = target.EndpointId, spec = target.Spec,
        });
        cap.Dispose();
        src.Failures++;
        SetRetry(src);
        return null;
      }
      Log.Info("segment.start", $"{src.Kind} segment {src.Count} started", new {
        session = ses.Name, kind = src.Kind, segment = src.Count,
        device = target.Display, endpoint = target.EndpointId,
        spec = target.Spec, method = target.Method, pid = cap.Pid,
        at = Math.Round(ses.Elapsed, 3),
      });
      return cap;
    }

    void StartLive(Session ses, Source src, DeviceTarget target,
        string reason) {
      var cap = StartCapture(ses, src, target);
      if (cap == null) {
        return;
      }
      lock (ses.Gate) {
        src.Live = cap;
      }
      src.Target = target;
      src.WaitingLogged = false;
      if (src == ses.Mic) {
        Pill?.SetMicLost(false);
        if (src.LastDevice != null && src.LastDevice != target.Display) {
          Log.Info("mic.device_changed", $"mic now {target.Display}", new {
            session = ses.Name, from = src.LastDevice, to = target.Display,
            endpoint = target.EndpointId, policy = ses.Policy.ToString(),
            role = ses.Policy.Role?.ToString(), reason,
          });
          Pill?.Flash(DeviceMatch.ShortName(target.Display));
        }
        src.LastDevice = target.Display;
      }
      ses.WriteManifest();
    }

    static void SetRetry(Source src) {
      int delayMs = Math.Clamp(1000 * (1 << Math.Max(src.Failures - 1, 0)),
        1000, 5000);
      src.NextRetryTicks = Stopwatch.GetTimestamp() +
        delayMs * Stopwatch.Frequency / 1000;
    }

    /// A Windows device event: re-check the mic after things settle
    /// (Bluetooth and USB fire bursts of events).
    void OnDeviceEvent(string description) {
      if (current?.Mic == null) {
        return;
      }
      Log.Info("device.event", description, new { session = current?.Name });
      ScheduleReconcile("device event", 500);
    }

    void ScheduleReconcile(string reason, int delayMs) {
      reconcileReasons.Add(reason);
      reconcileTimer.Stop();
      reconcileTimer.Interval = Math.Max(delayMs, 1);
      reconcileTimer.Start();
    }

    /// Works out which device the mic should be on (off the UI thread),
    /// then starts it, or switches to it, or waits.
    void Reconcile(string reason) {
      var ses = current;
      if (ses?.Mic == null) {
        return;
      }
      if (reconcileBusy) {
        reconcileAgain = true;
        return;
      }
      reconcileBusy = true;
      Task.Run(() => {
        Endpoint? desired = null;
        DeviceTarget? target = null;
        string? error = null;
        try {
          desired = ses.Policy.Desired(endpoints);
          if (desired != null) {
            target = ses.Resolver.ForEndpoint(desired);
            if (target == null) {
              error = $"no DirectShow device for {desired.FriendlyName}";
            }
          } else if (ses.Policy.Mode == MicMode.Pinned) {
            target = ses.Resolver.ByName(ses.Policy.Name);
          }
        } catch (Exception e) {
          error = e.Message;
        }
        Post(() => ApplyReconcile(ses, reason, target, error));
      });
    }

    void ApplyReconcile(Session ses, string reason, DeviceTarget? target,
        string? error) {
      reconcileBusy = false;
      var mic = ses.Mic;
      if (ses != current || mic == null) {
        return;
      }
      if (error != null) {
        Log.Warn("mic.check_error", error, new {
          session = ses.Name, reason,
        });
      }
      var active = mic.Pending ?? mic.Live;
      if (target == null) {
        if (mic.Live == null && !mic.WaitingLogged) {
          mic.WaitingLogged = true;
          Log.Warn("mic.waiting", "no device for the mic policy; waiting", new {
            session = ses.Name, policy = ses.Policy.ToString(),
            role = ses.Policy.Role?.ToString(), reason,
          });
          Pill?.SetMicLost(true);
        }
      } else if (active == null) {
        StartLive(ses, mic, target, reason);
      } else if (active.Target.Spec != target.Spec) {
        // The default moved while the current mic still works: start the
        // new device, and hand over once its audio flows.
        if (mic.Pending != null) {
          var stale = mic.Pending;
          mic.Pending = null;
          CloseSegment(ses, mic, stale, graceful: false, endAt: null);
        }
        var cap = StartCapture(ses, mic, target);
        if (cap != null) {
          mic.Pending = cap;
          mic.PendingReason = reason;
          Log.Info("mic.switch_begin", "default changed; starting the new " +
            "device", new {
              session = ses.Name, from = mic.Live?.Target.Display,
              to = target.Display, to_endpoint = target.EndpointId,
              policy = ses.Policy.ToString(),
              role = ses.Policy.Role?.ToString(), reason,
            });
        }
      }
      if (reconcileAgain) {
        reconcileAgain = false;
        ScheduleReconcile("again", 100);
      }
    }

    /// Called every UI tick: feeds the pill, hands over mic switches, and
    /// catches lost inputs.
    public void Tick() {
      var ses = current;
      if (ses == null) {
        return;
      }
      long now = Stopwatch.GetTimestamp();
      float micPeak = ses.Mic?.Live?.TakePeak() ?? 0;
      float sysPeak = ses.System?.Live?.TakePeak() ?? 0;
      // The pill says "starting" until audio flows, and its timer counts
      // from system audio's first sample, which is where the file starts.
      if (ses.TimeZero == null &&
          ses.System?.Live?.StartEstimate is double zero) {
        ses.TimeZero = zero;
        Log.Info("recording.live", "system audio flowing", new {
          session = ses.Name, time_zero = Math.Round(zero, 3),
        });
      }
      bool micSettled = ses.Mic == null || ses.Mic.Live?.Bytes > 0 ||
        ses.Mic.WaitingLogged || ses.Elapsed > PillLayout.StartingMaxSeconds;
      bool starting = ses.TimeZero == null || !micSettled;
      Pill?.Push(ses.Mic != null ? micPeak : sysPeak,
        ses.TimeZero is double z ? ses.Elapsed - z : 0, starting);
      if (ses.Mic?.Pending is PcmCapture pending) {
        TickPending(ses, ses.Mic, pending, now);
      }
      foreach (var src in ses.Sources) {
        if (src.Live == null) {
          if (src.Pending == null && now >= src.NextRetryTicks) {
            SetRetry(src);
            if (src == ses.Mic) {
              if (!reconcileBusy) {
                Reconcile("retry");
              }
            } else if (src.Target != null) {
              StartLive(ses, src, src.Target, "retry");
            }
          }
          continue;
        }
        string? reason = src.Live.LossReason(now);
        if (reason == null) {
          if (src.Failures > 0 && src.Live.Bytes >
              10L * SegmentInfo.BytesPerSecond) {
            src.Failures = 0;
          }
          continue;
        }
        var lost = src.Live;
        lock (ses.Gate) {
          src.Live = null;
        }
        Log.Warn($"{src.Kind}.lost", reason, new {
          session = ses.Name, kind = src.Kind, device = lost.Target.Display,
          endpoint = lost.Target.EndpointId, pid = lost.Pid,
          bytes = lost.Bytes, at = Math.Round(ses.Elapsed, 3),
        });
        CloseSegment(ses, src, lost, graceful: false, endAt: null);
        src.Failures++;
        SetRetry(src);
        if (src == ses.Mic) {
          if (src.Pending == null) {
            Pill?.SetMicLost(true);
          }
          ScheduleReconcile("mic lost", 500);
        }
      }
      // Keep session.json current so --recover has measured timing.
      if (Clock.Seconds(now - lastManifestTicks) >= 10) {
        lastManifestTicks = now;
        ses.WriteManifest();
      }
    }

    void TickPending(Session ses, Source src, PcmCapture pending, long now) {
      if (pending.Bytes > 0 && pending.StartEstimate is double start) {
        Handoff(ses, src, pending, start);
        return;
      }
      string? reason = pending.LossReason(now);
      if (reason != null) {
        Log.Warn("mic.switch_failed", reason, new {
          session = ses.Name, to = pending.Target.Display,
          endpoint = pending.Target.EndpointId,
        });
        src.Pending = null;
        CloseSegment(ses, src, pending, graceful: false, endAt: null);
        src.Failures++;
        SetRetry(src);
      }
    }

    /// The pending capture has audio: it becomes live, and the old segment
    /// ends where the new one starts, so the switch leaves no gap.
    void Handoff(Session ses, Source src, PcmCapture next, double start) {
      PcmCapture? old;
      lock (ses.Gate) {
        old = src.Live;
        src.Live = next;
      }
      src.Pending = null;
      src.Target = next.Target;
      src.WaitingLogged = false;
      if (old != null) {
        CloseSegment(ses, src, old, graceful: true, endAt: start);
      }
      Log.Info("mic.switched", $"mic switched to {next.Target.Display}", new {
        session = ses.Name, from = old?.Target.Display,
        to = next.Target.Display, to_endpoint = next.Target.EndpointId,
        at = Math.Round(start, 3), policy = ses.Policy.ToString(),
        role = ses.Policy.Role?.ToString(), reason = src.PendingReason,
      });
      Pill?.SetMicLost(false);
      Pill?.Flash(DeviceMatch.ShortName(next.Target.Display));
      src.LastDevice = next.Target.Display;
      ses.WriteManifest();
    }

    /// Stops or kills a capture and files its segment, off the UI thread:
    /// it can block for seconds and the pill must keep drawing. The task
    /// never faults; the save waits for it.
    void CloseSegment(Session ses, Source src, PcmCapture cap, bool graceful,
        double? endAt) {
      var task = Task.Run(() => {
        try {
          if (graceful) {
            cap.Stop(3000);
          } else {
            cap.Kill();
          }
        } catch (Exception e) {
          Log.Error("segment.close_error", e.Message, new {
            session = ses.Name, kind = src.Kind,
          });
        }
        var seg = cap.ToSegment(endAt);
        int drops = cap.DropWarnings;
        cap.Dispose();
        lock (ses.Gate) {
          if (seg.Bytes > 0) {
            src.Finished.Add(seg);
          }
        }
        if (seg.Bytes > 0) {
          Log.Info("segment.done", DescribeSegment(seg),
            SegmentFields(ses.Name, seg, drops));
        } else {
          TryDelete(cap.FilePath);
        }
        ses.WriteManifest();
      });
      lock (ses.Gate) {
        src.Closing.Add(task);
      }
    }

    static object SegmentFields(string session, SegmentInfo s, int drops) =>
      new {
        session, kind = s.Kind, file = Path.GetFileName(s.Path),
        device = s.Device, endpoint = s.EndpointId,
        start = Math.Round(s.Start, 3),
        media_seconds = Math.Round(s.MediaSeconds, 3),
        end = s.End is double e ? Math.Round(e, 3) : (double?)null,
        drift_ppm = s.Slope is double sl ? Math.Round(sl * 1e6) : (double?)null,
        bytes = s.Bytes, dshow_drop_warnings = drops,
      };

    static string DescribeSegment(SegmentInfo s) =>
      $"{Path.GetFileName(s.Path)} from {s.Device}, start {s.Start:0.000} s, " +
      $"{s.MediaSeconds:0.000} s of audio" +
      (s.End is double end ? $", cut at {end:0.000} s" : "") + ", drift " +
      (s.Slope is double sl ? $"{sl * 1e6:0} ppm" : "n/a");

    /// For a crash handler: record what the current session has so far.
    public void WriteManifestNow() => current?.WriteManifest();

    /// Stops the current recording and saves it in the background. `done`
    /// runs once nothing is recording or saving.
    public void Stop(Action? done = null) {
      var ses = current;
      if (ses != null) {
        StopSession(ses);
      }
      if (done != null) {
        afterSaves.Add(done);
      }
      RunAfterSavesIfIdle();
    }

    void RunAfterSavesIfIdle() {
      if (current != null || savesRunning > 0) {
        return;
      }
      var callbacks = afterSaves.ToList();
      afterSaves.Clear();
      foreach (var callback in callbacks) {
        callback();
      }
    }

    void StopSession(Session ses) {
      current = null;
      savesRunning++;
      reconcileTimer.Stop();
      reconcileReasons.Clear();
      Native.KeepAwake(false);
      ses.StopAt = ses.Elapsed;
      Log.Info("recording.stop", "recording stopped; saving", new {
        session = ses.Name, stop_at = Math.Round(ses.StopAt.Value, 3),
      });
      Pill?.ShowSaving();
      status("saving");
      // A switch caught mid-handoff: finish it if the new mic has audio,
      // else drop it.
      if (ses.Mic?.Pending is PcmCapture pending) {
        if (pending.Bytes > 0 && pending.StartEstimate is double start) {
          Handoff(ses, ses.Mic, pending, start);
        } else {
          ses.Mic.Pending = null;
          CloseSegment(ses, ses.Mic, pending, graceful: false, endAt: null);
        }
      }
      string exe = ffmpeg;
      string output = Paths.OutputFile(cfg, ses.StartedLocal);
      bool keep = cfg.KeepSession;
      Task.Run(() => {
        var result = Save(ses, exe, output, keep);
        Log.Write(result.Ok ? "info" : "error", "mix.done", result.Message,
          new {
            session = ses.Name, ok = result.Ok, output = result.OutputPath,
          });
        Post(() => FinishSave(result));
      });
    }

    MixResult Save(Session ses, string exe, string output, bool keep) {
      try {
        var live = ses.Sources.Where(s => s.Live != null)
          .Select(s => (Source: s, Capture: s.Live!)).ToList();
        Parallel.ForEach(live, pair => pair.Capture.Stop(3000));
        foreach (var (src, cap) in live) {
          var seg = cap.ToSegment();
          cap.Dispose();
          lock (ses.Gate) {
            if (seg.Bytes > 0) {
              src.Finished.Add(seg);
            }
            src.Live = null;
          }
        }
        Task[] closing;
        lock (ses.Gate) {
          closing = ses.Sources.SelectMany(s => s.Closing).ToArray();
        }
        // Each close is bounded (stop, kill, then close the pipe), so this
        // only times out if something is badly stuck. Then keep the
        // session for --recover rather than mix without a segment.
        if (!Task.WaitAll(closing, TimeSpan.FromSeconds(60))) {
          ses.WriteManifest();
          return new MixResult(false, "a segment is still closing; kept " +
            ses.Dir + " for --recover", null);
        }
        List<SegmentInfo> segments;
        lock (ses.Gate) {
          segments = ses.Sources.SelectMany(s => s.Finished)
            .OrderBy(s => s.Start).ToList();
        }
        LastSegments = segments;
        ses.WriteManifest();
        foreach (var s in segments) {
          Log.Info("mix.segment", DescribeSegment(s),
            SegmentFields(ses.Name, s, 0));
        }
        var result = Mixer.MixAndVerify(exe, segments, output, ses.Dir,
          ses.StopAt);
        if (result.Ok) {
          // Mark first: a half-deleted folder must not look unfinished.
          SessionManifest.MarkSaved(ses.Dir, result.OutputPath!);
          if (!keep) {
            TryDeleteDir(ses.Dir);
          }
        }
        return result;
      } catch (Exception e) {
        ses.WriteManifest();
        return new MixResult(false, "save failed: " + e.Message, null);
      }
    }

    void FinishSave(MixResult result) {
      LastResult = result;
      Results.Add(result);
      savesRunning--;
      bool recording = current != null;
      if (!recording && savesRunning == 0) {
        busy.Reset();
      }
      if (recording) {
        // A new recording is on: say so without leaving its pill.
        Pill?.Flash(result.Ok ? "saved" : "save failed");
      } else if (savesRunning == 0) {
        status(result.Ok ? "saved" : "save failed");
        if (result.Ok) {
          Pill?.ShowSaved(Path.GetFileName(result.OutputPath!));
        } else {
          Pill?.ShowError("save failed, see log");
        }
      }
      RunAfterSavesIfIdle();
    }

    Pill ShowPill() {
      Pill ??= new Pill(cfg.DotColor);
      Pill.Place(cfg.Position, cfg.Monitor);
      return Pill;
    }

    static void TryDelete(string path) {
      try {
        File.Delete(path);
        File.Delete(path + ".ffmpeg.log");
      } catch (IOException) {
      }
    }

    static void TryDeleteDir(string dir) {
      try {
        Directory.Delete(dir, true);
      } catch (Exception e) {
        Log.Warn("session.delete_failed", e.Message, new { dir });
      }
    }
  }

  // ------------------------------------------------------------------
  // The pill: a layered, click-through window that never takes focus
  // ------------------------------------------------------------------

  sealed class Pill : Form {
    // Layout in DIPs (scaled by the monitor's DPI).
    const int WidthDip = 122;     // fits m:ss after the waveform
    const int HeightDip = 28;
    const int BarCount = 16;
    const float PadDip = 10;      // left and right inner padding
    const float DotRadiusDip = 3.5f;
    const float BarsLeftDip = 22; // after the dot
    const float BarsWidthDip = 58;
    const float TimeGapDip = 5;   // waveform to elapsed time
    enum Mode { Recording, Saving, Saved, Error }

    readonly float[] bars = new float[BarCount];
    readonly System.Windows.Forms.Timer hideTimer = new();
    Mode mode = Mode.Recording;
    bool micLost;
    bool micMissing;
    bool starting;
    double elapsed;
    string message = "";
    float scale = 1;
    int frame;

    readonly Color recordingDot;
    static readonly StringFormat TextFormat = new() {
      LineAlignment = StringAlignment.Center,
      Trimming = StringTrimming.EllipsisCharacter,
      FormatFlags = StringFormatFlags.NoWrap,
    };
    static readonly StringFormat TimeFormat = new() {
      Alignment = StringAlignment.Near,
      LineAlignment = StringAlignment.Center,
      FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.NoClip,
    };

    public Pill(Color recordingDot) {
      this.recordingDot = recordingDot;
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      StartPosition = FormStartPosition.Manual;
      Text = "audio-capture";
      hideTimer.Tick += (_, _) => {
        hideTimer.Stop();
        Hide();
      };
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams {
      get {
        var cp = base.CreateParams;
        cp.ExStyle |= Native.WsExLayered | Native.WsExNoActivate |
          Native.WsExToolWindow | Native.WsExTopmost | Native.WsExTransparent;
        return cp;
      }
    }

    protected override void WndProc(ref Message m) {
      if (m.Msg == Native.WmMouseActivate) {
        m.Result = (IntPtr)Native.MaNoActivate;
        return;
      }
      base.WndProc(ref m);
    }

    public void Place(PillPosition position, string monitor) {
      var screen = monitor == "cursor"
        ? Screen.FromPoint(Cursor.Position)
        : Screen.PrimaryScreen ?? Screen.AllScreens[0];
      scale = Native.ScaleFor(screen);
      var area = screen.WorkingArea;
      var size = new Size((int)(WidthDip * scale), (int)(HeightDip * scale));
      var loc = PillLayout.Location(position, area, size,
        (int)(16 * scale));
      Bounds = new Rectangle(loc, size);
    }

    public void ShowRecording() {
      hideTimer.Stop();
      Array.Clear(bars);
      mode = Mode.Recording;
      starting = true;
      micLost = false;
      micMissing = false;
      elapsed = 0;
      Appear();
    }

    public void SetMicLost(bool lost) {
      micLost = lost;
      Render();
    }

    string flashText = "";
    long flashUntil;

    /// Shows a device name in place of the waveform for about 2 s.
    public void Flash(string text) {
      flashText = text;
      flashUntil = Environment.TickCount64 + 2000;
      Render();
    }

    public void SetMicMissing() {
      micMissing = true;
      Render();
    }

    public void ShowSaving() {
      mode = Mode.Saving;
      Render();
    }

    public void ShowSaved(string name) {
      mode = Mode.Saved;
      message = "saved";
      Render();
      HideAfter(1500);
    }

    public void ShowError(string text) {
      mode = Mode.Error;
      message = text;
      Appear();
      HideAfter(6000);
    }

    void Appear() {
      if (!Visible) {
        Show();
      }
      Native.SetTopmost(Handle);
      Render();
    }

    void HideAfter(int ms) {
      hideTimer.Stop();
      hideTimer.Interval = ms;
      hideTimer.Start();
    }

    public void Push(float peak, double elapsedSeconds, bool isStarting) {
      Array.Copy(bars, 1, bars, 0, BarCount - 1);
      bars[BarCount - 1] = isStarting ? 0 : PillLayout.BarLevel(peak);
      elapsed = elapsedSeconds;
      starting = isStarting;
      if (++frame % 40 == 0) {
        Native.SetTopmost(Handle); // stay above windows raised since
      }
      Render();
    }

    /// Never lets a drawing error escape into the recorder's tick.
    void Render() {
      try {
        RenderCore();
      } catch (Exception e) when (e is ExternalException or
          ArgumentException or InvalidOperationException) {
        Log.Warn("pill.render_failed", e.Message);
      }
    }

    void RenderCore() {
      if (!IsHandleCreated || !Visible) {
        return;
      }
      int w = Width, h = Height;
      using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint =
          System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        g.Clear(Color.Transparent);
        float r = h / 2f;
        using (var path = Rounded(new RectangleF(0.5f, 0.5f, w - 1, h - 1),
            r)) {
          using var fill = new SolidBrush(Color.FromArgb(240, 22, 22, 26));
          g.FillPath(fill, path);
          using var edge = new Pen(Color.FromArgb(70, 255, 255, 255), 1);
          g.DrawPath(edge, path);
        }
        DrawBody(g, w, h);
      }
      Native.PushLayered(Handle, bmp, Location);
    }

    void DrawBody(Graphics g, int w, int h) {
      float s = scale;
      Color red = Color.FromArgb(255, 255, 69, 58);
      Color amber = Color.FromArgb(255, 255, 179, 64);
      Color green = Color.FromArgb(255, 48, 209, 88);
      Color text = Color.FromArgb(235, 255, 255, 255);
      using var font = new Font("Segoe UI Semibold", 10.5f * s,
        FontStyle.Regular, GraphicsUnit.Pixel);
      float cy = h / 2f;

      Color dot = mode switch {
        Mode.Saving => text,
        Mode.Saved => green,
        Mode.Error => red,
        _ => micLost ? amber : recordingDot,
      };
      // Recording dot pulses gently; while starting it is dim.
      int alpha = mode != Mode.Recording ? 255
        : starting ? 80 + (int)(40 * (0.5 + 0.5 *
          Math.Sin(Environment.TickCount64 / 150.0)))
        : 160 + (int)(95 * (0.5 + 0.5 * Math.Sin(elapsed * 4)));
      using (var b = new SolidBrush(Color.FromArgb(alpha, dot))) {
        float rr = DotRadiusDip * s;
        float cx = (PadDip + DotRadiusDip) * s;
        g.FillEllipse(b, cx - rr, cy - rr, 2 * rr, 2 * rr);
      }

      float left = BarsLeftDip * s;
      float barsRight = (BarsLeftDip + BarsWidthDip) * s;
      float timeLeft = barsRight + TimeGapDip * s;
      float contentRight = w - PadDip * s;
      var textFormat = TextFormat;
      if (mode == Mode.Recording && !micLost &&
          Environment.TickCount64 < flashUntil) {
        using var b = new SolidBrush(text);
        g.DrawString(flashText, font, b,
          new RectangleF(left, 0, timeLeft - left, h), textFormat);
      } else if (mode == Mode.Recording && micLost) {
        using var b = new SolidBrush(amber);
        g.DrawString("mic lost", font, b,
          new RectangleF(left, 0, timeLeft - left, h), textFormat);
      } else if (mode == Mode.Recording) {
        float step = (barsRight - left) / BarCount;
        float bw = Math.Max(1.5f * s, step * 0.55f);
        float maxH = h - 12 * s;
        using var b = new SolidBrush(micMissing || starting
          ? Color.FromArgb(starting ? 90 : 150, 255, 255, 255)
          : text);
        for (int i = 0; i < BarCount; i++) {
          float bh = Math.Max(2 * s, bars[i] * maxH);
          float x = left + i * step;
          using var bar = Rounded(new RectangleF(x, cy - bh / 2, bw, bh),
            bw / 2);
          g.FillPath(b, bar);
        }
      } else {
        string label = mode == Mode.Saving ? "saving" +
          new string('.', 1 + (int)(Environment.TickCount64 / 400 % 3))
          : message;
        using var b = new SolidBrush(mode == Mode.Error ? red : text);
        g.DrawString(label, font, b,
          new RectangleF(left, 0, contentRight - left, h), textFormat);
        return;
      }
      if (starting) {
        return; // no timer until the file's 0:00 is known
      }
      using var tb = new SolidBrush(text);
      var timeFormat = TimeFormat;
      g.DrawString(PillLayout.FormatElapsed(elapsed), font, tb,
        new RectangleF(timeLeft, 0, contentRight - timeLeft, h), timeFormat);
    }

    static GraphicsPath Rounded(RectangleF r, float radius) {
      var p = new GraphicsPath();
      float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
      if (d <= 0) {
        p.AddRectangle(r);
        return p;
      }
      p.AddArc(r.X, r.Y, d, d, 180, 90);
      p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
      p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
      p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
      p.CloseFigure();
      return p;
    }

    public void RefreshSaving() {
      if (mode == Mode.Saving) {
        Render();
      }
    }
  }

  static class PillLayout {
    /// Longest the pill waits for the mic before leaving "starting".
    public const double StartingMaxSeconds = 5;

    public static Point Location(PillPosition pos, Rectangle area, Size size,
        int margin) {
      int x = pos switch {
        PillPosition.BottomLeft or PillPosition.TopLeft => area.Left + margin,
        PillPosition.BottomCenter or PillPosition.TopCenter =>
          area.Left + (area.Width - size.Width) / 2,
        _ => area.Right - margin - size.Width,
      };
      int y = pos is PillPosition.TopLeft or PillPosition.TopRight or
          PillPosition.TopCenter
        ? area.Top + margin
        : area.Bottom - margin - size.Height;
      return new Point(x, y);
    }

    /// Maps a 0..1 peak onto 0..1 bar height over a -50..0 dB range.
    public static float BarLevel(float peak) {
      if (peak <= 0) {
        return 0;
      }
      double db = 20 * Math.Log10(peak);
      return (float)Math.Clamp((db + 50) / 50, 0, 1);
    }

    public static string FormatElapsed(double seconds) {
      var t = TimeSpan.FromSeconds(Math.Max(0, Math.Floor(seconds)));
      return t.TotalHours >= 1
        ? $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}"
        : $"{t.Minutes}:{t.Seconds:00}";
    }
  }

  // ------------------------------------------------------------------
  // App shell: hotkey, tray icon, and signals from other instances
  // ------------------------------------------------------------------

  sealed class App : IDisposable {
    readonly Control invoker = new();
    readonly HotkeyWindow hotkeys = new();
    readonly NotifyIcon tray = new();
    readonly System.Windows.Forms.Timer timer = new() { Interval = 50 };
    readonly List<EventWaitHandle> signals = new();
    readonly Recorder recorder;
    readonly MMDeviceSource endpoints;
    readonly string? configPath;
    AppConfig cfg;
    volatile bool quitting;
    public static App? Current { get; private set; }

    public void WriteManifestNow() => recorder.WriteManifestNow();

    public App(LoadedConfig loaded, string? configPath) {
      this.configPath = configPath;
      cfg = loaded.Config;
      Log.Info("config.loaded", "config " + (loaded.Path ?? "(defaults)"),
        new { path = loaded.Path });
      foreach (string dir in SessionManifest.Unfinished(Paths.SessionsDir)) {
        Log.Warn("session.unfinished", "unfinished session; mix it with " +
          "--recover", new { dir });
      }
      foreach (string w in loaded.Warnings) {
        Log.Warn("config.warning", w);
      }
      invoker.CreateControl();
      _ = invoker.Handle;
      endpoints = new MMDeviceSource();
      Log.Info("devices.watch", "device changes via " +
        (endpoints.UsesNotifications ? "MMDevice notifications" : "polling"));
      recorder = new Recorder(invoker, cfg, endpoints, SetStatus);
      Current = this;
      foreach (string name in Program.SignalNames) {
        signals.Add(new EventWaitHandle(false, EventResetMode.AutoReset,
          Program.SignalEventName(name)));
      }
    }

    public void Run(bool startNow) {
      hotkeys.Pressed += () => OnCommand("toggle");
      RegisterHotkey();
      SetupTray();
      timer.Tick += (_, _) => {
        recorder.Tick();
        if (recorder.State == RecorderState.Saving) {
          recorder.Pill?.RefreshSaving();
        }
      };
      timer.Start();
      SystemEvents.PowerModeChanged += (_, e) => {
        if (e.Mode == PowerModes.Suspend &&
            recorder.State == RecorderState.Recording) {
          Log.Info("power.suspend", "system suspending; stopping and saving");
          recorder.Stop();
        }
      };
      var waiter = new Thread(WaitForSignals) {
        IsBackground = true, Name = "signals",
      };
      waiter.Start();
      if (startNow) {
        OnCommand("start");
      }
      Application.Run();
    }

    void RegisterHotkey() {
      string? error = hotkeys.Register(cfg.Toggle);
      if (error != null) {
        Log.Warn("hotkey.unavailable", error, new { chord = cfg.Toggle.Text });
        tray.Text = Clip($"audio-capture: {cfg.Toggle.Text} unavailable");
        tray.ShowBalloonTip(5000, "audio-capture",
          $"Could not register {cfg.Toggle.Text}: {error}",
          ToolTipIcon.Warning);
      } else {
        Log.Info("hotkey.registered", "hotkey registered",
          new { chord = cfg.Toggle.Text });
      }
    }

    void SetupTray() {
      tray.Icon = TrayIcon.Make();
      tray.Text = Clip($"audio-capture: idle ({cfg.Toggle.Text})");
      var menu = new ContextMenuStrip();
      menu.Items.Add("Start / stop recording", null,
        (_, _) => OnCommand("toggle"));
      menu.Items.Add("Open recordings folder", null, (_, _) => {
        string dir = Path.GetDirectoryName(Paths.OutputFile(cfg,
          DateTime.Now))!;
        Directory.CreateDirectory(dir);
        Process.Start(new ProcessStartInfo("explorer.exe", dir) {
          UseShellExecute = true,
        });
      });
      menu.Items.Add("Open log", null, (_, _) =>
        Process.Start(new ProcessStartInfo("notepad.exe", Log.FilePath) {
          UseShellExecute = true,
        }));
      menu.Items.Add("Quit", null, (_, _) => OnCommand("quit"));
      tray.ContextMenuStrip = menu;
      tray.Visible = true;
    }

    static string Clip(string s) => s.Length > 63 ? s[..63] : s;

    void SetStatus(string status) {
      tray.Text = Clip($"audio-capture: {status} ({cfg.Toggle.Text})");
    }

    void WaitForSignals() {
      var handles = signals.Cast<WaitHandle>().ToArray();
      while (!quitting) {
        int i = WaitHandle.WaitAny(handles);
        string name = Program.SignalNames[i];
        try {
          invoker.BeginInvoke(() => OnCommand(name));
        } catch (InvalidOperationException) {
          return;
        }
        if (name == "quit") {
          return;
        }
      }
    }

    void OnCommand(string name) {
      Log.Info("command", name, new { command = name });
      switch (name) {
        case "toggle":
          if (recorder.State != RecorderState.Recording) {
            ReloadConfig();
          }
          recorder.Toggle();
          break;
        case "start":
          if (recorder.State != RecorderState.Recording) {
            ReloadConfig();
            recorder.Start();
          }
          break;
        case "stop":
          recorder.Stop();
          break;
        case "quit":
          quitting = true;
          recorder.Closing = true;
          recorder.Stop(() => {
            tray.Visible = false;
            Application.ExitThread();
          });
          break;
      }
    }

    /// Picks up config edits at each recording start. The hotkey only
    /// changes on restart.
    void ReloadConfig() {
      try {
        var loaded = ConfigLoader.Load(configPath);
        foreach (string w in loaded.Warnings) {
          Log.Warn("config.warning", w);
        }
        if (loaded.Config.Toggle != cfg.Toggle) {
          Log.Warn("config.hotkey_changed", "keys.toggle changed; restart " +
            "audio-capture to apply");
        }
        cfg = loaded.Config with { Toggle = cfg.Toggle };
        recorder.UpdateConfig(cfg);
      } catch (Exception e) {
        Log.Error("config.reload_failed", "config reload failed; keeping the " +
          "previous config", new { error = e.Message });
      }
    }

    public void Dispose() {
      timer.Dispose();
      hotkeys.Dispose();
      tray.Dispose();
      endpoints.Dispose();
      foreach (var s in signals) {
        s.Dispose();
      }
      invoker.Dispose();
    }
  }

  sealed class HotkeyWindow : NativeWindow, IDisposable {
    const int Id = 1;
    bool registered;
    public event Action? Pressed;

    public HotkeyWindow() {
      // A message-only window: it receives WM_HOTKEY and nothing else.
      CreateHandle(new CreateParams { Parent = new IntPtr(-3) });
    }

    /// Returns null on success, else a reason.
    public string? Register(Chord chord) {
      if (Native.RegisterHotKey(Handle, Id,
          chord.Modifiers | Native.ModNoRepeat, chord.VirtualKey)) {
        registered = true;
        return null;
      }
      int err = Marshal.GetLastWin32Error();
      return err == 1409
        ? "another program already uses it"
        : $"Windows error {err}";
    }

    protected override void WndProc(ref Message m) {
      if (m.Msg == Native.WmHotkey && (int)m.WParam == Id) {
        Pressed?.Invoke();
        return;
      }
      base.WndProc(ref m);
    }

    public void Dispose() {
      if (registered) {
        Native.UnregisterHotKey(Handle, Id);
      }
      DestroyHandle();
    }
  }

  static class TrayIcon {
    public static Icon Make() {
      using var bmp = new Bitmap(32, 32, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        using var dark = new SolidBrush(Color.FromArgb(255, 22, 22, 26));
        g.FillEllipse(dark, 1, 1, 30, 30);
        using var red = new SolidBrush(Color.FromArgb(255, 255, 69, 58));
        g.FillEllipse(red, 9, 9, 14, 14);
      }
      return Icon.FromHandle(bmp.GetHicon());
    }
  }

  // ------------------------------------------------------------------
  // Win32
  // ------------------------------------------------------------------

  static class Native {
    public const int WsExLayered = 0x00080000;
    public const int WsExNoActivate = 0x08000000;
    public const int WsExToolWindow = 0x00000080;
    public const int WsExTopmost = 0x00000008;
    public const int WsExTransparent = 0x00000020;
    public const int WmMouseActivate = 0x0021;
    public const int MaNoActivate = 3;
    public const int WmHotkey = 0x0312;
    public const uint ModNoRepeat = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id,
      uint modifiers, uint vk);

    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y,
      int cx, int cy, uint flags);

    public static void SetTopmost(IntPtr hwnd) {
      // HWND_TOPMOST; SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
      SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x1 | 0x2 | 0x10);
    }

    [DllImport("kernel32.dll")]
    static extern bool AttachConsole(int processId);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int handle);

    /// A WinExe has no console. Attach to the parent's when stdout isn't
    /// already redirected (a pipe from WSL or a file).
    public static void EnsureConsole() {
      IntPtr h = GetStdHandle(-11);
      if (h == IntPtr.Zero || h == new IntPtr(-1)) {
        AttachConsole(-1);
      }
    }

    [DllImport("ntdll.dll")]
    static extern int NtSuspendProcess(IntPtr process);

    /// Freezes a process, the way a vanished USB device freezes FFmpeg.
    public static void SuspendProcess(int pid) {
      using var p = Process.GetProcessById(pid);
      NtSuspendProcess(p.Handle);
    }

    [DllImport("kernel32.dll")]
    static extern bool SetStdHandle(int which, IntPtr handle);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    public static void DetachStdHandles() {
      foreach (int which in new[] { -10, -11, -12 }) {
        IntPtr h = GetStdHandle(which);
        if (h != IntPtr.Zero && h != new IntPtr(-1)) {
          CloseHandle(h);
        }
        SetStdHandle(which, IntPtr.Zero);
      }
    }

    [DllImport("kernel32.dll")]
    static extern uint SetThreadExecutionState(uint flags);

    public static void KeepAwake(bool on) {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
      SetThreadExecutionState(on ? 0x80000001u : 0x80000000u);
    }

    [DllImport("shcore.dll")]
    static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x,
      out uint y);

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromPoint(Point pt, uint flags);

    public static float ScaleFor(Screen screen) {
      try {
        var center = new Point(
          screen.Bounds.Left + screen.Bounds.Width / 2,
          screen.Bounds.Top + screen.Bounds.Height / 2);
        IntPtr mon = MonitorFromPoint(center, 2);
        if (GetDpiForMonitor(mon, 0, out uint dpi, out _) == 0) {
          return dpi / 96f;
        }
      } catch (DllNotFoundException) {
      }
      return 1;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct NativePoint {
      public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct NativeSize {
      public int Cx, Cy;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct BlendFunction {
      public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst,
      ref NativePoint dst, ref NativeSize size, IntPtr hdcSrc,
      ref NativePoint src, int key, ref BlendFunction blend, int flags);

    [DllImport("user32.dll")]
    static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateCompatibleDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    static extern bool DeleteDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);

    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr obj);

    /// Draws a per-pixel-alpha bitmap as the window's whole surface.
    public static void PushLayered(IntPtr hwnd, Bitmap bmp, Point location) {
      IntPtr screen = GetDC(IntPtr.Zero);
      IntPtr mem = CreateCompatibleDC(screen);
      IntPtr hbmp = bmp.GetHbitmap(Color.FromArgb(0));
      IntPtr old = SelectObject(mem, hbmp);
      try {
        var size = new NativeSize { Cx = bmp.Width, Cy = bmp.Height };
        var src = new NativePoint();
        var dst = new NativePoint { X = location.X, Y = location.Y };
        var blend = new BlendFunction {
          BlendOp = 0, SourceConstantAlpha = 255, AlphaFormat = 1,
        };
        UpdateLayeredWindow(hwnd, screen, ref dst, ref size, mem, ref src, 0,
          ref blend, 2);
      } finally {
        SelectObject(mem, old);
        DeleteObject(hbmp);
        DeleteDC(mem);
        ReleaseDC(IntPtr.Zero, screen);
      }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr attributes,
      string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass,
      IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job,
      IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    public struct JobBasicLimitInformation {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IoCounters {
      public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
      public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JobExtendedLimitInformation {
      public JobBasicLimitInformation BasicLimitInformation;
      public IoCounters IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }
  }

  // ------------------------------------------------------------------
  // Simulation: scripted device changes with fake mics, checked by tone
  // ------------------------------------------------------------------

  /// A stretch of the output where one tone is present.
  sealed record ToneRun(int Hz, double From, double To);

  static class ToneAnalysis {
    public const double WindowSeconds = 0.02;

    /// Goertzel amplitude of one frequency in a window of mono samples.
    public static double Amplitude(ReadOnlySpan<float> x, double hz,
        int rate) {
      double w = 2 * Math.PI * hz / rate;
      double coeff = 2 * Math.Cos(w), s1 = 0, s2 = 0;
      foreach (float v in x) {
        double s0 = v + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      double power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      return 2 * Math.Sqrt(Math.Max(power, 0)) / x.Length;
    }

    /// Runs of each tone across 20 ms windows; a tone counts when its
    /// amplitude is over the threshold.
    public static List<ToneRun> Runs(float[] mono, int rate, int[] tones,
        double threshold) {
      int n = (int)(rate * WindowSeconds);
      var runs = new List<ToneRun>();
      foreach (int hz in tones) {
        double? from = null;
        int windows = mono.Length / n;
        for (int i = 0; i <= windows; i++) {
          bool on = i < windows &&
            Amplitude(mono.AsSpan(i * n, n), hz, rate) > threshold;
          double t = i * WindowSeconds;
          if (on && from == null) {
            from = t;
          } else if (!on && from != null) {
            runs.Add(new ToneRun(hz, from.Value, t));
            from = null;
          }
        }
      }
      return runs.OrderBy(r => r.From).ToList();
    }

    /// Joins runs of the same tone separated by less than `gap` (a single
    /// weak window at a mix boundary).
    public static List<ToneRun> Merge(List<ToneRun> runs, double gap) {
      var result = new List<ToneRun>();
      foreach (var r in runs.OrderBy(r => r.Hz).ThenBy(r => r.From)) {
        if (result.Count > 0 && result[^1].Hz == r.Hz &&
            r.From - result[^1].To < gap) {
          result[^1] = result[^1] with { To = r.To };
        } else {
          result.Add(r);
        }
      }
      return result.OrderBy(r => r.From).ToList();
    }

    public static float[] DecodeMono(string ffmpeg, string mp3, string tmp) {
      var run = Proc.Run(ffmpeg, new[] {
        "-hide_banner", "-nostdin", "-v", "error", "-y", "-i", mp3,
        "-ac", "1", "-ar", "48000", "-f", "f32le", tmp,
      }, 120000);
      if (run.ExitCode != 0) {
        throw new InvalidOperationException("decode failed: " + run.Stderr);
      }
      byte[] bytes = File.ReadAllBytes(tmp);
      var samples = new float[bytes.Length / 4];
      Buffer.BlockCopy(bytes, 0, samples, 0, samples.Length * 4);
      return samples;
    }
  }

  static class Simulator {
    public static readonly string[] Scenarios = {
      "replug", "bump", "airpods", "console-change", "back-to-back",
    };

    const int SystemHz = 150;
    static readonly Dictionary<string, (string Name, int Hz)> Devices = new() {
      ["yeti"] = ("Yeti Microphone - Main (Yeti Stereo Microphone)", 440),
      ["surface"] = ("Microphone (Surface Stereo Microphones)", 660),
      ["airpods"] = ("Headset (AirPods Pro)", 880),
    };

    public static int Run(string scenario) {
      if (scenario == "all") {
        int failed = 0;
        foreach (string s in Scenarios) {
          failed += Run(s) == 0 ? 0 : 1;
        }
        Console.WriteLine(failed == 0 ? "all scenarios passed"
          : $"{failed} scenarios failed");
        return failed == 0 ? 0 : 1;
      }
      if (!Scenarios.Contains(scenario)) {
        Console.Error.WriteLine($"unknown scenario '{scenario}'; try " +
          string.Join(", ", Scenarios) + ", or all");
        return 2;
      }
      string dir = StateDir.Simulate;
      Directory.CreateDirectory(dir);
      var fake = new FakeEndpointSource();
      fake.Add("yeti", Devices["yeti"].Name);
      fake.Add("surface", Devices["surface"].Name);
      fake.SetDefault(CaptureRole.Communications, "yeti");
      fake.SetDefault(CaptureRole.Console, "yeti");
      var cfg = new AppConfig {
        OutputDir = dir.Replace("{", "").Replace("}", ""),
        OutputName = scenario + "-{HHmmss}.mp3",
        System = $"lavfi:sine=frequency={SystemHz}:sample_rate=48000",
        Mic = "communications",
        KeepSession = true,
      };
      var resolver = new FakeResolver(e => Devices.TryGetValue(e.Id,
          out var d) ? $"sine=frequency={d.Hz}:sample_rate=48000" : null);
      Log.Info("simulate.start", scenario, new { scenario });
      Console.WriteLine($"== {scenario}");

      using var invoker = new Control();
      invoker.CreateControl();
      var recorder = new Recorder(invoker, cfg, fake, _ => { },
        (_, _) => resolver);
      using var ticker = new System.Windows.Forms.Timer { Interval = 50 };
      ticker.Tick += (_, _) => recorder.Tick();
      ticker.Start();
      int exit = 1;
      var events = new List<string>();
      var backToBack = new List<bool>();
      void Note(string what) {
        string line = $"{recorder.Elapsed,7:0.000} s  {what}";
        events.Add(line);
        Console.WriteLine("   " + line);
      }
      async Task Unplug(string id, string? newDefault) {
        if (recorder.MicPid is int pid) {
          Native.SuspendProcess(pid); // the device stops sending audio
        }
        fake.SetState(id, CoreAudio.DeviceStateNotPresent);
        fake.SetDefault(CaptureRole.Communications, newDefault);
        fake.SetDefault(CaptureRole.Console, newDefault);
        Note($"unplug {id}; default -> {newDefault}");
        await Task.CompletedTask;
      }
      void Replug(string id) {
        fake.SetState(id, CoreAudio.DeviceStateActive);
        fake.SetDefault(CaptureRole.Communications, id);
        fake.SetDefault(CaptureRole.Console, id);
        Note($"replug {id}; default -> {id}");
      }
      async Task Script() {
        recorder.Start();
        Note("start");
        switch (scenario) {
          case "replug":
            await Task.Delay(3000);
            await Unplug("yeti", "surface");
            await Task.Delay(4000);
            Replug("yeti");
            await Task.Delay(3000);
            break;
          case "bump":
            await Task.Delay(3000);
            await Unplug("yeti", "surface");
            await Task.Delay(700);
            Replug("yeti");
            await Task.Delay(4000);
            break;
          case "airpods":
            await Task.Delay(3000);
            fake.Add("airpods", Devices["airpods"].Name);
            fake.SetDefault(CaptureRole.Communications, "airpods");
            Note("airpods connect; communications default -> airpods");
            await Task.Delay(4000);
            break;
          case "console-change":
            await Task.Delay(3000);
            fake.SetDefault(CaptureRole.Console, "surface");
            Note("console default -> surface (communications unchanged)");
            await Task.Delay(3000);
            break;
          case "back-to-back":
            // Stop, then start the next recording while the first saves.
            await Task.Delay(2000);
            recorder.Stop();
            Note("stop 1 (saving in the background)");
            recorder.Start();
            backToBack.Add(recorder.State == RecorderState.Recording &&
              Commands.IsBusy());
            Note($"start 2 while saving: state {recorder.State}, busy " +
              Commands.IsBusy());
            await Task.Delay(2500);
            break;
        }
        Note("stop");
        recorder.Stop(() => {
          try {
            if (scenario == "back-to-back") {
              exit = CheckBackToBack(recorder, backToBack[0]) ? 0 : 1;
              Application.ExitThread();
              return;
            }
            exit = Check(scenario, recorder, cfg) ? 0 : 1;
          } catch (Exception e) {
            Console.WriteLine("   check failed: " + e.Message);
          }
          Application.ExitThread();
        });
      }
      invoker.BeginInvoke(async () => {
        try {
          await Script();
        } catch (Exception e) {
          Console.WriteLine("   script failed: " + e);
          Application.ExitThread();
        }
      });
      Application.Run();
      recorder.Pill?.Dispose();
      Log.Info("simulate.done", scenario, new { scenario, passed = exit == 0 });
      return exit;
    }

    /// Both sessions saved, the second started while the first was still
    /// saving, and the busy flag clears only after both.
    static bool CheckBackToBack(Recorder recorder, bool startedWhileSaving) {
      bool ok = true;
      void Expect(string what, bool pass) {
        Console.WriteLine($"   {(pass ? "ok  " : "FAIL")} {what}");
        ok &= pass;
      }
      foreach (var r in recorder.Results) {
        Console.WriteLine("   " + r.Message);
      }
      Expect("second recording started while the first saved",
        startedWhileSaving);
      Expect($"two sessions saved ({recorder.Results.Count(r => r.Ok)})",
        recorder.Results.Count(r => r.Ok) == 2);
      Expect("busy flag clear after both saves", !Commands.IsBusy());
      Expect("state idle", recorder.State == RecorderState.Idle);
      return ok;
    }

    static bool Check(string scenario, Recorder recorder, AppConfig cfg) {
      var result = recorder.LastResult;
      if (result == null || !result.Ok) {
        Console.WriteLine("   FAIL save: " + (result?.Message ?? "no result"));
        return false;
      }
      Console.WriteLine("   " + result.Message);
      string ffmpeg = FfmpegLocator.Find(cfg.Ffmpeg);
      var mono = ToneAnalysis.DecodeMono(ffmpeg, result.OutputPath!,
        Path.Combine(Path.GetTempPath(), "audio-capture-sim.f32"));
      var tones = new[] { SystemHz }.Concat(Devices.Values.Select(d => d.Hz))
        .ToArray();
      // lavfi sine amplitude is 1/8; mixed tones keep it.
      var runs = ToneAnalysis.Merge(
        ToneAnalysis.Runs(mono, 48000, tones, 0.04), 0.05);
      double length = mono.Length / 48000.0;
      var mic = runs.Where(r => r.Hz != SystemHz).ToList();
      Console.WriteLine($"   output {length:0.000} s; mic tones:");
      foreach (var r in mic) {
        Console.WriteLine($"     {r.Hz} Hz {r.From,7:0.000} .. {r.To,7:0.000} s");
      }
      bool ok = true;
      void Expect(string what, bool pass) {
        Console.WriteLine($"   {(pass ? "ok  " : "FAIL")} {what}");
        ok &= pass;
      }
      double sys = runs.Where(r => r.Hz == SystemHz).Sum(r => r.To - r.From);
      Expect($"system tone covers the file ({sys:0.00} of {length:0.00} s)",
        sys >= length - 0.1);

      // Alignment: each mic segment's tone sits where the recorder placed
      // it, measured from the earliest segment.
      var segs = recorder.LastSegments;
      double origin = segs.Min(x => x.Start);
      double stop = origin + length;
      foreach (var seg in segs.Where(x => x.Kind == "mic")) {
        int hz = Devices.Values.First(d => d.Name == seg.Device).Hz;
        double from = seg.Start - origin;
        double to = Math.Min(Mixer.EndOf(seg, null), stop) - origin;
        var run = mic.Where(r => r.Hz == hz && r.To > from && r.From < to)
          .OrderByDescending(r => Math.Min(r.To, to) - Math.Max(r.From, from))
          .FirstOrDefault();
        bool placed = run != null && Math.Abs(run.From - from) <= 0.04 &&
          Math.Abs(run.To - to) <= 0.04;
        Expect($"{hz} Hz placed at {from:0.000}..{to:0.000} s" + (run == null
          ? " (not found)"
          : $" (heard {run.From:0.000}..{run.To:0.000})"), placed);
      }

      var order = new List<int>();
      foreach (var r in mic) {
        if (order.Count == 0 || order[^1] != r.Hz) {
          order.Add(r.Hz);
        }
      }
      double maxGap = 0;
      for (int i = 1; i < mic.Count; i++) {
        maxGap = Math.Max(maxGap, mic[i].From - mic[i - 1].To);
      }
      double overlap = 0;
      for (int i = 1; i < mic.Count; i++) {
        overlap = Math.Max(overlap, mic[i - 1].To - mic[i].From);
      }
      string seq = string.Join(" -> ", order);
      switch (scenario) {
        case "replug":
          Expect($"tones 440 -> 660 -> 440 (got {seq})",
            seq == "440 -> 660 -> 440");
          Expect($"unplug gap under 2.5 s ({maxGap:0.00} s)", maxGap < 2.5);
          break;
        case "bump":
          Expect($"ends on 440 (got {seq})", order.LastOrDefault() == 440);
          Expect($"bump gap under 2.5 s ({maxGap:0.00} s)", maxGap < 2.5);
          break;
        case "airpods":
          Expect($"tones 440 -> 880 (got {seq})", seq == "440 -> 880");
          Expect($"seamless switch: gap {maxGap * 1000:0} ms, overlap " +
            $"{overlap * 1000:0} ms", maxGap <= 0.06 && overlap <= 0.06);
          break;
        case "console-change":
          Expect($"stays on 440 (got {seq})", seq == "440");
          Expect($"no gap ({maxGap:0.00} s)", mic.Count == 1);
          break;
      }
      return ok;
    }
  }

  // ------------------------------------------------------------------
  // Self-tests for the pure parts: audio-capture --self-test
  // ------------------------------------------------------------------

  static class SelfTests {
    static int passed;
    static readonly List<string> Failures = new();

    static void Check(string name, bool ok, string detail = "") {
      if (ok) {
        passed++;
      } else {
        Failures.Add(name + (detail.Length > 0 ? ": " + detail : ""));
      }
    }

    static void Eq<T>(string name, T expected, T actual) =>
      Check(name, EqualityComparer<T>.Default.Equals(expected, actual),
        $"expected <{expected}>, got <{actual}>");

    static void Throws<TException>(string name, Action action)
        where TException : Exception {
      try {
        action();
        Check(name, false, "no exception");
      } catch (TException) {
        Check(name, true);
      } catch (Exception e) {
        Check(name, false, "wrong exception " + e.GetType().Name);
      }
    }

    public static int Run() {
      var tests = new (string, Action)[] {
        ("toml", TestToml),
        ("chord", TestChord),
        ("config", TestConfig),
        ("templates", TestTemplates),
        ("dshow", TestDirectShow),
        ("match", TestMatch),
        ("policy", TestMicPolicy),
        ("tones", TestTones),
        ("manifest", TestManifest),
        ("log", TestLogFormat),
        ("state", TestStateDir),
        ("capture", TestCaptureLifecycle),
        ("health", TestHealth),
        ("timing", TestTiming),
        ("mix", TestMix),
        ("layout", TestLayout),
        ("cli", TestCli),
      };
      foreach (var (name, test) in tests) {
        try {
          test();
        } catch (Exception e) {
          Failures.Add($"{name}: threw {e.GetType().Name}: {e.Message}");
        }
      }
      foreach (string f in Failures) {
        Console.WriteLine("FAIL " + f);
      }
      Console.WriteLine($"{passed} passed, {Failures.Count} failed");
      return Failures.Count == 0 ? 0 : 1;
    }

    static void TestToml() {
      var v = Toml.Parse(
        "# comment\n" +
        "top = 1\n" +
        "[keys]\n" +
        "toggle = \"ctrl+alt+f2\"  # trailing\n" +
        "[audio]\r\n" +
        "mic = 'C:\\raw\\path'\n" +
        "esc = \"a\\\"b\\\\c\\u0041\"\n" +
        "flag = true\n" +
        "rate = 1.5\n" +
        "big = 1_000\n" +
        "hash = \"has # inside\"\n" +
        "[pill.inner]\n" +
        "\"quoted key\" = false\n");
      Eq("toml top", (object)1L, v["top"]);
      Eq("toml string", (object)"ctrl+alt+f2", v["keys.toggle"]);
      Eq("toml literal", (object)"C:\\raw\\path", v["audio.mic"]);
      Eq("toml escapes", (object)"a\"b\\cA", v["audio.esc"]);
      Eq("toml bool", (object)true, v["audio.flag"]);
      Eq("toml float", (object)1.5, v["audio.rate"]);
      Eq("toml underscore", (object)1000L, v["audio.big"]);
      Eq("toml hash in string", (object)"has # inside", v["audio.hash"]);
      Eq("toml dotted table", (object)false, v["pill.inner.quoted key"]);
      Throws<TomlException>("toml bare word", () => Toml.Parse("a = b"));
      Throws<TomlException>("toml unclosed", () => Toml.Parse("a = \"b"));
      Throws<TomlException>("toml dup", () => Toml.Parse("a = 1\na = 2"));
      Throws<TomlException>("toml array", () => Toml.Parse("a = [1]"));
      Throws<TomlException>("toml no eq", () => Toml.Parse("[x]\nfoo"));
      Throws<TomlException>("toml tail", () => Toml.Parse("a = 1 2"));
      try {
        Toml.Parse("a = 1\n\nb = nope");
      } catch (TomlException e) {
        Check("toml line number", e.Message.StartsWith("line 3:"), e.Message);
      }
    }

    static void TestChord() {
      var c = Chord.Parse("ctrl+alt+f2");
      Eq("chord mods", Chord.ModControl | Chord.ModAlt, c.Modifiers);
      Eq("chord f2", 0x71u, c.VirtualKey);
      Eq("chord f24", 0x87u, Chord.Parse("f24").VirtualKey);
      Eq("chord letter", (uint)'R', Chord.Parse("ctrl+r").VirtualKey);
      Eq("chord upper adds shift", Chord.ModControl | Chord.ModShift,
        Chord.Parse("ctrl+R").Modifiers);
      Eq("chord case", Chord.ModControl | Chord.ModShift,
        Chord.Parse("Ctrl+Shift+F9").Modifiers);
      Eq("chord digit", (uint)'5', Chord.Parse("alt+5").VirtualKey);
      Eq("chord named", 0xBDu, Chord.Parse("ctrl+minus").VirtualKey);
      Eq("chord win", Chord.ModWin, Chord.Parse("super+space").Modifiers);
      Eq("chord spaces", 0x71u, Chord.Parse(" ctrl + f2 ").VirtualKey);
      Throws<FormatException>("chord prefix", () => Chord.Parse("prefix+d"));
      Throws<FormatException>("chord only mods", () => Chord.Parse("ctrl+alt"));
      Throws<FormatException>("chord two keys", () => Chord.Parse("a+b"));
      Throws<FormatException>("chord unknown", () => Chord.Parse("ctrl+foo"));
      Throws<FormatException>("chord f25", () => Chord.Parse("f25"));
      Throws<FormatException>("chord plus", () => Chord.Parse("ctrl++"));
      Throws<FormatException>("chord empty", () => Chord.Parse(" "));
    }

    static void TestConfig() {
      var (d, w0) = AppConfig.FromToml("");
      Eq("config default toggle", "ctrl+alt+f2", d.Toggle.Text);
      Eq("config default mic", "communications", d.Mic);
      Eq("config no warnings", 0, w0.Count);
      var (c, w) = AppConfig.FromToml(
        "[keys]\ntoggle = \"ctrl+f2\"\n" +
        "[pill]\nposition = \"bottom-center\"\nmonitor = \"cursor\"\n" +
        "[output]\ndir = \"D:/rec/{yyyy}\"\n" +
        "[audio]\nmic = \"none\"\ntypo = \"x\"\n");
      Eq("config toggle", 0x71u, c.Toggle.VirtualKey);
      Eq("config position", PillPosition.BottomCenter, c.Position);
      Eq("config monitor", "cursor", c.Monitor);
      Eq("config dir", "D:/rec/{yyyy}", c.OutputDir);
      Eq("config mic", "none", c.Mic);
      Eq("config unknown warns", 1, w.Count);
      var (dc, dw) = AppConfig.FromToml("[pill]\ndot_color = \"#E5484D\"\n");
      Eq("config dot color", Color.FromArgb(255, 0xE5, 0x48, 0x4D).ToArgb(),
        dc.DotColor.ToArgb());
      Eq("config dot color no warning", 0, dw.Count);
      var (bc, bw) = AppConfig.FromToml("[pill]\ndot_color = \"red\"\n");
      Eq("config bad dot color falls back",
        AppConfig.DefaultDotColor.ToArgb(), bc.DotColor.ToArgb());
      Eq("config bad dot color warns", 1, bw.Count);
      Eq("hex short", null, AppConfig.ParseHexColor("#fff"));
      Eq("hex no hash", null, AppConfig.ParseHexColor("e5484d"));
      Throws<FormatException>("config bad position",
        () => AppConfig.FromToml("[pill]\nposition = \"middle\"\n"));
      Throws<FormatException>("config bad chord",
        () => AppConfig.FromToml("[keys]\ntoggle = \"prefix+x\"\n"));
      Throws<FormatException>("config non-string",
        () => AppConfig.FromToml("[audio]\nmic = 3\n"));
      Throws<FormatException>("config bad template",
        () => AppConfig.FromToml("[output]\nname = \"{nope}.mp3\"\n"));
    }

    static void TestTemplates() {
      var when = new DateTime(2026, 11, 3, 9, 5, 7);
      string F(string n) => n == "documents" ? "C:\\Users\\u\\Documents" : "?";
      Eq("template default dir",
        "C:\\Users\\u\\Documents/ShareX/Screenshots/2026-11",
        Templates.Expand("{documents}/ShareX/Screenshots/{yyyy-MM}", when, F));
      Eq("template default name", "26-11-03__090507-audio.mp3",
        Templates.Expand("{yy-MM-dd}__{HHmmss}-audio.mp3", when, F));
      Eq("template folder case", "C:\\Users\\u\\Documents",
        Templates.Expand("{Documents}", when, F));
      Throws<FormatException>("template unclosed",
        () => Templates.Expand("{yyyy", when, F));
      Throws<FormatException>("template stray",
        () => Templates.Expand("a}b", when, F));
      Throws<FormatException>("template unknown",
        () => Templates.Expand("{user}", when, F));
      Eq("unique free", "C:\\a\\x.mp3",
        Paths.Unique("C:\\a\\x.mp3", _ => false));
      var taken = new HashSet<string> { "C:\\a\\x.mp3", "C:\\a\\x-2.mp3" };
      Eq("unique taken", "C:\\a\\x-3.mp3",
        Paths.Unique("C:\\a\\x.mp3", taken.Contains));
      var cands = FfmpegLocator.Candidates("", "C:\\bin; ;D:\\tools",
        "C:\\Program Files", null).ToList();
      Eq("ffmpeg candidates", 3, cands.Count);
      Eq("ffmpeg path first", "C:\\bin\\ffmpeg.exe", cands[0]);
      Eq("ffmpeg sharex last", "C:\\Program Files\\ShareX\\ffmpeg.exe",
        cands[2]);
    }

    const string ListOutput =
      "[in#0 @ 01] \"Surface Camera Front\" (video)\r\n" +
      "[in#0 @ 01]   Alternative name \"@device_pnp_\\\\?\\display#x\"\r\n" +
      "[in#0 @ 01] \"Yeti Microphone - Main (Yeti Stereo Microphone)\" " +
      "(audio)\r\n" +
      "[in#0 @ 01]   Alternative name \"@device_cm_{33D9A762-90C8-11D0-BD43-" +
      "00A0C911CE86}\\wave_{AF25D041-8695-4E1C-8672-B28919582119}\"\r\n" +
      "[in#0 @ 01] \"virtual-audio-capturer\" (audio)\r\n" +
      "[in#0 @ 01]   Alternative name \"@device_sw_{33D9A762-90C8-11D0-BD43-" +
      "00A0C911CE86}\\{8E146464-DB61-4309-AFA1-3578E927E935}\"\r\n" +
      "Error opening input file dummy.\r\n";

    static void TestDirectShow() {
      var d = DirectShow.Parse(ListOutput);
      Eq("dshow count", 2, d.Count);
      Eq("dshow name", "Yeti Microphone - Main (Yeti Stereo Microphone)",
        d[0].Name);
      Check("dshow alt", d[0].AlternativeName!.EndsWith(
        "wave_{AF25D041-8695-4E1C-8672-B28919582119}"));
      Eq("dshow system", "virtual-audio-capturer", d[1].Name);
      Eq("dshow empty", 0, DirectShow.Parse("nothing here").Count);
    }

    static void TestMatch() {
      var devices = DirectShow.Parse(ListOutput);
      var yeti = new Endpoint(
        "{0.0.1.00000000}.{af25d041-8695-4e1c-8672-b28919582119}",
        "Something Else", 1);
      var m = DeviceMatch.ForEndpoint(yeti, devices, "virtual-audio-capturer");
      Eq("match guid method", "EndpointGuid", m?.Method);
      Check("match spec is alt name", m!.Spec.StartsWith("@device_cm_"));
      Eq("match keeps endpoint", yeti.Id, m.EndpointId);
      Eq("match display is endpoint name", "Something Else", m.Display);
      var plain = new[] {
        new DshowDevice("Yeti Microphone - Main (Yeti Stereo Microphone)",
          null),
        new DshowDevice("Other", null),
      };
      Eq("match friendly name", "FriendlyName", DeviceMatch.ForEndpoint(
        new Endpoint("{x}", "Yeti Microphone - Main (Yeti Stereo Microphone)",
          1), plain, "vac")?.Method);
      Eq("match normalized prefix", "NormalizedName", DeviceMatch.ForEndpoint(
        new Endpoint("{x}", "Mic (USB Audio)", 1),
        new[] { new DshowDevice("2- Mic (USB Audio)", null) }, "vac")?.Method);
      Eq("match no guess", null, DeviceMatch.ForEndpoint(
        new Endpoint("{y}", "Gone", 1), devices, "virtual-audio-capturer"));
      Eq("match by dshow name", "DshowName", DeviceMatch.ByName(
        "yeti microphone - main (yeti stereo microphone)", devices,
        "virtual-audio-capturer")?.Method);
      Eq("match by name excludes system", null, DeviceMatch.ByName(
        "virtual-audio-capturer", devices, "virtual-audio-capturer"));
      Eq("system by name", "virtual-audio-capturer",
        DeviceMatch.ResolveByName("virtual-audio-capturer", devices)?.Spec);
      Eq("last guid", "af25d041-8695-4e1c-8672-b28919582119",
        DeviceMatch.LastGuid(devices[0].AlternativeName));
      Eq("short yeti", "Yeti Microphone - Main", DeviceMatch.ShortName(
        "Yeti Microphone - Main (Yeti Stereo Microphone)"));
      Eq("short generic", "Surface Stereo Microphones", DeviceMatch.ShortName(
        "Microphone (Surface Stereo Microphones)"));
      Eq("short headset", "AirPods Pro", DeviceMatch.ShortName(
        "Headset (AirPods Pro)"));
      Eq("short plain", "Line 1", DeviceMatch.ShortName("Line 1"));

      int lists = 0;
      var cache = new DshowCache(() => { lists++; return devices; },
        "virtual-audio-capturer");
      cache.ForEndpoint(yeti);
      cache.ForEndpoint(yeti);
      Eq("dshow cache lists once", 1, lists);
      cache.ForEndpoint(new Endpoint("{z}", "New Mic", 1));
      Eq("dshow cache refreshes on miss", 2, lists);
    }

    static void TestMicPolicy() {
      var w = new List<string>();
      Eq("policy communications", MicMode.Communications,
        MicPolicy.Parse("communications", w).Mode);
      Eq("policy default-device", MicMode.DefaultDevice,
        MicPolicy.Parse("Default-Device", w).Mode);
      Eq("policy none", MicMode.None, MicPolicy.Parse("none", w).Mode);
      Eq("policy no warnings yet", 0, w.Count);
      Eq("policy default alias", MicMode.Communications,
        MicPolicy.Parse("default", w).Mode);
      Eq("policy default warns", 1, w.Count);
      var pinned = MicPolicy.Parse("Yeti Microphone", w);
      Eq("policy pinned", MicMode.Pinned, pinned.Mode);
      Eq("policy pinned name", "Yeti Microphone", pinned.Name);

      var fake = new FakeEndpointSource();
      fake.Add("yeti", "Yeti Microphone");
      fake.Add("surface", "Microphone (Surface)");
      fake.Add("airpods", "Headset (AirPods)");
      fake.SetDefault(CaptureRole.Communications, "yeti");
      fake.SetDefault(CaptureRole.Console, "surface");
      var comms = MicPolicy.Parse("communications", w);
      var console = MicPolicy.Parse("default-device", w);
      Eq("desired comms", "yeti", comms.Desired(fake)?.Id);
      Eq("desired console", "surface", console.Desired(fake)?.Id);
      fake.SetDefault(CaptureRole.Communications, "airpods");
      Eq("desired follows comms change", "airpods", comms.Desired(fake)?.Id);
      Eq("console ignores comms change", "surface", console.Desired(fake)?.Id);
      fake.SetState("airpods", CoreAudio.DeviceStateNotPresent);
      Eq("desired waits on inactive default", null, comms.Desired(fake));
      Eq("pinned finds device", "yeti", pinned.Desired(fake)?.Id);
      fake.SetState("yeti", CoreAudio.DeviceStateNotPresent);
      Eq("pinned waits", null, pinned.Desired(fake));
      fake.Add("yeti-port2", "2- Yeti Microphone");
      Eq("pinned other port by name", "yeti-port2", pinned.Desired(fake)?.Id);
      var events = new List<string>();
      fake.Changed += events.Add;
      fake.SetDefault(CaptureRole.Console, "yeti-port2");
      Eq("fake fires events", 1, events.Count);
    }

    static void TestTones() {
      int rate = 48000;
      var x = new float[rate];
      for (int i = 0; i < x.Length; i++) {
        double t = (double)i / rate;
        x[i] = (float)((t < 0.5 ? 0.125 * Math.Sin(2 * Math.PI * 440 * t)
          : 0.125 * Math.Sin(2 * Math.PI * 880 * t)) +
          0.125 * Math.Sin(2 * Math.PI * 150 * t));
      }
      double a = ToneAnalysis.Amplitude(x.AsSpan(0, 960), 440, rate);
      Check("goertzel amplitude", Math.Abs(a - 0.125) < 0.01, a.ToString());
      Check("goertzel rejects other tone",
        ToneAnalysis.Amplitude(x.AsSpan(0, 960), 880, rate) < 0.02);
      var runs = ToneAnalysis.Runs(x, rate, new[] { 150, 440, 880 }, 0.04);
      var r440 = runs.Single(r => r.Hz == 440);
      var r880 = runs.Single(r => r.Hz == 880);
      Check("tone run 440", Math.Abs(r440.From) < 0.001 &&
        Math.Abs(r440.To - 0.5) <= 0.021, r440.ToString());
      Check("tone run 880", Math.Abs(r880.From - 0.5) <= 0.021 &&
        Math.Abs(r880.To - 1.0) <= 0.021, r880.ToString());
      var merged = ToneAnalysis.Merge(new List<ToneRun> {
        new(440, 0, 1), new(440, 1.02, 2), new(440, 3, 4),
      }, 0.05);
      Eq("tone merge", 2, merged.Count);
      Check("lavfi args", PcmCapture.Args("lavfi:sine=f=1", "o").Contains("lavfi"));
      Check("dshow args", PcmCapture.Args("Mic", "o").Contains("audio=Mic"));
    }

    static void TestManifest() {
      string dir = Path.Combine(Path.GetTempPath(),
        "audio-capture-test-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(dir);
      try {
        File.WriteAllBytes(Path.Combine(dir, "mic-01.pcm"), new byte[4003]);
        var m = new SessionManifest {
          StartedLocal = new DateTime(2026, 11, 13, 9, 0, 0), StopAt = 12.5,
        };
        m.Segments.Add(new SessionManifest.ManifestSegment {
          Kind = "mic", File = "mic-01.pcm", Device = "Yeti", Start = 0.75,
          Slope = 2e-4, Bytes = 1, End = 9.5, EndpointId = "{e}",
        });
        m.Write(Path.Combine(dir, SessionManifest.FileName));
        var back = SessionManifest.Read(Path.Combine(dir,
          SessionManifest.FileName));
        Eq("manifest stop", (double?)12.5, back.StopAt);
        var segs = back.ToSegments(dir);
        Eq("manifest segments", 1, segs.Count);
        Eq("manifest bytes from file, whole frames", 4000L, segs[0].Bytes);
        Eq("manifest end", (double?)9.5, segs[0].End);
        Eq("manifest endpoint", "{e}", segs[0].EndpointId);
        Eq("manifest path", Path.Combine(dir, "mic-01.pcm"), segs[0].Path);
        Eq("no tmp files left", 0, Directory.GetFiles(dir, "*.tmp").Length);
        string parent = Path.GetDirectoryName(dir)!;
        Check("unfinished lists it",
          SessionManifest.Unfinished(parent).Contains(dir));
        SessionManifest.MarkSaved(dir, "C:\\out.mp3");
        Eq("saved path", "C:\\out.mp3", SessionManifest.SavedPath(dir));
        Check("saved is not unfinished",
          !SessionManifest.Unfinished(parent).Contains(dir));
      } finally {
        Directory.Delete(dir, true);
      }
    }

    /// Runs real FFmpeg captures of a generated tone: stop with "q", kill,
    /// a frozen process caught as a stall, and a missing device. Skipped
    /// without FFmpeg.
    static void TestCaptureLifecycle() {
      string ffmpeg;
      try {
        ffmpeg = FfmpegLocator.Find("");
      } catch (FileNotFoundException) {
        Console.WriteLine("skip capture: no ffmpeg");
        return;
      }
      string dir = Path.Combine(Path.GetTempPath(),
        "audio-capture-test-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(dir);
      var target = new DeviceTarget("lavfi:sine=frequency=440:sample_rate=48000",
        "tone", "Fake", null);
      long origin = Stopwatch.GetTimestamp();
      bool WaitFor(Func<bool> cond, int ms) {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms) {
          if (cond()) {
            return true;
          }
          Thread.Sleep(20);
        }
        return cond();
      }
      try {
        using (var cap = new PcmCapture("mic", target,
            Path.Combine(dir, "a.pcm"), origin)) {
          cap.Start(ffmpeg);
          Check("capture gets audio", WaitFor(() => cap.Bytes > 96000, 5000));
          Eq("capture healthy", null,
            cap.LossReason(Stopwatch.GetTimestamp()));
          var sw = Stopwatch.StartNew();
          cap.Stop(3000);
          Check("capture stops on q", sw.ElapsedMilliseconds < 2500,
            sw.ElapsedMilliseconds + " ms");
          var seg = cap.ToSegment();
          Eq("capture file matches bytes", seg.Bytes,
            new FileInfo(seg.Path).Length);
          // lavfi with -re paces from FFmpeg's own start, so it catches up
          // on its startup time and can look up to ~0.5 s early; a real
          // device can't deliver audio from before it opened.
          Check("capture start measured", seg.Start > -1 && seg.Start < 2,
            seg.Start.ToString());
          Check("capture log written", File.Exists(seg.Path + ".ffmpeg.log"));
        }
        using (var cap = new PcmCapture("mic", target,
            Path.Combine(dir, "b.pcm"), origin)) {
          cap.Start(ffmpeg);
          WaitFor(() => cap.Bytes > 0, 5000);
          cap.Kill();
          Check("capture killed keeps audio", cap.Bytes > 0);
        }
        using (var cap = new PcmCapture("mic", target,
            Path.Combine(dir, "c.pcm"), origin)) {
          cap.Start(ffmpeg);
          WaitFor(() => cap.Bytes > 0, 5000);
          Native.SuspendProcess(cap.Pid);
          string? reason = null;
          WaitFor(() => (reason = cap.LossReason(Stopwatch.GetTimestamp()))
            != null, 4000);
          Check("capture stall detected", reason?.StartsWith("no audio") ==
            true, reason ?? "null");
          cap.Kill();
        }
        var bad = new DeviceTarget("No Such Device 12345", "none", "Fake",
          null);
        using (var cap = new PcmCapture("mic", bad,
            Path.Combine(dir, "d.pcm"), origin)) {
          cap.Start(ffmpeg);
          string? reason = null;
          WaitFor(() => (reason = cap.LossReason(Stopwatch.GetTimestamp()))
            != null, 9000);
          Check("capture missing device lost", reason != null, "no reason");
          cap.Kill();
        }
      } finally {
        try {
          Directory.Delete(dir, true);
        } catch (IOException) {
        }
      }
    }

    static void TestStateDir() {
      Check("state dir in home", StateDir.Root.EndsWith("\\.audio-capture"));
      Eq("migrate mic default", "[audio]\nmic = \"communications\"\n",
        StateDir.MigrateText("[audio]\nmic = \"default\"\n"));
      Eq("migrate keeps others", "mic = \"Yeti\"",
        StateDir.MigrateText("mic = \"Yeti\""));
      string dir = Path.Combine(Path.GetTempPath(),
        "audio-capture-test-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(dir);
      try {
        string old = Path.Combine(dir, "old.toml");
        string next = Path.Combine(dir, "new", "config.toml");
        Eq("migrate nothing", null, StateDir.MigrateConfig(old, next));
        File.WriteAllText(old, "[audio]\nmic = \"default\"\n");
        Check("migrate copies", StateDir.MigrateConfig(old, next) != null);
        Check("migrated content", File.ReadAllText(next).Contains(
          "communications"));
        Check("old kept", File.Exists(old));
        Eq("migrate once", null, StateDir.MigrateConfig(old, next));
      } finally {
        Directory.Delete(dir, true);
      }
    }

    static void TestLogFormat() {
      var ts = new DateTimeOffset(2026, 11, 13, 9, 5, 7, 123,
        TimeSpan.FromHours(7));
      string line = Log.Format(ts, "warn", "mic.lost", "no audio for 1.6 s",
        new { session = "s1", bytes = 42L, at = 3.25, endpoint = (string?)null,
          note = "quote \" here" });
      Eq("log line", "{\"ts\":\"2026-11-13T09:05:07.123+07:00\"," +
        "\"level\":\"warn\",\"event\":\"mic.lost\"," +
        "\"msg\":\"no audio for 1.6 s\",\"session\":\"s1\",\"bytes\":42," +
        "\"at\":3.25,\"note\":\"quote \\\" here\"}", line);
      using var doc = JsonDocument.Parse(line);
      Eq("log parses", "mic.lost", doc.RootElement.GetProperty("event")
        .GetString());
      Check("log no data", Log.Format(ts, "info", "x", "y", null)
        .EndsWith("\"msg\":\"y\"}"));
    }

    static void TestHealth() {
      Eq("propvariant size", IntPtr.Size == 8 ? 24 : 16,
        CoreAudio.PropVariantSize);
      Eq("health ok", null, Health.LossReason(10, 0.2, false, null));
      Check("health stalled",
        Health.LossReason(10, 1.6, false, null)!.Contains("no audio"));
      Check("health exited",
        Health.LossReason(10, 0.1, true, null) == "ffmpeg exited");
      Eq("health fatal while audio flows", null, Health.LossReason(10, 0.1,
        false, "Could not set buffer size"));
      Check("health fatal plus gap", Health.LossReason(10, 0.6, false,
        "Error during demuxing: I/O error")!.StartsWith("ffmpeg:"));
      Check("health fatal plus exit", Health.LossReason(10, 0.1, true,
        "Could not find audio only device")!.StartsWith("ffmpeg:"));
      Eq("health starting", null, Health.LossReason(3, null, false, null));
      Eq("health warning before first byte", null, Health.LossReason(1, null,
        false, "Could not set buffer size"));
      Check("health fatal then exit before first byte", Health.LossReason(1,
        null, true, "Could not find audio only device")!.StartsWith("ffmpeg:"));
      Check("health never started",
        Health.LossReason(9, null, false, null) != null);
    }

    static void TestTiming() {
      // Device starts at t=2.0, delivers 40 ms chunks, latency 10..30 ms,
      // and runs 200 ppm slow against the PC clock.
      var t = new TimingEstimator();
      var rng = new Random(1);
      double slope = 200e-6;
      for (int i = 1; i <= 120 * 25; i++) {
        double media = i * 0.04;
        double arrival = 2.0 + media * (1 + slope) + 0.01 +
          rng.NextDouble() * 0.02;
        t.Add(arrival, media);
      }
      Check("timing start", Math.Abs(t.Start!.Value - 2.0) < 0.015,
        t.Start.ToString()!);
      double? s = t.Slope(60);
      Check("timing slope", s != null && Math.Abs(s.Value - slope) < 50e-6,
        s?.ToString() ?? "null");
      Eq("timing slope needs span", null, t.Slope(1000));
      var empty = new TimingEstimator();
      Eq("timing empty", null, empty.Start);
    }

    static void TestMix() {
      var segs = new List<SegmentInfo> {
        new("system", "C:\\s\\system-01.pcm", "vac", 0.50, 192000 * 10, null),
        new("mic", "C:\\s\\mic-01.pcm", "yeti", 0.80, 192000 * 3, 10e-6),
        new("mic", "C:\\s\\mic-02.pcm", "yeti", 5.25, 192000 * 6, 300e-6),
      };
      string f = Mixer.BuildFilter(segs);
      Eq("mix filter",
        "[0:a]anull[s0];" +
        "[1:a]adelay=delays=300:all=1[s1];" +
        "[2:a]asetrate=47986,aresample=48000,adelay=delays=4750:all=1[s2];" +
        "[s0][s1][s2]amix=inputs=3:duration=longest:dropout_transition=0:" +
        "normalize=0,alimiter=limit=0.95[mixed]", f);
      var args = Mixer.BuildArgs(segs, "C:\\out.mp3.partial");
      Eq("mix arg count", 3 + 3 * 8 + 11, args.Count);
      Eq("mix first input", "system-01.pcm", args[10]);
      Check("mix filter from file", args.Contains("-/filter_complex") &&
        args.Contains(Mixer.FilterFile));
      Eq("mix output", "C:\\out.mp3.partial", args[^1]);
      Check("mix codec", args.Contains("libmp3lame"));
      double expected = Mixer.ExpectedSeconds(segs);
      Check("mix expected", Math.Abs(expected - (4.75 + 6 * 1.0003)) < 1e-6,
        expected.ToString(CultureInfo.InvariantCulture));
      string trimmed = Mixer.BuildFilter(segs, 9.0);
      Check("mix trims at stop", trimmed.Contains("[0:a]atrim=end=8.500[s0]") &&
        trimmed.Contains("atrim=end=3.750") && !trimmed.Contains(
          "[1:a]atrim"), trimmed);
      Check("mix expected with stop",
        Math.Abs(Mixer.ExpectedSeconds(segs, 9.0) - 8.5) < 1e-9);
      Eq("usable drops late segments", 2, Mixer.Usable(segs, 5.0).Count);
      var handoff = new List<SegmentInfo> {
        new("system", "s.pcm", "vac", 0.0, 192000 * 10, null),
        new("mic", "a.pcm", "yeti", 0.5, 192000 * 5, null, End: 3.25),
        new("mic", "b.pcm", "airpods", 3.25, 192000 * 6, null),
      };
      string hf = Mixer.BuildFilter(handoff, 9.0);
      Check("mix caps a switched segment",
        hf.Contains("[1:a]atrim=end=2.750,adelay=delays=500:all=1[s1]"), hf);
      Check("mix places the new device",
        hf.Contains("[2:a]atrim=end=5.750,adelay=delays=3250:all=1[s2]"), hf);
      Eq("usable drops fully capped", 1, Mixer.Usable(new List<SegmentInfo> {
        new("mic", "x.pcm", "m", 2.0, 192000, null, End: 2.0),
        new("mic", "y.pcm", "m", 2.0, 192000, null),
      }, null).Count);
      Throws<ArgumentException>("mix empty",
        () => Mixer.BuildFilter(new List<SegmentInfo>()));
      Eq("parse decoded time", 3725.5, Mixer.ParseDecodedTime(
        "  Duration: 01:02:06.00, start: 0.000000\n" +
        "size=N/A time=00:00:01.00 bitrate=N/A\r" +
        "[out#0/null @ 1] video:0KiB audio:1KiB\n" +
        "size=N/A time=01:02:05.50 bitrate=N/A speed= 300x\n"));
      Eq("parse decoded time none", null, Mixer.ParseDecodedTime("nope"));
      Check("duration ok", Mixer.DurationMatches(100.25, 100));
      Check("duration long ok", Mixer.DurationMatches(3607, 3600));
      Check("duration bad", !Mixer.DurationMatches(99.4, 100));
      Check("duration long bad", !Mixer.DurationMatches(3610, 3600));
      var dropped = new List<SegmentInfo> {
        new("mic", "C:\\m.pcm", "yeti", 0, 192000 * 100, 800e-6),
      };
      Check("mix ignores implausible drift",
        !Mixer.BuildFilter(dropped).Contains("asetrate"));
    }

    static void TestLayout() {
      var area = new Rectangle(0, 0, 1920, 1040);
      var size = new Size(216, 40);
      Eq("layout bottom-right", new Point(1684, 980),
        PillLayout.Location(PillPosition.BottomRight, area, size, 20));
      Eq("layout bottom-center", new Point(852, 980),
        PillLayout.Location(PillPosition.BottomCenter, area, size, 20));
      Eq("layout top-left", new Point(20, 20),
        PillLayout.Location(PillPosition.TopLeft, area, size, 20));
      Eq("bar silent", 0f, PillLayout.BarLevel(0));
      Eq("bar full", 1f, PillLayout.BarLevel(1));
      Check("bar mid", Math.Abs(PillLayout.BarLevel(0.1f) - 0.6f) < 0.001);
      Eq("elapsed", "1:05", PillLayout.FormatElapsed(65.9));
      Eq("elapsed hours", "1:00:01", PillLayout.FormatElapsed(3601));
    }

    static void TestCli() {
      Eq("cli default", "run", Cli.Parse(Array.Empty<string>()).Command);
      Eq("cli toggle", "toggle", Cli.Parse(new[] { "--toggle" }).Command);
      Eq("cli quit-if-idle", "quit-if-idle",
        Cli.Parse(new[] { "--quit-if-idle" }).Command);
      Eq("cli config", "x.toml",
        Cli.Parse(new[] { "--config", "x.toml", "--stop" }).ConfigPath);
      Eq("cli recover", "D:\\s",
        Cli.Parse(new[] { "--recover", "D:\\s" }).Argument);
      Throws<ArgumentException>("cli unknown",
        () => Cli.Parse(new[] { "--bogus" }));
      Throws<ArgumentException>("cli config missing",
        () => Cli.Parse(new[] { "--config" }));
    }
  }
}
