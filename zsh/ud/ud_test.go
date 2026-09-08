package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// getScriptPath returns the absolute path to ud.sh
func getScriptPath() (string, error) {
	rootPath, err := FindRootPath()
	if err != nil {
		return "", err
	}
	return filepath.Join(rootPath, "ud.sh"), nil
}

// FindRootPath returns the absolute path of the repository root
// This is retrievable with: go list -m -f {{.Dir}}
func FindRootPath() (string, error) {
	// rootPath, _ := exec.Command("go list -m -f {{.Dir}}").Output()
	// This returns the path to the root of the project.
	rootPathBz, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
	if err != nil {
		return "", err
	}
	rootPath := strings.Trim(string(rootPathBz), "\n")
	return rootPath, nil
}

// runUdCommand executes the ud command via bash and returns the output
func runUdCommand(t *testing.T, bashCmd string) string {
	output, err := runUdCommandResult(t, bashCmd)
	if err != nil {
		t.Fatalf("Command failed: %v\nOutput: %s", err, output)
	}

	return output
}

// runUdCommandResult executes ud and returns both its output and exit status.
func runUdCommandResult(t *testing.T, bashCmd string, extraEnv ...string) (string, error) {
	scriptPath, err := getScriptPath()
	if err != nil {
		t.Fatalf("Failed to get script path: %v", err)
	}

	// Suppress the top-level help printed when ud.sh is sourced. The command
	// under test still writes to the captured output.
	cmdStr := fmt.Sprintf(
		"source %q >/dev/null && %s", scriptPath, bashCmd,
	)

	cmd := exec.Command("bash", "-c", cmdStr)
	cmd.Env = append(os.Environ(), extraEnv...)
	output, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

// pass is a helper that logs success (similar to your bash pass function)
func pass(t *testing.T, msg string) {
	t.Logf("✅ %s", msg)
}

// fail is a helper that fails the test (similar to your bash fail function)
func fail(t *testing.T, msg string) {
	t.Fatalf("😞❌ %s", msg)
}

func TestHelpCommand(t *testing.T) {
	for _, bashCmd := range []string{
		"ud",
		"ud help",
		"ud -h",
		"ud --help",
	} {
		output := runUdCommand(t, bashCmd)
		if !strings.Contains(output, "USAGE:") {
			fail(t, bashCmd)
		}
		pass(t, bashCmd)
	}
}

func TestHealthHelp(t *testing.T) {
	for _, bashCmd := range []string{
		"ud health",
		"ud health help",
		"ud health -h",
		"ud health --help",
	} {
		t.Run(bashCmd, func(t *testing.T) {
			output := runUdCommand(t, bashCmd)
			require.Contains(t, output, "USAGE:\n   ud health <check>")
			require.Contains(t, output, "gpg")
		})
	}
}

func TestHealthGpgHelp(t *testing.T) {
	output := runUdCommand(t, "ud health gpg --help")
	require.Contains(t, output, "USAGE:\n   ud health gpg [--fix]")
	require.Contains(t, output, "gpg-agent-doctor [--fix]")
}

func TestHealthGpgForwardsFixToDotfilesDoctor(t *testing.T) {
	tmpDir := t.TempDir()
	doctorPath := filepath.Join(tmpDir, "bin", "gpg-agent-doctor")
	zshenvPath := filepath.Join(tmpDir, "zsh", "zshenv")
	require.NoError(t, os.MkdirAll(filepath.Dir(doctorPath), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Dir(zshenvPath), 0o755))
	require.NoError(t, os.WriteFile(zshenvPath, []byte(""), 0o644))
	require.NoError(t, os.WriteFile(
		doctorPath,
		[]byte("#!/usr/bin/env bash\nprintf '<%s>\\n' \"$@\"\n"),
		0o755,
	))

	output, err := runUdCommandResult(
		t,
		"ud health gpg --fix",
		"DOTFILES="+tmpDir,
	)
	require.NoError(t, err, "output: %s", output)
	require.Equal(t, "<--fix>", output)
}

func TestHealthRejectsUnknownCheck(t *testing.T) {
	output, err := runUdCommandResult(t, "ud health unknown")
	require.Error(t, err)
	require.Contains(t, output, "Unknown health check: unknown")
	require.Contains(t, output, "ud health <check>")
}

func TestRsTestCmd(t *testing.T) {
	bashCmd := "ud rs test --cmd"
	output := runUdCommand(t, bashCmd)
	if output != "cargo test" {
		fail(t, bashCmd)
	}
	pass(t, bashCmd)
}

func TestGoTestShortCmd(t *testing.T) {
	bashCmd := "ud go test-short --cmd"
	output := runUdCommand(t, bashCmd)
	if !strings.Contains(output, "go test ./...") {
		fail(t, bashCmd)
	}
	pass(t, bashCmd)
}

func TestNibiCfgProd(t *testing.T) {
	bashCmd := "ud nibi cfg prod"
	output := runUdCommand(t, bashCmd)
	require.Contains(t, output, "ud nibi cfg")
}

func TestNibiKeysHelp(t *testing.T) {
	output := runUdCommand(t, "ud nibi keys")
	require.Contains(t, output, "USAGE:\n   ud nibi keys <command>")
	require.Contains(t, output, "add-mnem --name <name> --mnem <mnemonic>")

	parentOutput := runUdCommand(t, "ud nibi")
	require.Contains(t, parentOutput, "keys              Manage local Nibiru test keys")
}

func TestNibiKeysAddMnemHelp(t *testing.T) {
	for _, helpArg := range []string{"--help", "-h", "help"} {
		t.Run(helpArg, func(t *testing.T) {
			output := runUdCommand(t, fmt.Sprintf("ud nibi keys add-mnem %s", helpArg))
			require.Contains(t, output, "USAGE:\n   ud nibi keys add-mnem --name <name> --mnem <mnemonic>")
		})
	}
}

func TestNibiKeysAddMnemRejectsInvalidArguments(t *testing.T) {
	mnemonic := "word1 word2 word3"
	cases := []struct {
		name string
		args string
	}{
		{
			name: "missing name",
			args: fmt.Sprintf("--mnem %q", mnemonic),
		},
		{
			name: "missing mnemonic",
			args: "--name alice",
		},
		{
			name: "missing name value",
			args: "--name --mnem " + fmt.Sprintf("%q", mnemonic),
		},
		{
			name: "missing mnemonic value",
			args: "--name alice --mnem",
		},
		{
			name: "duplicate name",
			args: fmt.Sprintf("--name alice --name bob --mnem %q", mnemonic),
		},
		{
			name: "duplicate mnemonic",
			args: fmt.Sprintf("--name alice --mnem %q --mnem %q", mnemonic, mnemonic),
		},
		{
			name: "unknown flag",
			args: fmt.Sprintf("--name alice --mnem %q --unknown", mnemonic),
		},
		{
			name: "positional argument",
			args: fmt.Sprintf("--name alice --mnem %q extra", mnemonic),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := runUdCommandResult(t, "ud nibi keys add-mnem "+tc.args)
			require.Error(t, err)
		})
	}
}

