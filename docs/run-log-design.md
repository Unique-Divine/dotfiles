# Boku Run Log

A run log for the tools on this machine. Each run of a tool, such as
`just sync`, `git_mf`, or the agent that `git_mf --agent` hands a conflict
to, appends events to a JSONL file under `~/.boku/runs/`. Nested runs link
through an exported run id, so one `just sync` reads as a tree.

Why: what an agent ran into is lost once the terminal scrolls away. A
record lets you fix the tool or the prompt so the next run goes better.

It's a Boku tool, built in the dotfiles repo under `runlog/`. Status:
draft, not implemented.

## Goals and Non-Goals

Goals:

- One folder and one event schema, written from bash and TS.
- Runs that link into a tree across processes.
- Agent runs that keep the agent's stream, report, and merge result.
- Logging that never changes exit codes or what happens to the repo.
- Bounded disk use and files jq can query.

Non-goals: a metrics system or daemon; machine output on stdout by default;
collecting runs across machines.

Borrowed from Claude and Codex session logs: one JSONL file per session,
UTC ms timestamps, a `type` tag per line, Codex's date folders, index, and
parent links, and Claude's out-of-line blobs. Added: a schema version.

## Layout on Disk

```
~/.boku/                              mode 0700; BOKU_HOME overrides
  runs/                               one shared log for every producer
    261109/                           UTC day the run started
      index.jsonl                     one summary line per finished run
      261109T142030Z-git_mf-8b9c.jsonl          events for one run
      261109T142030Z-git_mf-8b9c/               blobs for that run
        prompt.md                     prompt plus "This Run" context
        agent.jsonl                   redacted copy of the agent's stream
        report.md                     agent's final report
        remerge.diff                  git show --remerge-diff HEAD
        conflict.diff                 git diff of a merge left in progress
  dotfiles/                           dotfiles state that isn't a run
  cron/                               cron jobs' own state

${XDG_CACHE_HOME:-~/.cache}/dotfiles/ rebuildable caches, as today
```

Why `~/.boku` and not XDG: it sits beside `~/.claude` and `~/.codex`, the
logs this design copies, and it's one root that every Boku tool shares,
cron jobs included. XDG would split one tool across state, cache, and
config folders.

The state folders are empty in phase 1. Later examples:
`dotfiles/claude-keys.json` (keys `claude/config.ts` last wrote) and
`cron/merge-nightly.json` (backoff for a nightly `git_mf main`). Runs are
shared, not under `dotfiles/`, because that cron run must link to the
`git_mf` runs it starts. `source` names the producer.

Run id: `<yymmddTHHMMSSZ>-<tool>-<4 hex>`. It sorts by time, names the tool,
and contains its day folder, so the reader finds a file from the id alone.

Why the index is per day: pruning deletes whole day folders and never
edits a file. The rule is that no process rewrites a file a run might
still append to, so today's and yesterday's files are append-only. A
killed run never writes its index line, so run files are the truth. For
today and yesterday, `boku-runs` reads the run files directly; the index
is a fast path for older days only. `boku-runs reindex` rebuilds an older
day's index, writing a temp file and renaming it over the old one.

## Event Schema

| Field | Type | Notes |
| --- | --- | --- |
| `v` | int | Schema version, `1` |
| `ts` | string | UTC, ms, `2026-11-09T14:20:30.101Z` |
| `source` | string | Producer: `dotfiles` for now |
| `run_id` | string | This run |
| `parent_run_id` | string or null | Run that launched this one |
| `root_run_id` | string | Top of the tree |
| `tool` | string | `sync`, `git_mf`, ... |
| `event` | string | See below |

| `event` | Own fields |
| --- | --- |
| `start` | `argv` (redacted), `cwd`, `host`, `pid`, `pid_start`, `boot_id`, `rev`, optional `git: {repo, branch, head}` |
| `step` | `name`, optional `cmd`, `exit`, `dur_ms`, `msg`, plus fields of its own (see below) |
| `warn`, `error` | `code` (stable kebab-case), `msg` |
| `agent-session` | `cli`, `session_id` (written by the tap) |
| `agent-command` | `cmd`, `exit` (null if unparsed), `ref: {file, line}` or null, optional `truncated` (written by the tap) |
| `agent` | `cli`, `cli_version`, `session_id`, `exit`, `dur_ms`, `outcome`, `challenges` (first 512 characters) |
| `artifact` | `kind`, `path`, `bytes`, `sha256`, `truncated` |
| `end` | `exit`, `status` (`ok`, `stopped`, `failed`), `dur_ms`, `warns`, `errors` |

