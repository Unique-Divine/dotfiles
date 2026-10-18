import { expect, test } from "bun:test"
import picomatch from "picomatch"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const filters = Bun.YAML.parse(
  await Bun.file(".github/filters.yml").text(),
) as Record<string, string[]>

// Match paths-filter v3's picomatch 2.x options and default OR predicate.
function affected(paths: string[]) {
  return Object.entries(filters)
    .filter(([, patterns]) => paths.some((path) =>
      patterns.some((pattern) => picomatch(pattern, { dot: true })(path)),
    ))
    .map(([domain]) => domain)
}

const cases: [string, string[], string[]][] = [
  ["Bun migration PR #64", [
    ".bun-version", ".github/workflows/test.yml",
    ".github/workflows/herdr-release.yml", "AGENTS.md", "bun.lock",
    "justfile", "herdr/scripts/docs/versions.integration.test.ts",
    "windows/sharex/sharex.test.ts",
  ], ["bun", "rust"]],
  ["Bun dependency", ["bun.lock"], ["bun"]],
  ["release scripts", ["herdr-release/publish.ts"], ["bun"]],
  ["docs tests", ["herdr/scripts/docs/versions.test.ts"], ["bun"]],
  ["ordinary docs", ["README.md", "AGENTS.md", "herdr/docs/guide.md"], []],
  ["root Rust", ["ud/src/main.rs", "Cargo.lock"], ["rust"]],
  ["Rust fixtures", ["clipboard/tests/fixtures/payload.bin"], ["rust"]],
  ["vendored native input", ["herdr/vendor/libghostty-vt/build.zig"], ["herdr_native"]],
  ["embedded TS", ["herdr/src/integration/assets/herdr-agent-state.ts"], ["bun", "herdr_native"]],
  ["native Cargo", ["herdr/Cargo.lock"], ["herdr_native"]],
  ["embedded skill", ["herdr/skills/herdr/SKILL.md"], ["herdr_native"]],
  ["embedded schema", ["herdr/docs/next/api/herdr-api.schema.json"], ["herdr_native"]],
  ["Windows packaging", ["herdr/scripts/package_windows_conpty.ps1"], ["herdr_native"]],
  ["hidden native config", ["herdr/.cargo/config.toml"], ["herdr_native"]],
  ["plugin source", ["herdr-tmux/src/main.rs"], ["herdr_tmux"]],
  ["plugin metadata", ["herdr-tmux/herdr-plugin.toml"], ["herdr_tmux"]],
  ["native workflow", [".github/workflows/herdr-native-build.yml"], ["herdr_native"]],
  ["Rust shell helper", ["zsh/bashlib.sh", "zsh/ud/shell.sh"], ["bun", "rust"]],
  ["legacy clipboard helper", ["bin/legacy-pbcopy"], ["bun", "rust"]],
  ["root orchestrator", [".github/workflows/ci.yml"], Object.keys(filters)],
  ["shared filters", [".github/filters.yml"], Object.keys(filters)],
]
for (const [name, paths, domains] of cases) {
  test(`CI routes ${name}`, () => expect(affected(paths)).toEqual(domains))
}

test("deleted inputs and both sides of a rename retain their domains", () => {
  // paths-filter reports removed paths and both old and new paths for renames.
  expect(affected(["herdr/src/removed.rs"])).toEqual(["herdr_native"])
  expect(affected(["ud/src/old.rs", "herdr/src/new.rs"])).toEqual(["rust", "herdr_native"])
})

const workflow = Bun.YAML.parse(
  await Bun.file(".github/workflows/ci.yml").text(),
) as any
const routing = workflow.jobs.changes.steps.find((step: any) => step.id === "decision")
const gate = workflow.jobs.result.steps[0]