func TestNibiKeysAddMnemPassesArgumentsAndMnemonicToNibid(t *testing.T) {
	tmpDir := t.TempDir()
	argsPath := filepath.Join(tmpDir, "args")
	stdinPath := filepath.Join(tmpDir, "stdin")
	fakeNibidPath := filepath.Join(tmpDir, "nibid")
	fakeNibid := []byte("#!/usr/bin/env bash\n" +
		"set -euo pipefail\n" +
		"printf '%s\\n' \"$@\" > \"$NIBID_ARGS_FILE\"\n" +
		"cat > \"$NIBID_STDIN_FILE\"\n")
	require.NoError(t, os.WriteFile(fakeNibidPath, fakeNibid, 0o755))

	name := "alice"
	mnemonic := "word1 word2 word3"
	cases := []struct {
		name string
		args string
	}{
		{
			name: "name first",
			args: fmt.Sprintf("--name %q --mnem %q", name, mnemonic),
		},
		{
			name: "mnemonic first",
			args: fmt.Sprintf("--mnem %q --name %q", mnemonic, name),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			output, err := runUdCommandResult(
				t,
				"ud nibi keys add-mnem "+tc.args,
				"PATH="+tmpDir+string(os.PathListSeparator)+os.Getenv("PATH"),
				"NIBID_ARGS_FILE="+argsPath,
				"NIBID_STDIN_FILE="+stdinPath,
			)
			require.NoError(t, err, "output: %s", output)
			require.Empty(t, output)

			args, readErr := os.ReadFile(argsPath)
			require.NoError(t, readErr)
			require.Equal(t, "keys\nadd\nalice\n--recover\n--keyring-backend=test\n", string(args))

			stdin, readErr := os.ReadFile(stdinPath)
			require.NoError(t, readErr)
			require.Equal(t, mnemonic+"\n", string(stdin))
		})
	}
}

func TestQuickSymlinkCreatesMissingParentForRelativeTarget(t *testing.T) {
	tmpDir := t.TempDir()
	src := filepath.Join(tmpDir, "ai-skills")
	dst := filepath.Join(tmpDir, ".agents", "skills")
	require.NoError(t, os.Mkdir(src, 0o755))

	bashCmd := fmt.Sprintf("cd %q && ud q symlink ../ai-skills .agents/skills", tmpDir)
	runUdCommand(t, bashCmd)

	info, err := os.Lstat(dst)
	require.NoError(t, err)
	require.NotZero(t, info.Mode()&os.ModeSymlink)

	target, err := os.Readlink(dst)
	require.NoError(t, err)
	require.Equal(t, "../ai-skills", target)

	resolved, err := filepath.EvalSymlinks(dst)
	require.NoError(t, err)
	require.Equal(t, src, resolved)
}