`agent-command` is its own kind: a step is something this process did and
timed; an agent command is something we watched. Two steps carry extra
fields: `plan` has `action`, `conflicts`, and `upstream_sha`; `prune` has
`removed_days` and `bytes_freed`. `warns` and `errors` count only the
run's own events; the reader sums a tree.

How `end` gets its status: `runlog_end EXIT [status=...]`. Without
`status`, the writer maps the exit code:

| Exit code | `status` | Meaning |
| --- | --- | --- |
| 0 | `ok` | Done |
| 2, 3, 4 | `stopped` | Stopped on purpose; nothing changed |
| 5 | `stopped` | An operation is in progress: found at start (nothing changed), or a merge the agent left (verify also logs `error agent-left-merge`) |
| anything else | `failed` | Something broke |

`git_mf` passes `status` itself after verify (see the verify table).

Examples from Tree 2's run (`...` shortens the common fields):

```json
{"v":1,"ts":"2026-11-09T14:20:30.101Z","source":"dotfiles","run_id":"261109T142030Z-git_mf-8b9c","parent_run_id":null,"root_run_id":"261109T142030Z-git_mf-8b9c","tool":"git_mf","event":"start","argv":["main","--agent"],"cwd":"/home/realu/ki/boku/jiyuu","host":"wsl-ud","pid":48121,"pid_start":91234567,"boot_id":"3f1c0d2e-...","rev":"52cf393","git":{"repo":"jiyuu","branch":"ud/x","head":"9c1e2aa"}}
{"v":1,...,"event":"agent-command","cmd":"just test","exit":1,"ref":{"file":"agent.jsonl","line":57}}
{"v":1,...,"event":"end","exit":0,"status":"ok","dur_ms":186002,"warns":1,"errors":0}
```

The index line copies the ids, `tool`, start time, `dur_ms`, `exit`,
`status`, counts, and `agent: {cli, session_id}`. New optional fields stay
in `v: 1`; renaming, removing, or retyping a field bumps `v`.

Size limits: strings are cut to 512 characters (plus `[cut]`). A line is
at most 4,095 bytes plus its newline; if it's still too long, only the
common fields and `"truncated": true` are written. Lines up to 4 KiB
leave in one `write()` in practice, and such appends don't interleave on
local Linux filesystems. A shared `index.jsonl` relies on that.

## Call Stack Walkthrough

`just sync` never passes `--agent` (see Decisions). A conflict found by
sync stops, and you hand it to the agent yourself. That makes two trees.

Each run exports `BOKU_RUN_ID` and `BOKU_ROOT_RUN_ID` to its children. A
run is named by the end of its id: `a1b2` is `261109T141203Z-sync-a1b2`.
`...` marks steps left out; square brackets mark conditional steps.

Tree 1, sync finds a conflict:

```
PROCESS                          WRITES (~/.boku/runs/261109/)
-------------------------------  ---------------------------------
just sync                        a1b2: start   (root, no parent)
 | [just i-bash]                 a1b2: step i-bash (stamp missing/>24h)
 | just claude-install           a1b2: step claude-install
 | just codex-install            a1b2: step codex-install
 | just i-jiyuu
 |  | bash zsh/sync-jiyuu.sh     c3d4: start   parent=a1b2
 |  |  | git_mf main             7f3a: start   parent=c3d4
 |  |  |  | fetch origin/main    7f3a: step fetch
 |  |  |  | plan (merge-tree)    7f3a: step plan conflicts=[src/a.rs]
 |  |  |  | needs judgment       7f3a: warn needs-judgment
 |  |  |  | exit 3               7f3a: end exit=3 stopped warns=1
 |  |  | case 2|3|4|5: continue  c3d4: warn jiyuu-left-as-is
 |  |  | check gh-rev/Cargo.toml c3d4: end exit=0 ok warns=1
 | <- exit 0                     a1b2: step i-jiyuu exit=0
 | bun install                   a1b2: step bun-install
 | main_bash_setup (function)    a1b2: step main-bash-setup msg=done
 | source symlinks.sh            a1b2: step symlinks msg=done
 | ... ud-install, [herdr], i-zinit
 | just gh-rev-install           a1b2: step gh-rev-install
 | ... [clipboard], config scripts, skillsSync.ts
 | boku-runs prune               e5f6: start   parent=a1b2
 |  | delete old day folders     e5f6: step prune removed_days=1
 |  |                              bytes_freed=48211
 |  | exit 0                     e5f6: end exit=0 ok
 | <- exit 0                     a1b2: step prune exit=0
 | exit 0                        a1b2: end exit=0 ok warns=0
```

A skipped step logs `msg: "skipped"`. If a step fails, `set -e` ends the
recipe and the exit handler still writes `end`:

```
 | just gh-rev-install           a1b2: step gh-rev-install exit=101
 | (set -e exits; on_exit)       a1b2: end exit=101 failed
```

Tree 2, you run `git_mf main --agent` in Jiyuu:

```
PROCESS                          WRITES (~/.boku/runs/261109/)
-------------------------------  ---------------------------------
git_mf main --agent              8b9c: start   (root)
 | fetch, plan, needs judgment   8b9c: step fetch; step plan
 |                                 upstream_sha=4d2e1f0; warn
 | write prompt                  8b9c/prompt.md; artifact
 | claude -p --session-id U ...  (Claude also writes its own
 |   | boku-runs tap              ~/.claude/projects/.../U.jsonl)
 |   |   each line               8b9c/agent.jsonl (redacted)
 |   |                           stderr: "agent: Bash just test"
 |   |   line 1: system init     8b9c: agent-session claude U
 |   |   line 57: exit 1         8b9c: agent-command just test exit=1
 |   |   line 80: exit 0         8b9c: agent-command just test exit=0
 |   |   result line             8b9c/report.md
 | <- pipeline done (both exit)
 | verify (table below)          8b9c: agent outcome=merged
 |                               8b9c/remerge.diff; artifacts
 | exit 0                        8b9c: end exit=0 ok warns=1
 |                               index += 8b9c
```

### The Agent Hand-Off

`run_agent` in `git_mf` gets restructured. Today it pipes the prompt into
the agent and its caller exits with the agent's status. The new one writes
prompt and context to one file, runs the pipeline, verifies, and returns
`git_mf`'s exit code. `run_dir` is the run's blob folder, and
`prompt_path` is `$run_dir/prompt.md`. With logging off, the prompt goes to
a `mktemp` file that `on_exit` removes.

```bash
run_agent() {                     # caller: run_agent "$reason"; exit $?
  write_prompt "$reason"          # prompt + "This Run" -> $prompt_path
  record_before                   # HEAD, stash count, <cli> --version
  if runlog_active && command -v boku-runs >/dev/null; then
    run_stream_pipeline           # below; sets agent_status
  else
    run_plain_agent               # today's command, plain text output
  fi
  verify                          # sets outcome, code, status
  save_artifacts                  # report check, remerge or conflict diff
  runlog_event agent outcome="$outcome" ...
  return "$code"                  # on_exit writes end with $status
}
```

It keeps its early exits for "no agent installed" and `--dry-run`.

The stream pipeline, Claude shown:

```bash
session_id="$(cat /proc/sys/kernel/random/uuid)"
set +e
claude -p --session-id "$session_id" \
    --output-format stream-json --verbose \
    --permission-mode acceptEdits \
    --allowedTools "Bash(git:*)" "Bash(just:*)" "Bash(bun:*)" \
      "Bash(cargo:*)" "Read" "Edit" "Write" "Grep" "Glob" \
    < "$prompt_path" \
  | { boku-runs tap --cli claude \
      || { runlog_event warn code=tap-exited; cat >/dev/null; }; }
agent_status="${PIPESTATUS[0]}"
set -e
```

