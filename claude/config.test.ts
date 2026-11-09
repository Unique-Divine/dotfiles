import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applyConfig,
  applySettings,
  claudePaths,
  dotfileState,
  dotfileSettings,
  managedAllowRules,
  managedAskRules,
  mergePermissions,
  mergeRuntimeSettings,
  ownedView,
  retiredAllowRules,
  runtimeSettingsPath,
  runtimeStatePath,
  statusLinePath,
} from "./config.ts"

/** Settings sync writes to a runtime file that has no permissions yet. */
const freshSettings = {
  ...dotfileSettings,
  permissions: {
    allow: [...managedAllowRules],
    ask: [...managedAskRules],
  },
}

/**
 * Mirrors Claude Code's `Bash(...)` rule matching for one simple command.
 * `Bash(prefix:*)` matches commands that start with `prefix`, and a rule
 * without `:*` matches only the exact command. Mode "word" requires the
 * prefix to end at a word boundary; mode "loose" is a plain string prefix,
 * which matches a superset, so a command it rejects is rejected either way.
 */
const ruleMatches = (
  rule: string,
  command: string,
  mode: "word" | "loose",
): boolean => {
  const body = /^Bash\((.*)\)$/.exec(rule)?.[1]
  if (body === undefined) return false
  if (!body.endsWith(":*")) return command === body
  const prefix = body.slice(0, -2)
  if (!command.startsWith(prefix)) return false
  return mode === "loose" || command.length === prefix.length ||
    command[prefix.length] === " "
}

const allowRulesMatching = (
  command: string,
  mode: "word" | "loose",
): string[] => managedAllowRules.filter((rule) =>
  ruleMatches(rule, command, mode),
)

const scriptPath = join(import.meta.dir, "config.ts")

const runSettings = async (
  homeDir: string,
  args: string[] = [],
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: homeDir, CLAUDE_CONFIG_DIR: "", ...overrides },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { exitCode, stdout, stderr }
}

const withHome = async (
  settings: object | undefined,
  run: (homeDir: string, settingsPath: string) => Promise<void>,
): Promise<void> => {
  const homeDir = await mkdtemp(join(tmpdir(), "claude-settings-"))
  const settingsPath = join(homeDir, ".claude/settings.json")

  try {
    // These cases isolate settings behavior through the shared config CLI.
    await writeFile(join(homeDir, ".claude.json"), JSON.stringify(dotfileState))
    if (settings !== undefined) {
      await mkdir(join(homeDir, ".claude"), { recursive: true })
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
    }

    await run(homeDir, settingsPath)
  } finally {
    await rm(homeDir, { force: true, recursive: true })
  }
}

