import { expect, test } from "bun:test"
import picomatch from "picomatch"

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
  ["release orchestration", [".github/workflows/herdr-release.yml"], ["bun"]],
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

test("all workflows share routing, with forced manual and tag checks", async () => {
  const read = async (name: string): Promise<any> => Bun.YAML.parse(
    await Bun.file(`.github/workflows/${name}.yml`).text(),
  )
  const changes = await read("changes")
  expect(changes.permissions).toEqual({ contents: "read", "pull-requests": "read" })
  const steps = changes.jobs.changes.steps
  expect(steps[0].env.FULL).toBe(
    "${{ github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/herdr-ud/') }}",
  )
  expect(steps[2].uses).toBe("dorny/paths-filter@v3")
  expect(steps[2].with.filters).toBe(".github/filters.yml")
  expect(steps[2].with.base).toContain("github.event.before")
  for (const domain of Object.keys(filters)) {
    expect(changes.jobs.changes.outputs[domain]).toBe(
      `\${{ steps.paths.outputs.${domain} == 'true' || steps.full.outputs.enabled == 'true' }}`,
    )
  }
  for (const name of ["test", "rust", "herdr-tmux", "herdr-release"]) {
    const workflow = await read(name)
    expect(workflow.on.workflow_dispatch).toBeNull()
    expect(workflow.on.pull_request).toBeNull()
    expect(workflow.on.push.branches).toContain("main")
    expect(workflow.jobs.changes.uses).toBe("./.github/workflows/changes.yml")
  }
  for (const [name, job, domain] of [["test", "test", "bun"], ["rust", "clippy", "rust"]]) {
    const workflow = await read(name!)
    const check = workflow.jobs[job!]
    expect(check.needs).toBe("changes")
    expect(check.if).toBeUndefined()
    for (const step of check.steps) {
      if (step.uses && step.uses !== "actions/checkout@v6") {
        const toolDomain = step.uses === "dtolnay/rust-toolchain@stable" ? "rust" : domain
        expect(step.if).toContain(`needs.changes.outputs.${toolDomain}`)
      }
    }
  }
  const release = await read("herdr-release")
  expect(release.jobs.prepare.needs).toContain("build")
  expect(release.jobs.prepare.if).toBeUndefined() // success required, skips after skipped/failed builds
  expect(release.jobs.publish.needs).toContain("prepare")
})