func TestExecutablePluginDispatch(t *testing.T) {
	tmpDir := t.TempDir()
	pluginPath := filepath.Join(tmpDir, "ud-example")
	plugin := []byte("#!/usr/bin/env bash\n" +
		"if [[ \"${1:-}\" == --plugin-info ]]; then\n" +
		"  printf '%s\\n' '{\"apiVersion\":1,\"name\":\"example\",\"description\":\"Test plugin\"}'\n" +
		"  exit 0\n" +
		"fi\n" +
		"printf '%s\\n' \"$*\"\n")
	require.NoError(t, os.WriteFile(pluginPath, plugin, 0o755))

	output, err := runUdCommandResult(t, "ud example alpha beta", "UD_PLUGIN_PATH="+tmpDir)
	require.NoError(t, err)
	require.Equal(t, "alpha beta", output)
}

func TestPluginInfoAndList(t *testing.T) {
	tmpDir := t.TempDir()
	pluginPath := filepath.Join(tmpDir, "ud-example")
	plugin := []byte("#!/usr/bin/env bash\nprintf '%s\\n' '{\"apiVersion\":1,\"name\":\"example\",\"description\":\"Test plugin\"}'\n")
	require.NoError(t, os.WriteFile(pluginPath, plugin, 0o755))

	info, err := runUdCommandResult(t, "ud plugin info example", "UD_PLUGIN_PATH="+tmpDir)
	require.NoError(t, err)
	require.Contains(t, info, "\"name\": \"example\"")

	list, err := runUdCommandResult(t, "ud plugin list", "UD_PLUGIN_PATH="+tmpDir)
	require.NoError(t, err)
	require.Contains(t, list, "example\t"+pluginPath)
}

func TestHealthIsBuiltInAndCannotBeShadowed(t *testing.T) {
	tmpDir := t.TempDir()
	pluginPath := filepath.Join(tmpDir, "ud-health")
	plugin := []byte("#!/usr/bin/env bash\nexit 0\n")
	require.NoError(t, os.WriteFile(pluginPath, plugin, 0o755))

	list := runUdCommand(t, "ud plugin list")
	require.Contains(t, list, "health")

	output, err := runUdCommandResult(
		t,
		"ud plugin doctor",
		"UD_PLUGIN_PATH="+tmpDir,
	)
	require.Error(t, err)
	require.Contains(t, output, "Plugin command collides with built-in: health")
}

func TestPluginMetadataCacheRefreshesWhenPluginChanges(t *testing.T) {
	tmpDir := t.TempDir()
	pluginPath := filepath.Join(tmpDir, "ud-example")
	counterPath := filepath.Join(tmpDir, "metadata-count")
	plugin := []byte("#!/usr/bin/env bash\n" +
		"if [[ \"${1:-}\" == --plugin-info ]]; then\n" +
		"  count=0\n" +
		"  [[ -f \"$PLUGIN_COUNTER\" ]] && count=$(<\"$PLUGIN_COUNTER\")\n" +
		"  printf '%s\\n' \"$((count + 1))\" > \"$PLUGIN_COUNTER\"\n" +
		"  printf '%s\\n' '{\"apiVersion\":1,\"name\":\"example\",\"description\":\"Cached test plugin\"}'\n" +
		"fi\n")
	require.NoError(t, os.WriteFile(pluginPath, plugin, 0o755))

	env := []string{
		"HOME=" + tmpDir,
		"XDG_CACHE_HOME=" + filepath.Join(tmpDir, ".cache"),
		"UD_PLUGIN_PATH=" + tmpDir,
		"PLUGIN_COUNTER=" + counterPath,
	}
	for range 2 {
		output, err := runUdCommandResult(t, "ud --help", env...)
		require.NoError(t, err, "output: %s", output)
		require.Contains(t, output, "Cached test plugin")
	}

	count, err := os.ReadFile(counterPath)
	require.NoError(t, err)
	require.Equal(t, "1\n", string(count))
	require.FileExists(t, filepath.Join(
		tmpDir, ".cache", "ud", "plugin-metadata", "example.json",
	))

	require.NoError(t, os.WriteFile(pluginPath, plugin, 0o755))
	output, err := runUdCommandResult(t, "ud --help", env...)
	require.NoError(t, err, "output: %s", output)
	require.Contains(t, output, "Cached test plugin")

	count, err = os.ReadFile(counterPath)
	require.NoError(t, err)
	require.Equal(t, "2\n", string(count))
}

func TestPluginInCurrentDirectoryIsIgnored(t *testing.T) {
	tmpDir := t.TempDir()
	pluginPath := filepath.Join(tmpDir, "ud-not-discovered")
	require.NoError(t, os.WriteFile(pluginPath, []byte("#!/usr/bin/env bash\nexit 0\n"), 0o755))

	_, err := runUdCommandResult(
		t,
		"cd "+fmt.Sprintf("%q", tmpDir)+" && ud not-discovered",
		"UD_PLUGIN_PATH=",
		"XDG_DATA_HOME="+filepath.Join(tmpDir, "xdg"),
	)
	require.Error(t, err)
}