describe("claude settings", () => {
  test("settings and state share the active Claude configuration root", () => {
    for (const override of [undefined, "", "/test/alternate profile"]) {
      const env = { HOME: "/test", CLAUDE_CONFIG_DIR: override }
      const directory = override || "/test/.claude"
      const state = override
        ? "/test/alternate profile/.claude.json" : "/test/.claude.json"
      expect(claudePaths(env)).toEqual({
        directory, settings: join(directory, "settings.json"), state,
      })
      expect(runtimeSettingsPath(env)).toBe(join(directory, "settings.json"))
      expect(runtimeStatePath(env)).toBe(state)
    }
  })

  test("shared CLI checks and repairs only the selected alternate profile",
    async () => {
      await withHome(freshSettings, async (home, settingsPath) => {
        const directory = join(home, "alternate profile")
        await mkdir(directory)
        const alternateStatePath = join(directory, ".claude.json")
        const alternateSettingsPath = join(directory, "settings.json")
        const privateState = { oauthAccount: { id: crypto.randomUUID() } }
        await writeFile(alternateStatePath, JSON.stringify({
          ...privateState, editorMode: "emacs", hasCompletedOnboarding: false,
        }))
        await writeFile(alternateSettingsPath,
          `${JSON.stringify(freshSettings, null, 2)}\n`)
        const beforeSettings = await Bun.file(settingsPath).text()
        const beforeState = await Bun.file(join(home, ".claude.json")).text()
        const overrides = { CLAUDE_CONFIG_DIR: directory }
        const checked = await runSettings(home, ["--check", "--quiet"], overrides)
        expect(checked.exitCode).toBe(1)
        expect(await Bun.file(alternateStatePath).json()).toEqual({
          ...privateState, editorMode: "emacs", hasCompletedOnboarding: false,
        })
        const printed = await runSettings(home, ["--print"], overrides)
        expect(JSON.parse(printed.stdout)).toEqual({
          settings: freshSettings, state: dotfileState,
        })
        // Existing sessions can run under another profile. Keep the state
        // current before exercising the CLI's settings write in this fixture.
        await writeFile(alternateStatePath, JSON.stringify({
          ...privateState, ...dotfileState,
        }))
        await writeFile(alternateSettingsPath, "{}")
        const repaired = await runSettings(home, ["--run", "--quiet"], overrides)
        expect(repaired.exitCode).toBe(0)
        expect(await Bun.file(alternateSettingsPath).json()).toEqual(freshSettings)
        expect(await Bun.file(alternateStatePath).json()).toEqual({
          ...privateState, ...dotfileState,
        })
        expect((await runSettings(home, ["--check"], overrides)).exitCode).toBe(0)
        expect(await Bun.file(settingsPath).text()).toBe(beforeSettings)
        expect(await Bun.file(join(home, ".claude.json")).text()).toBe(beforeState)
      })
    })

  test("hides commit, PR, and session-link attribution", () => {
    expect(dotfileSettings.attribution).toEqual({
      commit: "",
      pr: "",
      sessionUrl: false,
    })
  })

  test("overwrites owned keys and keeps runtime keys", () => {
    const merged = mergeRuntimeSettings({
      model: "opus",
      editorMode: "vim",
      permissions: { allow: ["Bash(ls)"] },
      attribution: { commit: "Co-Authored-By: someone", pr: "footer" },
      includeCoAuthoredBy: true,
    })

    expect(merged).toEqual({
      model: "opus",
      editorMode: "vim",
      permissions: {
        allow: ["Bash(ls)", ...managedAllowRules],
        ask: [...managedAskRules],
      },
      attribution: dotfileSettings.attribution,
      statusLine: dotfileSettings.statusLine,
      tui: "default",
    })
  })

  test("renders on the main screen so multiplexers keep scrollback", () => {
    expect(mergeRuntimeSettings({ tui: "fullscreen" }).tui).toBe("default")
  })

  test("points the status line at this checkout's script", () => {
    expect(dotfileSettings.statusLine).toEqual({
      type: "command",
      command: `bash ${statusLinePath}`,
    })
    expect(statusLinePath).toBe(join(import.meta.dir, "statusline.sh"))
  })

  test("adds owned keys to an empty runtime file", () => {
    expect(mergeRuntimeSettings({})).toEqual(freshSettings)
  })

  test("allows ripgrep without a permission prompt", () => {
    expect(managedAllowRules).toContain("Bash(rg:*)")
  })

  test("allows only the Superhuman cleanup tools", () => {
    expect(managedAllowRules.filter((rule) =>
      rule.startsWith("mcp__superhuman-mail__"))).toEqual([
      "mcp__superhuman-mail__unsubscribe",
      "mcp__superhuman-mail__trash_thread",
    ])
  })

  test("adds managed allow rules and keeps runtime permissions", () => {
    expect(
      mergePermissions(
        {
          allow: ["Bash(ls)"],
          deny: ["Bash(rm:*)"],
          defaultMode: "acceptEdits",
        },
        ["Bash(rg:*)"],
      ),
    ).toEqual({
      allow: ["Bash(ls)", "Bash(rg:*)"],
      deny: ["Bash(rm:*)"],
      defaultMode: "acceptEdits",
    })
  })

  describe("cloud CLI rules", () => {
    const destructive = [
      "gcloud projects delete x",
      "gcloud --project=p storage rm gs://b/x",
      "gcloud -q storage rm gs://b/**",
      "gcloud alpha storage rm gs://b/x",
      "gcloud storage rm gs://b/x",
      "gcloud storage buckets delete gs://b",
      "gcloud storage cp ./x gs://b/x",
      "gcloud dns record-sets delete www.example.com. --zone=z --type=A",
      "gcloud dns managed-zones delete z",
      "gcloud secrets versions access latest --secret=s",
      "gcloud iam service-accounts keys create k.json --iam-account=a",
      "gcloud auth print-access-token",
      "gcloud config set project p",
      "gcloud run deploy svc",
      "firebase deploy",
      "firebase deploy --only hosting",
      "firebase hosting:disable",
      "firebase firestore:delete --all-collections",
      "firebase database:remove /",
    ]
    const readOnly = [
      "gcloud --version",
      "gcloud config list",
      "gcloud config get-value project",
      "gcloud auth list --filter=status:ACTIVE",
      "gcloud projects list",
      "gcloud projects describe p",
      "gcloud dns managed-zones list --project=p",
      "gcloud dns record-sets list --zone=z",
      "gcloud storage ls gs://b",
      "gcloud run services describe svc --region=r",
      "gcloud sql instances list --project=p",
      "gcloud logging read 'severity>=ERROR' --limit=10",
      "firebase --version",
      "firebase projects:list",
      "firebase hosting:channel:list",
      "firebase hosting:sites:list",
    ]

    test.each(destructive)("never auto-allows %p", (command) => {
      expect(allowRulesMatching(command, "loose")).toEqual([])
    })

    test.each(readOnly)("allows %p", (command) => {
      expect(allowRulesMatching(command, "word").length).toBeGreaterThan(0)
    })

    test("asks before the plain spelling of destructive commands", () => {
      for (const command of [
        "gcloud storage rm gs://b/x",
        "gcloud beta storage rm gs://b/x",
        "gcloud projects delete x",
        "gcloud secrets versions access latest --secret=s",
        "firebase deploy --only hosting",
      ]) {
        expect(
          managedAskRules.some((rule) => ruleMatches(rule, command, "word")),
        ).toBe(true)
      }
    })

    test("sync removes the retired broad rules", () => {
      expect(retiredAllowRules).toEqual(["Bash(gcloud:*)", "Bash(firebase:*)"])
      const merged = mergePermissions({
        allow: ["Bash(ls)", "Bash(gcloud:*)", "Bash(firebase:*)"],
      })
      expect(merged.allow).toEqual(["Bash(ls)", ...managedAllowRules])
    })
  })

  test("adds managed ask rules and keeps runtime ask rules", () => {
    expect(
      mergePermissions(
        { allow: ["Bash(ls)"], ask: ["Bash(git push:*)"] },
        ["Bash(rg:*)"],
        ["Bash(gcloud storage rm:*)"],
      ),
    ).toEqual({
      allow: ["Bash(ls)", "Bash(rg:*)"],
      ask: ["Bash(git push:*)", "Bash(gcloud storage rm:*)"],
    })
  })

  test("leaves ask absent when there are no managed ask rules", () => {
    expect(mergePermissions({}, ["Bash(rg:*)"])).toEqual({
      allow: ["Bash(rg:*)"],
    })
  })

  test("does not duplicate a managed rule already allowed", () => {
    const once = mergePermissions({}, ["Bash(rg:*)"])

    expect(once).toEqual({ allow: ["Bash(rg:*)"] })
    expect(mergePermissions(once, ["Bash(rg:*)"])).toEqual(once)
  })

  test("replaces malformed permissions with managed rules", () => {
    expect(mergePermissions("oops", ["Bash(rg:*)"])).toEqual({
      allow: ["Bash(rg:*)"],
    })
    expect(mergePermissions({ allow: "oops" }, ["Bash(rg:*)"])).toEqual({
      allow: ["Bash(rg:*)"],
    })
  })

  test("owned view excludes unmanaged keys", () => {
    expect(
      ownedView({ env: { TOKEN: "x" }, attribution: { pr: "" } }),
    ).toEqual({ attribution: { pr: "" } })
  })

  test("writes once, then reports current", async () => {
    await withHome({ editorMode: "vim" }, async (_homeDir, settingsPath) => {
      expect(await applySettings({ runtimePath: settingsPath, quiet: true }))
        .toBe(true)
      expect(await Bun.file(settingsPath).json()).toEqual({
        editorMode: "vim",
        ...freshSettings,
      })
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)
      expect(await applySettings({ runtimePath: settingsPath, quiet: true }))
        .toBe(false)
    })
  })

  test("dry run leaves the file unchanged", async () => {
    await withHome({ editorMode: "vim" }, async (_homeDir, settingsPath) => {
      const before = await Bun.file(settingsPath).text()

      expect(
        await applySettings({
          runtimePath: settingsPath,
          dryRun: true,
          quiet: true,
        }),
      ).toBe(true)
      expect(await Bun.file(settingsPath).text()).toBe(before)
    })
  })

  test("creates the settings file when it is missing", async () => {
    await withHome(undefined, async (homeDir, settingsPath) => {
      const result = await runSettings(homeDir, ["--run", "--quiet"])

      expect(result.exitCode).toBe(0)
      expect(await Bun.file(settingsPath).json()).toEqual(freshSettings)
    })
  })

  test("--check exits 1 on drift and 0 when current", async () => {
    await withHome({}, async (homeDir) => {
      expect((await runSettings(homeDir, ["--check"])).exitCode).toBe(1)
      await runSettings(homeDir, ["--run", "--quiet"])
      expect((await runSettings(homeDir, ["--check"])).exitCode).toBe(0)
    })
  })

  test("output never shows unmanaged values", async () => {
    const secret = `secret-${crypto.randomUUID()}`

    await withHome(
      { env: { API_TOKEN: secret }, includeCoAuthoredBy: true },
      async (homeDir) => {
        for (const args of [["--dry-run"], ["--check"], ["--print"]]) {
          const result = await runSettings(homeDir, args)

          expect(result.stdout).not.toContain(secret)
          expect(result.stderr).not.toContain(secret)
        }

        const dryRun = await runSettings(homeDir, ["--dry-run"])
        expect(dryRun.stdout).toContain("-  \"includeCoAuthoredBy\": true")
        expect(dryRun.stdout).toContain("+    \"sessionUrl\": false")
      },
    )
  })

  test("shared CLI checks both files and prints only managed configuration",
    async () => {
      await withHome(freshSettings, async (home, settingsPath) => {
        expect((await runSettings(home, ["--check"])).exitCode).toBe(0)
        const statePath = join(home, ".claude.json")
        const secret = crypto.randomUUID()
        const state = JSON.stringify({
          ...dotfileState, editorMode: "emacs", oauthAccount: { secret },
        })
        await writeFile(statePath, state)
        const settings = await Bun.file(settingsPath).text()
        expect((await runSettings(home, ["--check"])).exitCode).toBe(1)
        const printed = await runSettings(home, ["--print"])
        expect(JSON.parse(printed.stdout)).toEqual({
          settings: freshSettings, state: dotfileState,
        })
        expect(printed.stdout + printed.stderr).not.toContain(secret)
        expect(await Bun.file(statePath).text()).toBe(state)
        expect(await Bun.file(settingsPath).text()).toBe(settings)
      })
    })

  test("malformed settings prevent either file from being repaired", async () => {
    await withHome(undefined, async (home, settingsPath) => {
      await mkdir(join(home, ".claude"), { recursive: true })
      await writeFile(settingsPath, "{broken")
      const statePath = join(home, ".claude.json")
      await writeFile(statePath, "{}")
      await expect(applyConfig({ settingsPath, statePath, quiet: true }))
        .rejects.toThrow("Unable to parse JSON")
      expect(await Bun.file(settingsPath).text()).toBe("{broken")
      expect(await Bun.file(statePath).text()).toBe("{}")
    })
  })

  test("malformed state prevents settings from being repaired", async () => {
    await withHome({}, async (home, settingsPath) => {
      const statePath = join(home, ".claude.json")
      await writeFile(statePath, "{broken")
      const before = await Bun.file(settingsPath).text()
      await expect(applyConfig({ settingsPath, statePath, quiet: true }))
        .rejects.toThrow("Unable to parse JSON")
      expect(await Bun.file(settingsPath).text()).toBe(before)
      expect(await Bun.file(statePath).text()).toBe("{broken")
    })
  })
})