Codex runs `codex exec --json -o "$run_dir/report.md" -C "$repo" -s
workspace-write --approve-for-me` the same way, with `--cli codex`. Codex
writes that report itself, so `git_mf` redacts it in place afterwards
with `boku-runs redact-file "$run_dir/report.md"`.

How it holds together:

- The tap is an ordinary pipeline stage, so bash waits for it, and its
  events land before verify and `end`. The agent's status is
  `PIPESTATUS[0]`.
- The tap (TS, Bun) reads stdin line by line. It saves each redacted line
  to `agent.jsonl`, prints one progress line per step to stderr, and
  writes `agent-session`, `agent-command`, and Claude's `report.md`. It
  finds its run through `BOKU_RUN_ID` and `BOKU_HOME`.
- On its own internal error, the tap logs `warn tap-failed` once and
  prints one notice to stderr: "progress display stopped; output still
  saved". It then drains quietly, still saving to `agent.jsonl` if it can,
  and exits 0.
- The tap exits non-zero only when it can't start or crashes outright.
  Only then does the shell fallback log `warn tap-exited` and drain with
  `cat`. So each failure gives one warning, and the agent never gets
  SIGPIPE.
- Session ids: for Claude, `git_mf` makes the UUID and passes it with
  `--session-id`; the tap confirms it against `init` and warns
  `session-mismatch` if they differ. Codex's comes from `thread.started`.

Fail open means exit codes and repo changes never depend on logging. What
you see does change: progress lines instead of Claude's plain text. If
`runlog_start` failed or `boku-runs` is missing, the agent runs as today.

How the tap reads each stream:

- Claude: `system` `init` carries `session_id`. `assistant` lines carry
  Bash `tool_use` blocks; a later `user` line carries the matching
  `tool_result` (by `tool_use_id`) with `is_error`. The final `result`
  line holds the report. The exit code is parsed from "Exit code N" in an
  error result. That text isn't a contract, so a miss gives `exit: null`
  and one `warn exit-unparsed`.
- Codex: `thread.started` carries `thread_id`. Each `item.completed` with
  type `command_execution` carries `command` and `exit_code`.
- `ref.line` points at the result line (`tool_result` or `item.completed`).
  If that line falls past the 20 MiB copy cap, the event gets `ref: null`
  and `truncated: true`.

Phase 1 logs every command, not only failed ones: successes show which
checks the agent ran, and there are only a few dozen.

### Verifying the Agent's Work

`git_mf` doesn't trust the agent's exit code. Before the hand-off, the
plan step records `upstream_sha`, the commit given to the agent. Every
path, the dirty tree included, resolves it the same way: `origin/<target>`
if that ref exists locally, else the local `<target>`, else null.
Afterwards `git_mf` checks
`git merge-base --is-ancestor "$upstream_sha" HEAD`, without fetching
again. If `origin` moved during the run, that's the next run's job.

| Agent exit | Operation in progress | `upstream_sha` in `HEAD` | Outcome | `git_mf` exit | `status` |
| --- | --- | --- | --- | --- | --- |
| any | yes (`MERGE_HEAD` etc.) | n/a | `stopped` | 5 | `stopped` |
| 0 | no | yes, `HEAD` moved | `merged` | 0 | `ok` |
| 0 | no | yes, `HEAD` unchanged (dirty tree, already up to date) | `no-change` | 0 | `ok` |
| 0 | no | no, `HEAD` unchanged | `no-change` | 3 | `stopped` |
| 0 | no | no, `HEAD` moved | `failed` | 1 | `failed` |
| non-zero | no | yes, `HEAD` moved | `merged`, plus `warn agent-exit-nonzero` | 0 | `ok` |
| non-zero | no | otherwise | `failed` | 1 | `failed` |

A null `upstream_sha` means "can't verify". The outcome then comes from
repo state alone (operation in progress, `HEAD` moved), with
`warn upstream-unknown`. If the tree started clean and is dirty
afterwards, `git_mf` adds `warn agent-left-changes`.

`stopped` exits 5. A merge is still in progress, so 5 is what the next
`git_mf` run would return anyway, and `sync-jiyuu.sh` already treats 5 as
"left as is".

