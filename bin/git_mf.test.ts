// Scenario corpus for `git_mf <target>`. Every scenario builds a real
// repository state, runs --dry-run (which must change nothing but
// remote-tracking refs), then runs for real and checks that the result
// matches the plan. A disagreement means the plan logic is wrong.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { cleanup, ok, repoPair, sh } from "./git-test-repo"

const gitMf = join(resolve(import.meta.dir), "git_mf")

afterEach(cleanup)

type Repo = Awaited<ReturnType<typeof repoPair>>

type Scenario = {
  name: string
  setup: (r: Repo) => Promise<void>
  target?: string
  /** Text the "git_mf: plan: ..." line must contain. */
  plan: string
  code: number
  /** Exit code of --dry-run when it can't know the outcome. Default: code. */
  dryCode?: number
  /** Text both runs must print besides the plan. */
  says?: string
  /** Branch after a successful real run; "" means detached. */
  branch?: string
  /** Ref the real run must end up containing. Default: origin/<target>. */
  includes?: string
}

/** Everything a run could change, apart from refs/remotes. */
const snapshot = (dir: string) =>
  ok(
    dir,
    [
      "git rev-parse HEAD",
      "git branch --show-current",
      "git for-each-ref --format='%(refname) %(objectname)' refs/heads",
      "git status --porcelain=v1 --untracked-files=all",
      "git stash list",
      "ls \"$(git rev-parse --git-dir)\" | grep -E 'MERGE_HEAD|rebase|CHERRY|REVERT' || true",
    ].join(" && "),
  )

const feature = (r: Repo, file = "feature.txt", content = "f") =>
  ok(
    r.clone,
    `git switch -q -c feature && printf '${content}\\n' > ${file} && git add -A && git commit -qm feature`,
  )

/** Commit a 12-line file on both sides so rename detection has material. */
async function sharedLongFile(r: Repo) {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\\n")
  await r.pushUpstream(lines, "long.txt")
  await ok(r.clone, "git pull -q")
}

