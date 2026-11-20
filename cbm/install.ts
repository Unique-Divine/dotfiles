/**
 * Build and install Codebase Memory MCP from the Unique-Divine fork.
 *
 * The fork's `ud/main` branch is upstream `main` plus GraphQL cross-repo
 * linking. Don't use the tool's own `install` or `update`: they install the
 * upstream release, which has no GraphQL field routes.
 *
 * Usage: bun run cbm/install.ts [--run] [--src <dir>] [--no-build]
 *   [--rollback]
 *
 * Without --run it prints the plan. With --run it builds (unless
 * --no-build), keeps the current binary as `<dest>.prev`, installs the new
 * one, and stops the background daemon so the next MCP or CLI call starts
 * the new build. Running MCP servers keep the old binary until the client
 * reconnects them.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Command as Program } from "commander"

export interface Step {
  label: string
  argv: string[]
  cwd?: string
  /** Extra environment, merged over the current one. */
  env?: Record<string, string>
  /** A failing optional step is reported but doesn't stop the install. */
  optional?: boolean
}

export interface InstallOptions {
  src: string
  dest: string
  build: boolean
  rollback: boolean
  /** Directory holding the `npm` shim, put first on PATH for the build. */
  shimDir: string
  path: string
  exists: (path: string) => boolean
}

/**
 * The UI build runs `npm ci` and `npm run build`; this machine's `npm` is a
 * stub that points to Bun. The shim maps both onto Bun.
 */
export const npmShim = `#!/bin/sh
case "$1" in
  ci) exec bun install ;;
  run) shift; exec bun run "$@" ;;
  *) exec bun "$@" ;;
esac
`

/** Binary path that `scripts/build.sh` writes inside a checkout. */
export const builtBinary = (src: string): string =>
  join(src, "build", "c", "codebase-memory-mcp")

/** First checkout that exists: the ud/main worktree, then the clone. */
export function defaultSrc(home: string, exists: (p: string) => boolean):
  string {
  const candidates = [join(home, "cbm-ud-main"),
    join(home, "codebase-memory-mcp")]
  return candidates.find((dir) => exists(join(dir, ".git"))) ?? candidates[0]
}

/** Steps for an install or rollback; throws when an input is missing. */
export function planInstall(opts: InstallOptions): Step[] {
  const prev = `${opts.dest}.prev`
  const stopDaemon: Step = {
    label: "stop the daemon so the next call starts the new binary",
    argv: ["pkill", "-f", "codebase-memory-mcp --cbm-daemon-internal"],
    optional: true,
  }
  if (opts.rollback) {
    if (!opts.exists(prev)) throw new Error(`no previous binary at ${prev}`)
    return [
      { label: "restore the previous binary",
        argv: ["install", "-m", "0755", prev, opts.dest] },
      stopDaemon,
    ]
  }
  if (!opts.exists(join(opts.src, ".git"))) {
    throw new Error(`no fork checkout at ${opts.src}; clone ` +
      "git@github.com:Unique-Divine/codebase-memory-mcp.git and switch " +
      "to ud/main")
  }
  const steps: Step[] = []
  if (opts.build) {
    steps.push({ label: "build with the graph UI",
      argv: ["scripts/build.sh", "--with-ui"], cwd: opts.src,
      env: { PATH: `${opts.shimDir}:${opts.path}` } })
  } else if (!opts.exists(builtBinary(opts.src))) {
    throw new Error(`--no-build, but ${builtBinary(opts.src)} is missing`)
  }
  if (opts.exists(opts.dest)) {
    steps.push({ label: "keep the current binary for rollback",
      argv: ["cp", "-p", opts.dest, prev] })
  }
  steps.push(
    { label: "install the fork build",
      argv: ["install", "-m", "0755", builtBinary(opts.src), opts.dest] },
    stopDaemon,
  )
  return steps
}

/** One line per step, for --plan output. */
export function formatSteps(steps: Step[]): string {
  return steps.map((s, i) =>
    `${i + 1}. ${s.label}\n   ${s.cwd ? `(in ${s.cwd}) ` : ""}` +
    s.argv.join(" ")).join("\n")
}

function gitLine(src: string, args: string[]): string {
  const out = spawnSync("git", ["-C", src, ...args], { encoding: "utf8" })
  return out.status === 0 ? out.stdout.trim() : "unknown"
}

function main(): void {
  new Program()
    .name("cbm-install")
    .description("Build and install Codebase Memory MCP from the fork.")
    .option("--run", "run the plan (default: print it)")
    .option("--src <dir>", "fork checkout on ud/main")
    .option("--no-build", "install the existing build")
    .option("--rollback", "reinstall the previous binary")
    .action((options: {
      run?: boolean, src?: string, build: boolean, rollback?: boolean,
    }) => {
      const home = homedir()
      const src = options.src ?? defaultSrc(home, existsSync)
      const dest = join(home, ".local", "bin", "codebase-memory-mcp")
      const shimDir = join(process.env.XDG_CACHE_HOME || join(home, ".cache"),
        "cbm-install", "npm-shim")
      let steps: Step[]
      try {
        steps = planInstall({ src, dest, build: options.build,
          rollback: Boolean(options.rollback), shimDir,
          path: process.env.PATH ?? "", exists: existsSync })
      } catch (err) {
        console.error(`\x1b[33m${(err as Error).message}\x1b[0m`)
        process.exitCode = 1
        return
      }
      if (!options.rollback) {
        const branch = gitLine(src, ["branch", "--show-current"])
        const head = gitLine(src, ["log", "-1", "--format=%h %s"])
        console.log(`source ${src} (${branch}) at ${head}`)
        if (branch !== "ud/main") {
          console.log(`\x1b[33mwarning: ${src} is on ${branch}, ` +
            "not ud/main\x1b[0m")
        }
      }
      if (!options.run) {
        console.log(formatSteps(steps))
        console.log("\x1b[36mjust cbm-install --run\x1b[0m to apply")
        return
      }
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(join(shimDir, "npm"), npmShim)
      chmodSync(join(shimDir, "npm"), 0o755)
      for (const step of steps) {
        console.log(`\x1b[36m${step.argv.join(" ")}\x1b[0m`)
        const out = spawnSync(step.argv[0], step.argv.slice(1), {
          cwd: step.cwd, stdio: "inherit",
          env: { ...process.env, ...step.env },
        })
        if (out.status !== 0 && !step.optional) {
          console.error(`\x1b[33mfailed: ${step.label}\x1b[0m`)
          process.exitCode = out.status ?? 1
          return
        }
      }
      const version = spawnSync(dest, ["--version"], { encoding: "utf8" })
      console.log(`💚 \x1b[32minstalled\x1b[0m ${version.stdout.trim()}; ` +
        "reconnect MCP clients (Claude Code: /mcp), then " +
        "\x1b[36mjust cbm-reindex\x1b[0m")
    })
    .parse()
}

if (import.meta.main) main()