// Execute the workflow's real shell scripts, including output and summary writes.
async function runStep(script: string, env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "dotfiles-ci-"))
  try {
    const output = join(dir, "output")
    const summary = join(dir, "summary")
    const result = Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      output: await readFile(output, "utf8").catch(() => ""),
      summary: await readFile(summary, "utf8").catch(() => ""),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function decide(
  event: string, ref: string, domains: string[] = [],
  repository = "Unique-Divine/dotfiles",
) {
  const env: Record<string, string> = {
    EVENT_NAME: event, REF: ref, REPOSITORY: repository,
  }
  for (const domain of Object.keys(filters)) {
    env[`PATHS_${domain.toUpperCase()}`] = String(domains.includes(domain))
  }
  const result = await runStep(routing.run, env)
  expect(result.code).toBe(0)
  expect(result.summary).toContain("Selected checks")
  return Object.fromEntries(result.output.trim().split("\n").map((line) => line.split("=")))
}

const off = {
  bun: "false", rust: "false", herdr_native: "false", herdr_tmux: "false",
  validate: "false", publish: "false",
}

test("PRs and main pushes use component decisions and cross-dependencies", async () => {
  expect(await decide("pull_request", "refs/pull/65/merge", affected(["bun.lock"])))
    .toEqual({ ...off, bun: "true", validate: "true" })
  expect(await decide("push", "refs/heads/main", affected(["herdr/src/main.rs"])))
    .toEqual({ ...off, herdr_native: "true", validate: "true" })
  expect(await decide("pull_request", "refs/pull/65/merge", affected(["README.md"])))
    .toEqual(off)
})

test("manual dispatch forces every component without publishing", async () => {
  expect(await decide("workflow_dispatch", "refs/heads/main"))
    .toEqual(Object.fromEntries(Object.keys(off).map((key) => [key, key === "publish" ? "false" : "true"])))
})

test("tag pushes run only the release pipeline and restrict publication to this repo", async () => {
  const release = { ...off, herdr_native: "true", validate: "true", publish: "true" }
  expect(await decide("push", "refs/tags/herdr-ud/v0.9.6", Object.keys(filters)))
    .toEqual(release)
  expect(await decide("push", "refs/tags/herdr-ud/v0.9.6", [], "someone/dotfiles"))
    .toEqual({ ...release, publish: "false" })
  expect(await decide("workflow_dispatch", "refs/tags/herdr-ud/v0.9.6"))
    .toMatchObject({ publish: "false" })
})

test("the legacy plugin branch selects only affected plugin checks", async () => {
  expect(await decide("push", "refs/heads/ud/herdr-tmux", Object.keys(filters)))
    .toEqual({ ...off, herdr_tmux: "true" })
  expect(await decide("push", "refs/heads/ud/herdr-tmux", ["bun"]))
    .toEqual(off)
})

const selectors: Record<string, keyof typeof off> = {
  bun: "bun", "rust-test": "rust", clippy: "rust", tmux: "herdr_tmux",
  validate: "validate", build: "herdr_native", prepare: "herdr_native", publish: "publish",
}
function results(selected: Record<string, string>) {
  return {
    changes: { result: "success", outputs: selected },
    ...Object.fromEntries(Object.entries(selectors).map(([job, component]) => [job, {
      result: job === "publish" || selected[component] === "true" ? "success" : "skipped",
    }])),
  } as Record<string, { result: string; outputs?: Record<string, string> }>
}

for (const selected of [off, { ...off, bun: "true", validate: "true" },
  Object.fromEntries(Object.keys(off).map((key) => [key, "true"]))]) {
  test(`aggregate accepts successful selections ${JSON.stringify(selected)}`, async () => {
    const result = await runStep(gate.run, { NEEDS: JSON.stringify(results(selected)) })
    expect(result.code).toBe(0)
    expect(result.summary).toContain("CI result")
  })
}

for (const [job, status, selected] of [
  ["changes", "failure", off],
  ["changes", "cancelled", off],
  ["bun", "failure", { ...off, bun: "true" }],
  ["build", "cancelled", { ...off, herdr_native: "true" }],
  ["prepare", "skipped", { ...off, herdr_native: "true" }],
  ["publish", "skipped", off],
  ["publish", "failure", { ...off, publish: "true" }],
] as const) {
  test(`aggregate rejects ${job} ${status}`, async () => {
    const needs = results(selected)
    needs[job]!.result = status
    const result = await runStep(gate.run, { NEEDS: JSON.stringify(needs) })
    expect(result.code).not.toBe(0)
    expect(result.stdout).toContain("::error::")
  })
}

test("one event entry point owns path detection and the complete dependency graph", async () => {
  const files = await Array.fromAsync(new Bun.Glob(".github/workflows/*.yml").scan("."))
  const workflows = await Promise.all(files.map(async (file) => Bun.YAML.parse(await Bun.file(file).text()) as any))
  expect(workflows.filter((file) => file.on.pull_request !== undefined).length).toBe(1)
  expect(workflow.on.push.branches).toEqual(["main", "ud/herdr-tmux"])
  expect(workflow.on.push.tags).toEqual(["herdr-ud/*"])
  expect(workflow.on.workflow_dispatch).toBeNull()
  expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}")
  const detectors = workflows.flatMap((file) => Object.values(file.jobs))
    .flatMap((job: any) => job.steps ?? []).filter((step: any) => step.uses === "dorny/paths-filter@v3")
  expect(detectors.length).toBe(1)
  expect(detectors[0].with.filters).toBe(".github/filters.yml")
  expect(detectors[0].with.base).toContain("github.event.before")
  expect(workflow.jobs.result.if).toBe("always()")
  expect(workflow.jobs.result.needs.toSorted())
    .toEqual(Object.keys(workflow.jobs).filter((job) => job !== "result").toSorted())
  expect(Object.keys(selectors).toSorted())
    .toEqual(Object.keys(workflow.jobs).filter((job) => !["changes", "result"].includes(job)).toSorted())
  for (const [job, component] of Object.entries(selectors)) {
    if (["prepare", "publish"].includes(job)) continue
    expect(workflow.jobs[job].if).toBe(`needs.changes.outputs.${component} == 'true'`)
  }
  expect(workflow.jobs.build.needs).toEqual(["changes", "validate"])
  expect(workflow.jobs.prepare.needs).toEqual(["validate", "build"])
  expect(workflow.jobs.prepare.if).toBeUndefined()
})

test("non-release publication passes with only its internal no-op step", async () => {
  const [noop, ...steps] = workflow.jobs.publish.steps
  expect(noop.if).toBe("needs.changes.outputs.publish != 'true'")
  expect(noop.uses).toBeUndefined()
  expect((await runStep(noop.run, {})).code).toBe(0)
  for (const step of steps) {
    expect(step.if).toBe("needs.changes.outputs.publish == 'true'")
  }
})