const scenarios: Scenario[] = [
  {
    name: "fast-forward on main",
    setup: async (r) => void (await r.pushUpstream("two")),
    plan: "fast-forward",
    code: 0,
    branch: "main",
  },
  {
    name: "already up to date",
    setup: async () => {},
    plan: "up-to-date",
    code: 0,
    branch: "main",
  },
  {
    name: "clean merge into a feature branch",
    setup: async (r) => {
      await feature(r)
      await r.pushUpstream("two")
    },
    plan: "update-local-target merge",
    code: 0,
    branch: "feature",
  },
  {
    name: "feature branch with no commits of its own fast-forwards",
    setup: async (r) => {
      await ok(r.clone, "git switch -q -c feature")
      await r.pushUpstream("two")
    },
    plan: "fast-forward",
    code: 0,
    branch: "feature",
  },
  {
    name: "rename on one side, edit on the other merges cleanly",
    setup: async (r) => {
      await sharedLongFile(r)
      await ok(r.clone, "git switch -q -c feature && git mv long.txt renamed.txt && git commit -qm rename")
      const edited = Array.from({ length: 12 }, (_, i) => (i === 5 ? "edited" : `line ${i}`)).join("\\n")
      await r.pushUpstream(edited, "long.txt")
    },
    plan: "merge",
    code: 0,
    branch: "feature",
  },
  {
    name: "content conflict",
    setup: async (r) => {
      await feature(r, "file.txt", "mine")
      await r.pushUpstream("theirs")
    },
    plan: "merge-conflict: file.txt",
    code: 3,
  },
  {
    name: "modify/delete conflict",
    setup: async (r) => {
      await ok(r.clone, "git switch -q -c feature && git rm -q file.txt && git commit -qm delete")
      await r.pushUpstream("changed")
    },
    plan: "merge-conflict: file.txt",
    code: 3,
  },
  {
    name: "add/add conflict",
    setup: async (r) => {
      await feature(r, "new.txt", "mine")
      await r.pushUpstream("theirs", "new.txt")
    },
    plan: "merge-conflict: new.txt",
    code: 3,
  },
  {
    name: "binary conflict",
    setup: async (r) => {
      await ok(r.clone, "git switch -q -c feature && printf '\\000\\001mine' > bin.dat && git add . && git commit -qm bin")
      await ok(r.peer, "printf '\\000\\002theirs' > bin.dat && git add . && git commit -qm bin && git push -q")
    },
    plan: "merge-conflict: bin.dat",
    code: 3,
  },
  {
    name: "main diverged from origin",
    setup: async (r) => {
      await ok(r.clone, "printf x > local.txt && git add . && git commit -qm local")
      await r.pushUpstream("two")
    },
    plan: "diverged",
    code: 3,
  },
  {
    name: "detached behind main switches to main",
    setup: async (r) => {
      await ok(r.clone, "git switch -q --detach HEAD")
      await r.pushUpstream("two")
    },
    plan: "detached-switch fast-forward",
    code: 0,
    branch: "main",
  },
  {
    name: "detached with no local main creates it",
    setup: async (r) => {
      await ok(r.clone, "git switch -q --detach HEAD && git branch -q -D main")
      await r.pushUpstream("two")
    },
    plan: "detached-switch up-to-date",
    code: 0,
    branch: "main",
  },
  {
    name: "detached at a commit that isn't on main",
    setup: async (r) => {
      await ok(r.clone, "git switch -q --detach && printf x > x && git add . && git commit -qm x")
    },
    plan: "detached-stray",
    code: 4,
  },
  {
    name: "detached while local main has diverged",
    setup: async (r) => {
      await ok(r.clone, "git switch -q --detach HEAD")
      await ok(r.clone, "git switch -q main && printf x > x && git add . && git commit -qm x && git switch -q --detach HEAD~1")
      await r.pushUpstream("two")
    },
    plan: "diverged",
    code: 3,
  },
  ...(["staged", "unstaged", "untracked"] as const).map((state) => ({
    name: `${state} changes`,
    setup: async (r: Repo) => {
      await r.pushUpstream("two")
      const change = {
        staged: "printf local > file.txt && git add file.txt",
        unstaged: "printf local > file.txt",
        untracked: "printf local > new.txt",
      }[state]
      await ok(r.clone, change)
    },
    plan: "dirty",
    code: 2,
  })),
  {
    name: "merge already in progress",
    setup: async (r) => {
      await feature(r, "file.txt", "mine")
      await r.pushUpstream("theirs")
      await sh(r.clone, "git fetch -q && git merge origin/main")
      await ok(r.clone, "printf resolved > file.txt && git add file.txt")
    },
    plan: "in-progress: merge",
    code: 5,
  },
  {
    name: "rebase already in progress",
    setup: async (r) => {
      await feature(r, "file.txt", "mine")
      await r.pushUpstream("theirs")
      await sh(r.clone, "git fetch -q && git rebase origin/main")
    },
    plan: "in-progress: rebase",
    code: 5,
  },
  {
    name: "target only exists locally",
    setup: async (r) => {
      await ok(r.clone, "git switch -q -c topic && printf t > t.txt && git add . && git commit -qm t")
      await ok(r.clone, "git switch -q main && git switch -q -c feature")
    },
    target: "topic",
    plan: "fast-forward",
    code: 0,
    branch: "feature",
    includes: "topic",
  },
  {
    name: "target missing everywhere",
    setup: async () => {},
    target: "nope",
    plan: "missing-target",
    code: 1,
  },
  {
    name: "merge.ff=only in config still merges",
    setup: async (r) => {
      await ok(r.clone, "git config merge.ff only")
      await feature(r)
      await r.pushUpstream("two")
    },
    plan: "merge",
    code: 0,
    branch: "feature",
  },
  {
    name: "clean merge while local main is checked out in another worktree",
    setup: async (r) => {
      await feature(r)
      await ok(r.clone, `git worktree add -q ${r.root}/wt main`)
      await r.pushUpstream("two")
    },
    plan: "plan: merge",
    says: "local main is checked out in",
    code: 0,
    branch: "feature",
  },
  {
    name: "detached while main is checked out in another worktree moves HEAD",
    setup: async (r) => {
      await ok(r.clone, `git switch -q --detach HEAD && git worktree add -q ${r.root}/wt main`)
      await r.pushUpstream("two")
    },
    plan: "plan: detached-advance",
    says: "local main is checked out in",
    code: 0,
    branch: "",
  },
  {
    name: "detached while local main is ahead of origin switches to main",
    setup: async (r) => {
      await ok(r.clone, "printf x > x && git add . && git commit -qm x && git switch -q --detach HEAD~1")
    },
    plan: "detached-switch up-to-date",
    code: 0,
    branch: "main",
  },
  {
    name: "a pre-merge-commit hook that rejects leaves the branch as it was",
    setup: async (r) => {
      await feature(r)
      await r.pushUpstream("two")
      await ok(
        r.clone,
        "printf '#!/bin/sh\\necho hook says no >&2\\nexit 1\\n' > .git/hooks/pre-merge-commit && chmod +x .git/hooks/pre-merge-commit",
      )
    },
    plan: "merge",
    code: 1,
    // Hooks only run during a real merge, so a dry run can't predict this.
    dryCode: 0,
  },
]