/** Run the status line script with session JSON on stdin; strip colors. */
const renderStatusLine = async (
  session: object,
  homeDir: string,
): Promise<string> => {
  const proc = Bun.spawn(["bash", statusLinePath], {
    env: { ...process.env, HOME: homeDir },
    stdin: new TextEncoder().encode(JSON.stringify(session)),
    stdout: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return out.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("claude status line", () => {
  test("shows the lualine mode label, ~ path, and git branch", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "claude-statusline-"))
    const repo = join(homeDir, "code", "repo")

    try {
      await mkdir(repo, { recursive: true })
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-C", repo, ...args], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        })
      git("init", "-q", "-b", "ud/sync")
      git("commit", "-q", "--allow-empty", "-m", "init")

      const workspace = { current_dir: repo }
      expect(
        await renderStatusLine({ workspace, vim: { mode: "INSERT" } }, homeDir),
      ).toBe(" 入れる  ~/code/repo  \u{e0a0} ud/sync")
      expect(
        await renderStatusLine({ workspace, vim: { mode: "NORMAL" } }, homeDir),
      ).toBe(" 普通  ~/code/repo  \u{e0a0} ud/sync")
      expect(
        await renderStatusLine(
          { workspace: { current_dir: homeDir } },
          homeDir,
        ),
      ).toBe("~")
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