Artifacts: `agent.jsonl` when the tap ran; `report.md` from the tap or
`-o`, else `warn report-missing`; `remerge.diff` for a `merged` merge
commit; `conflict.diff` (`git diff` of the merge in progress) for
`stopped`.

Dirty tree: `--agent` also hands over exit 2 (uncommitted changes). The
plan step stops before fetching and records `upstream_sha` from the refs
it already has. The agent stashes, merges, and restores. A grown stash
count logs `warn agent-left-stash`.

### Failure Case: Agent Stops Mid-Merge

The prompt tells the agent to stop with the merge in progress when it can't
tell what a side meant. `claude -p` still exits 0:

```
git_mf main --agent (8b9c)
 | claude ... | tap <- exit 0
 | verify: MERGE_HEAD present    8b9c: agent exit=0 outcome=stopped
 |                               8b9c/report.md, conflict.diff
 |                               8b9c: error agent-left-merge
 | exit 5                        8b9c: end exit=5 stopped warns=1
 |                                 errors=1
```

Two more failures:

- Killed (SIGKILL): no `end`. A run without `end` shows as `running` while
  its pid is alive with the same start time (field 22 of
  `/proc/<pid>/stat` equals `pid_start`, same `boot_id`), and as
  `incomplete` otherwise. That catches pid reuse, and because recent days
  are read directly, both show up at once. Off Linux: `incomplete` after
  24 hours without `end`.
- `~/.boku` unwritable or `jq` missing: no events; plain agent mode. On a
  fresh machine, the first `sync` logs nothing until `i-bash` installs
  `jq`, which is fine because logging fails open.

## Writer APIs

```
runlog/runlog.sh   bash writer, sourced
runlog/runlog.ts   TS writer, imported
runlog/cli.ts      boku-runs: reader, tap, prune, redact-file
                   (linked to ~/.local/bin)
runlog/redact-patterns.json   shared redaction patterns
runlog/*.test.ts
```

Rules for both writers:

- A run's events come from the process that started it, or from the tap
  in its agent pipeline.
- Writer functions always succeed. After the first error they turn off
  for the rest of that process (`BOKU_RUNLOG_DEBUG=1` prints it). Child
  processes try again on their own, which is intended: one bad write
  shouldn't silence a whole tree. `BOKU_RUNLOG=0` turns logging off.
- When the writer is off, `BOKU_RUN_ID` isn't exported, so children start
  their own root runs.
- Files are `0600`, folders `0700`.

### Bash: `runlog/runlog.sh`

```bash
runlog_start TOOL [ARG...]       # writes start; exports BOKU_RUN_ID,
                                 # BOKU_ROOT_RUN_ID
runlog_active                    # 0 if this process's run started
runlog_event KIND [KEY=VAL ...]  # KEY=VAL is a string; KEY:=JSON is raw
runlog_step NAME CMD [ARG...]    # external commands only; see below
runlog_artifact KIND FILE        # copy (capped, redacted) into run folder
runlog_end EXIT [status=...]     # writes end and the index line
```

`runlog_step` keeps the command's status without tripping `set -e`:

```bash
runlog_step() {
  local -r name="$1"; shift
  local rc=0 t0; t0="$(date +%s%3N)"
  "$@" || rc=$?
  runlog_event step name="$name" exit:="$rc" \
    dur_ms:="$(( $(date +%s%3N) - t0 ))"
  return "$rc"
}
```

It wraps external commands only, such as `just gh-rev-install` or
`git switch`. Two bash rules make wrapping anything else unsafe. A command
left of `||` runs with `set -e` off, inside any function it calls too, so
a wrapped function would keep going past its own failures. And `source`
inside a function makes the file's `declare`d variables local to it. So
`main_bash_setup` and `source symlinks.sh` run unwrapped, followed by
`runlog_event step name=... msg=done`.

The writer sets no traps. Each producer calls `runlog_end` from one exit
handler, so a run that dies under `set -e` still writes `end`. In `git_mf`
it absorbs the merge branch's `trap 'rm -f -- "$merge_log"' EXIT`, which
would otherwise replace it:

```bash
on_exit() {
  local -r code=$?
  [[ -n "${merge_log:-}" ]] && rm -f -- "$merge_log"
  runlog_end "$code" ${status:+status="$status"}
}
runlog_start git_mf "$@"
trap on_exit EXIT
```

`status` is set only by verify; other exits use the default mapping.
`runlog_start` runs after argument parsing, so `--help` and usage errors
log nothing, while the no-target pull path and `--dry-run` runs are
logged. The `sync` recipe and `sync-jiyuu.sh` (whose `fail()` calls
`exit 1`) use the same handler without the `merge_log` and `status` parts.

`git_mf` logs a `step` for the plan and for each `run()` command, through
`runlog_step` (`msg: "dry-run"` under `--dry-run`). The target fetch and
the merge print `RUN ...` themselves and bypass `run()`, so they get
explicit step events.

JSON is built with `jq -nc --arg` (`just i-bash` installs `jq`), because
hand-escaped JSON is where bugs hide. Cut, measure, then write with a
single `printf` to the file opened for append:

```bash
line="$(jq -nc --slurpfile pats "$patterns" ... '... | walk(
  if type == "string" then redact($pats[0]) | cut(512) else . end)')"
(( $(printf %s "$line" | wc -c) <= 4095 )) || line="$fallback_line"
printf '%s\n' "$line" >>"$run_file"
```

`redact` is a small jq function that applies each pattern with `gsub`.
The cap relies on bash's `printf` writing a line of that size in one call.
`runlog_artifact` uses `boku-runs redact-file` when it's on `PATH`, and
the same jq filter line by line otherwise.

Every internal command ends in `|| true`.

### TypeScript: `runlog/runlog.ts`

```ts
export function startRun(tool: string, opts?: StartOptions): RunLog
// RunLog: event(kind, fields), step(name, fn), artifact(kind, src),
//         end(exit, { status? })
// Pure, exported for tests: newRunId, buildEvent, redact, statusFor
```

`buildEvent` cuts strings with `slice(0, 512)` and checks
`Buffer.byteLength` against 4,095 bytes. Writes use `appendFileSync`, so
an `end` from an exit handler still lands.

## Agent Runs

`agent.jsonl` is what happened, and the Challenges section is the agent's
own explanation. Our copy follows our pruning, not Claude's 30-day
transcript cleanup.

`git_mf.prompt.md` gains a required last section:

```markdown
## Challenges

What slowed you down or confused you: missing context, misleading git
output, permissions you lacked, slow or flaky checks. Say what git_mf or
this prompt could do to make the next run easier. Write "None" if nothing.
```

A report without it gets `warn report-missing-challenges`. Later, recipes
the agent runs, such as `just test`, could log their own child runs.

### Reviewing Runs

`boku-runs`, or `just runs` with the same arguments:

```
boku-runs                         last 20 top-level runs
boku-runs show last --tree        a run's events and its children
boku-runs agent 8b9c              the agent stream, one readable line each
boku-runs agent 8b9c --at 57      jump to line 57, with context
boku-runs challenges --since 30d  every Challenges section, newest first
boku-runs redact-file FILE        redact a file in place
boku-runs reindex | prune [DAYS]  maintenance
```

The learning loop: read the Challenges, follow refs with `--at`, and fix
what repeats. For anything else, the files are plain JSONL for jq, such as
`jq 'select(.event == "agent-command" and .exit != 0)'`.

## Retention, Pruning, and Caching

`sync` ends with `runlog_step prune boku-runs prune`. Prune is a Bun tool,
so it starts its own child run with the TS writer. It deletes day folders
older than 30 days (never today or yesterday, UTC), then the oldest days
while `runs/` is over 512 MiB, with a `warn`. Its own `prune` step carries
`removed_days` and `bytes_freed`. The tap cuts stream lines over
16,384 characters in place, so line numbers stay stable, and stops
copying at 20 MiB. What you'd miss goes in `~/.boku`; what's only slow to
rebuild goes in `XDG_CACHE_HOME`, which pruning never touches.

## Privacy and Redaction