describe("git_mf <target> scenarios", () => {
  test.each(scenarios)("$name", async (s) => {
    const r = await repoPair()
    await s.setup(r)
    const target = s.target ?? "main"
    const before = await snapshot(r.clone)

    const dry = await sh(r.clone, `${gitMf} ${target} --dry-run`)
    expect(dry.stderr).toContain(`git_mf: plan: `)
    expect(dry.stderr).toContain(s.plan)
    expect(dry.stderr).toContain(s.says ?? "")
    expect(dry.code, dry.stderr).toBe(s.dryCode ?? s.code)
    expect(await snapshot(r.clone)).toBe(before)

    const real = await sh(r.clone, `${gitMf} ${target}`)
    expect(real.stderr).toContain(s.plan)
    expect(real.stderr).toContain(s.says ?? "")
    expect(real.stderr).not.toContain("plan predicted")
    expect(real.code, real.stderr).toBe(s.code)

    if (s.code === 0) {
      if (s.branch !== undefined) {
        expect(await ok(r.clone, "git branch --show-current")).toBe(s.branch)
      }
      const includes = s.includes ?? `origin/${target}`
      expect(
        await sh(r.clone, `git merge-base --is-ancestor ${includes} HEAD`),
      ).toMatchObject({ code: 0 })
      expect(await ok(r.clone, "git status --porcelain")).toBe("")
    } else {
      expect(await snapshot(r.clone)).toBe(before)
    }
  })

  test("a clean merge also fast-forwards a local main you aren't on", async () => {
    const r = await repoPair()
    await feature(r)
    const upstream = await r.pushUpstream("two")
    const res = await sh(r.clone, `${gitMf} main`)
    expect(res.code, res.stderr).toBe(0)
    expect(await ok(r.clone, "git rev-parse main")).toBe(upstream)
  })

  test("a conflict names the files and the --agent rerun", async () => {
    const r = await repoPair()
    await feature(r, "file.txt", "mine")
    await r.pushUpstream("theirs")
    const res = await sh(r.clone, `${gitMf} main`)
    expect(res.code).toBe(3)
    expect(res.stderr).toContain("conflicts in: file.txt")
    expect(res.stderr).toContain("git_mf main --agent")
  })

  test("a rejected merge shows git's own message", async () => {
    const r = await repoPair()
    await feature(r)
    await r.pushUpstream("two")
    await ok(
      r.clone,
      "printf '#!/bin/sh\\necho hook says no >&2\\nexit 1\\n' > .git/hooks/pre-merge-commit && chmod +x .git/hooks/pre-merge-commit",
    )
    const res = await sh(r.clone, `${gitMf} main`)
    expect(res.stderr).toContain("merge failed without conflicts")
    expect(res.stderr).toContain("hook says no")
  })

  test("--dry-run prints each command it would run", async () => {
    const r = await repoPair()
    await feature(r)
    await r.pushUpstream("two")
    const res = await sh(r.clone, `${gitMf} main --dry-run`)
    expect(res.stderr).toContain("RUN git fetch --quiet . origin/main:main")
    expect(res.stderr).toContain("RUN git merge --ff --no-edit --quiet origin/main")
  })

  test("extra flags pass through to git merge", async () => {
    const r = await repoPair()
    await feature(r)
    await r.pushUpstream("two")
    const res = await sh(r.clone, `${gitMf} main --no-ff -m 'custom message' --dry-run`)
    expect(res.stderr).toContain("--no-ff -m custom message origin/main")
  })
})

/** The argv a fake agent CLI received, one entry per argument. */
const agentArgs = async (root: string, name: string) =>
  (await readFile(join(root, `${name}.args`), "utf8")).trimEnd().split("\n")

/** A PATH with only the system tools and the given fake agent CLIs. */
async function fakeAgents(root: string, names: string[]) {
  const bin = join(root, "fake-bin")
  await mkdir(bin, { recursive: true })
  for (const name of names) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/${name}.args"\ncat > "${root}/${name}.stdin"\n`,
      { mode: 0o755 },
    )
  }
  return `${bin}:/usr/bin:/bin`
}

describe("git_mf --agent", () => {
  test("hands a conflict to claude with the prompt", async () => {
    const { root, clone, pushUpstream } = await repoPair()
    await ok(clone, "git switch -q -c feature")
    await ok(clone, "printf mine > file.txt && git commit -qam mine")
    await pushUpstream("theirs")
    const PATH = await fakeAgents(root, ["claude", "codex"])

    const r = await sh(clone, `${gitMf} main --agent`, { PATH })
    expect(r.code, r.stderr).toBe(0)
    const stdin = await readFile(join(root, "claude.stdin"), "utf8")
    expect(stdin).toContain("# Merge a Branch From origin Into the Current Branch")
    expect(stdin).toContain("conflicts in: file.txt")
    expect(await agentArgs(root, "claude")).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(git:*)",
      "Bash(just:*)",
      "Bash(bun:*)",
      "Bash(cargo:*)",
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
    ])
    expect(await Bun.file(join(root, "codex.stdin")).exists()).toBe(false)
  })

  test("falls back to codex when claude is missing", async () => {
    const { root, clone } = await repoPair()
    await ok(clone, "printf local > file.txt")
    const PATH = await fakeAgents(root, ["codex"])

    const r = await sh(clone, `${gitMf} main --agent`, { PATH })
    expect(r.code, r.stderr).toBe(0)
    expect(await readFile(join(root, "codex.stdin"), "utf8")).toContain(
      "uncommitted changes",
    )
    const repo = await ok(clone, "git rev-parse --show-toplevel")
    // --approve-for-me implies workspace-write and conflicts with --sandbox.
    expect(await agentArgs(root, "codex")).toEqual([
      "exec",
      "-C",
      repo,
      "--approve-for-me",
    ])
  })

  test("--dry-run names the agent without running it", async () => {
    const { root, clone } = await repoPair()
    await ok(clone, "printf local > file.txt")
    const PATH = await fakeAgents(root, ["claude"])

    const r = await sh(clone, `${gitMf} main --agent --dry-run`, { PATH })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stderr).toContain("RUN claude")
    expect(await Bun.file(join(root, "claude.stdin")).exists()).toBe(false)
  })

  test("with no agent installed says how to repair", async () => {
    const { root, clone } = await repoPair()
    await ok(clone, "printf local > file.txt")
    const PATH = await fakeAgents(root, [])

    const r = await sh(clone, `${gitMf} main --agent`, { PATH })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("neither claude nor codex")
  })
})