Never log the environment. `argv`, string fields, artifacts, and every
`agent.jsonl` line are redacted. The patterns live in one file,
`runlog/redact-patterns.json`, as `{kind, regex}` entries: token shapes
(`ghp_`, `github_pat_`, `sk-`, `xox[abpr]-`, `AKIA`, `glpat-`, JWTs) and
values after `token=`, `secret=`, `password=`, or `Bearer `. The TS
`redact()` loads it, and the bash writer applies it in jq with `gsub`. The
regexes stick to the subset both JS and jq's Oniguruma accept, and a test
runs every fixture through both writers and compares the output. Diffs
exclude `secrets/` and `*.env*`. `agent.jsonl` holds files the agent read,
so it matches `~/.claude`: local, `0600`, never synced.

## The `--json` Stdout Convention

`--json` prints the tool's events to stdout, ending with `end`; human text
moves to stderr. Bash tools set `BOKU_RUNLOG_STDOUT=1` so the writer tees;
TS tools use a shared `addJsonOption(program)`. The writer unsets
`BOKU_RUNLOG_STDOUT` for children, and printing doesn't depend on the
file, so `--json` works with logging off. `git_mf` parses `--json` as its
own flag before collecting merge flags.

## Rollout

Phase 1:

- [ ] Add `runlog/` (writers, tap, `boku-runs`, tests), link `boku-runs`
  into `~/.local/bin`, and add `just runs *args`.
  - Why: every producer needs one writer and schema, readable anywhere.
- [ ] Restructure `run_agent`; log `git_mf` with `on_exit`, tap, verify.
  - Why: agent merges are where you most want to learn from failures.
- [ ] Add the Challenges section to `git_mf.prompt.md`.
  - Why: only the agent can say why something was hard.
- [ ] Log `sync` and `sync-jiyuu.sh` with `on_exit`; end `sync` with
  `boku-runs prune`.
  - Why: a failed sync must still say so, and the log must stay bounded.
- [ ] Add `--json` to `git_mf`.
  - Why: it proves the convention where the output is most worth parsing.

Later: install history in the `native.sh` scripts, `zsh/health.sh` drift,
the TS sync scripts, recipes as child runs, and cron jobs. Risk: stream
formats change; lines are still copied and parse misses become warnings.

## Testing Strategy

`bun:test`, real temp directories, real processes, as in
`skillsSync.test.ts`. Each test sets `BOKU_HOME` to its own `mkdtemp`.

- Writer: caps (a 100 KiB multibyte `msg` stays within 4,096 bytes with
  the newline), status mapping, linking, 50 concurrent appends,
  redaction, prune as a child run, and past-day `reindex`.
- Fail open: unwritable `BOKU_HOME` or no `jq` gives the same exit code
  and repo state as `BOKU_RUNLOG=0`, and leaves no temp prompt behind.
- Exit handlers: a clean `git_mf` merge and a failing `sync` step write
  `end` and an index line; `--help` writes nothing.
- `git_mf` on real repos with a bare `origin`: each verify row, including
  `origin` moving during the run, and `--dry-run --agent`.
- Tap: fake `claude` and `codex` scripts print a test-built stream with a
  failed command and a planted token. Assert redacted `agent.jsonl` and
  `report.md` (Codex's via `redact-file`), one `agent-command` per
  command, the failure's `ref.line`, and `end` as the last line.
- Tap failure: a `boku-runs` that dies at startup (`tap-exited`), and a
  run folder deleted mid-stream (`tap-failed`, one notice). The agent
  finishes and `git_mf` exits with the verified code.
- Real agent: one Claude conflict, gated behind `BOKU_TEST_AGENT=1`.

## Decisions

1. Sync never passes `--agent`: unattended agents could clobber work.
2. Agent runs keep 30-day retention; the Challenges review stays manual.
3. Homebox runs come later; `host` is already logged.
4. Reader: `boku-runs` on PATH plus `just runs`.
5. Root is `~/.boku`, not XDG folders (see Layout).

### Still Open

- Is 16,384 characters per stream line enough? Cutting large tool outputs
  keeps folders small but can hide the end of a long test log. The
  fallback is the full transcript, while it exists.
