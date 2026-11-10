# Boku Run Log

A run log for the tools on this machine. Each run of a tool, such as
`just sync`, `git_mf`, or the agent that `git_mf --agent` hands a conflict
to, appends events to a JSONL file under `~/.boku/runs/`. Nested runs link
through an exported run id, so one `just sync` reads as a tree.

Why: what an agent ran into is lost once the terminal scrolls away. A
record lets you fix the tool or the prompt so the next run goes better.

It's a Boku tool, built in the dotfiles repo under `runlog/`. Status:
implemented (dotfiles#91), updated after review round 2.

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
        prompt.md                     redacted copy of the agent's prompt
        agent.jsonl                   redacted copy of the agent's stream
        report.md                     agent's final report, redacted
        remerge.diff                  git show --remerge-diff HEAD
        conflict.diff                 git diff of a merge left in progress
  dotfiles/                           dotfiles state that isn't a run
  cron/                               cron jobs' own state

${XDG_CACHE_HOME:-~/.cache}/dotfiles/ rebuildable caches, as today
```

Why `~/.boku` and not XDG: it sits beside `~/.claude` and `~/.codex`, and
it's one root every Boku tool shares. XDG would split a tool in three.

The state folders are empty in phase 1. Runs are shared, not under
`dotfiles/`, because a cron run must link to the `git_mf` runs it starts.
`source` names the producer.

Run id: `<yymmddTHHMMSSZ>-<tool>-<4 hex>`. It names the tool and contains
its day folder, so the reader finds a file from the id alone. `tool` keeps
`[A-Za-z0-9_.-]`, up to 40 characters. The reader orders runs by start
`ts`, then id. Any unique part of an id selects a run; when several
match, the newest wins and the others are named on stderr.

Why the index is per day: pruning deletes whole day folders and never
edits a file, so today's and yesterday's files are append-only. A killed
run never writes its index line, so run files are the truth. For today
and yesterday, `ud runs` reads the run files directly; the index is a fast
path for older days, and run files missing from it show as `incomplete`.
`ud runs reindex`, and prune for any kept past day, rebuild an index
through a temp file and a rename.

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
| `step` | `name`, optional `cmd` (JSON array of argv), `exit`, `dur_ms`, `msg`, plus fields of its own (see below) |
| `warn`, `error` | `code` (stable kebab-case, see Codes), `msg` |
| `agent-session` | `cli`, `session_id` (written by the tap) |
| `agent-command` | `cmd` (string), `exit` (null if unparsed), `ref: {file, line}` or null, optional `truncated` (written by the tap) |
| `agent` | `cli`, `cli_version`, `session_id`, `exit`, `dur_ms`, `outcome`, `challenges` |
| `artifact` | `kind`, `path`, `bytes`, `sha256`, `truncated` |
| `end` | `exit`, `status` (`ok`, `stopped`, `failed`), `dur_ms`, `warns`, `errors` |

A step is something this process did and timed; an `agent-command` is
something we watched, so its `cmd` is the agent's command line as one
string.

`git` on `start` comes from the shell variable `RUNLOG_START_GIT`, a JSON
object set before `runlog_start` (TS: `StartOptions.git`). Only `repo`,
`branch`, and `head` are kept. `repo` is the toplevel path, never a remote
URL, since remote URLs can carry `https://user:token@`.

Two steps carry extra fields. `plan` has `action`, `target`, `upstream`,
`upstream_sha`, `conflicts` (an array of paths, capped at 200), and
`conflicts_total`. `prune` has `removed_days`, `bytes_freed`, and
`reindexed_days`. `end.warns` and `end.errors` count the run file's lines,
so the tap's and subshells' warnings count; the reader sums a tree.

Artifact kinds: `prompt`, `report`, `remerge-diff`, `conflict-diff`, and
`agent-stream` (`agent.jsonl`, logged by the tap when it finishes, with
`truncated` when the copy hit its cap).

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
{"v":1,"ts":"2026-11-09T14:20:30.101Z","source":"dotfiles","run_id":"261109T142030Z-git_mf-8b9c","parent_run_id":null,"root_run_id":"261109T142030Z-git_mf-8b9c","tool":"git_mf","event":"start","argv":["main","--agent"],"cwd":"/home/realu/ki/boku/jiyuu","host":"wsl-ud","pid":48121,"pid_start":91234567,"boot_id":"3f1c0d2e-...","rev":"52cf393","git":{"repo":"/home/realu/ki/boku/jiyuu","branch":"ud/x","head":"9c1e2aa"}}
{"v":1,...,"event":"step","name":"fetch-target","cmd":["git","fetch","--quiet","--prune","origin","+refs/heads/main:refs/remotes/origin/main"],"exit":0,"dur_ms":812,"ref":"origin/main"}
{"v":1,...,"event":"agent-command","cmd":"just test","exit":1,"ref":{"file":"agent.jsonl","line":57}}
{"v":1,...,"event":"end","exit":0,"status":"ok","dur_ms":186002,"warns":1,"errors":0}
```

The index line copies the ids, `tool`, start time, `dur_ms`, `exit`,
`status`, counts, and `agent: {cli, session_id}`. New optional fields stay
in `v: 1`; renaming, removing, or retyping a field bumps `v`.

Size limits:

- Strings are cut to 512 code points (plus `[cut]`), after redaction, so
  a character is never split.
- A line is at most 4,095 bytes plus its newline, else only the common
  fields and `"truncated": true` are written. Such a line leaves in one
  `write()`, so appends to a shared `index.jsonl` don't interleave.
- The jq redaction fallback keeps the first 1 MiB of a file, cut at a full
  line. The artifact is marked `truncated` and logs
  `warn redact-fallback-capped`.

### Codes

`code` is stable, so these are the full set. A new code is a new row.

| Producer | `warn` | `error` |
| --- | --- | --- |
| `git_mf` | `needs-judgment`, `fetch-failed`, `pull-failed`, `upstream-unknown`, `agent-exit-nonzero`, `agent-left-changes`, `agent-left-stash`, `report-missing`, `report-missing-challenges`, `tap-exited` | `agent-left-merge`, `merge-tree-failed`, `merge-failed`, `fetch-failed` (a fetch error, not a missing branch) |
| tap | `tap-failed`, `session-mismatch`, `exit-unparsed` | |
| Both writers | `artifact-missing`, `artifact-failed` | |
| Bash writer | `redact-pattern-invalid`, `redact-fallback-capped` | |
| `sync-jiyuu.sh` | `jiyuu-left-as-is` | `sync-jiyuu-failed` |
| prune | `size-cap`, `size-cap-unmet` | `prune-failed` |

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
 | [just i-bash]                 a1b2: step i-bash (or msg=skipped)
 | ... claude-, codex-install
 | just i-jiyuu
 |  | bash zsh/sync-jiyuu.sh     c3d4: start   parent=a1b2
 |  |  | git_mf main             7f3a: start   parent=c3d4
 |  |  |  | fetch origin/main    7f3a: step fetch-target
 |  |  |  | plan (merge-tree)    7f3a: step plan conflicts=[src/a.rs]
 |  |  |  | needs judgment       7f3a: warn needs-judgment
 |  |  |  | exit 3               7f3a: end exit=3 stopped warns=1
 |  |  | case 2|3|4|5: continue  c3d4: step git_mf exit=3
 |  |  |                         c3d4: warn jiyuu-left-as-is
 |  |  | check gh-rev/Cargo.toml c3d4: end exit=0 ok warns=1
 | <- exit 0                     a1b2: step i-jiyuu exit=0
 | main_bash_setup (function)    a1b2: step main-bash-setup msg=done
 | ... symlinks, [herdr], gh-rev-install, [clipboard], configs
 | bun run runlog/cli.ts prune   e5f6: start   parent=a1b2
 |  | delete old day folders     e5f6: step prune removed_days=1
 |  | exit 0                     e5f6: end exit=0 ok
 | <- exit 0                     a1b2: step prune exit=0
 | exit 0                        a1b2: end exit=0 ok warns=0
```

Every conditional step that doesn't run logs `msg: "skipped"`, so a
missing step can't be mistaken for a sync that died. If a step fails,
`set -e` ends the recipe and the exit handler still writes `end`:

```
 | just gh-rev-install           a1b2: step gh-rev-install exit=101
 | (set -e exits; on_exit)       a1b2: end exit=101 failed
```

Tree 2, you run `git_mf main --agent` in Jiyuu:

```
PROCESS                          WRITES (~/.boku/runs/261109/)
-------------------------------  ---------------------------------
git_mf main --agent              8b9c: start   (root)
 | fetch, plan, needs judgment   8b9c: step fetch-target; step plan
 |                                 upstream_sha=4d2e1f0; warn
 | write prompt (temp, 0600)     8b9c/prompt.md (redacted); artifact
 | claude -p --session-id U ...  (Claude also writes its own
 |   | cli.ts tap                  ~/.claude/projects/.../U.jsonl)
 |   |   each line               8b9c/agent.jsonl (redacted)
 |   |                           stderr: "agent: Bash just test"
 |   |   line 1: system init     8b9c: agent-session claude U
 |   |   line 57: exit 1         8b9c: agent-command just test exit=1
 |   |   line 80: exit 0         8b9c: agent-command just test exit=0
 |   |   result line             8b9c/report.md
 |   |   end of stream           8b9c: artifact agent-stream
 | <- pipeline done (both exit)
 | verify (table below)          8b9c: agent outcome=merged
 |                               8b9c/remerge.diff; artifacts
 | exit 0                        8b9c: end exit=0 ok warns=1
 |                               index += 8b9c
```

### The Agent Hand-Off

`run_agent` writes the prompt, runs the pipeline, verifies, and returns
`git_mf`'s exit code. The prompt and its "This Run" context go to a 0600
`mktemp` file that the agent reads and `on_exit` removes (see Privacy).
`run_dir` is the run's blob folder.

```bash
run_agent() {                     # caller: run_agent "$reason"; exit $?
  write_prompt "$reason"          # raw -> $prompt_tmp; copy -> prompt.md
  record_before                   # HEAD, stash count, <cli> --version
  if runlog_active && [[ -n "$run_dir" && -x "$runs_cli" ]]; then
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
`needs_judgment` logs `warn needs-judgment` before it hands off.

`ud runs` is the plugin `runlog/cli.ts`, linked as
`~/.local/share/ud/plugins/ud-runs`. `git_mf` and `runlog.sh` call it by
path as `$runs_cli`; `BOKU_RUNS_CLI` overrides the path. The stream
pipeline, Claude shown:

```bash
session_id="$(cat /proc/sys/kernel/random/uuid)"
set +e
runlog_exec claude -p --strict-mcp-config --permission-mode acceptEdits \
    --allowedTools "Bash(git:*)" "Bash(just:*)" "Bash(bun:*)" \
      "Bash(cargo:*)" "Read" "Edit" "Write" "Grep" "Glob" \
    --session-id "$session_id" --output-format stream-json --verbose \
    < "$prompt_tmp" \
  | { runlog_exec "$runs_cli" tap --cli claude --session-id "$session_id" \
      || { runlog_event warn code=tap-exited; cat >/dev/null; }; }
agent_status="${PIPESTATUS[0]}"
set -e
```

`--strict-mcp-config` loads no MCP servers, which the merge doesn't need.
Codex runs `codex exec -C "$repo" -s workspace-write --approve-for-me
--json -o "$report_tmp"` the same way, with `--cli codex`.

How it holds together:

- The tap is an ordinary pipeline stage, so bash waits for it, and its
  events land before verify and `end`.
- The tap (TS, Bun) reads stdin line by line. It saves each redacted line
  to `agent.jsonl`, prints one redacted progress line per step to stderr
  with control characters escaped,
  and writes `agent-session`, `agent-command` (every command, see
  Decision 6), Claude's `report.md`, and the `agent-stream` artifact. A
  Bash call with no result by the end logs `exit: null, ref: null`.
- On its own internal error, the tap logs `warn tap-failed` once, prints
  one notice, drains quietly, and exits 0. Only if it can't start or
  crashes does the shell fallback log `warn tap-exited` and drain with
  `cat`. So each failure gives one warning, and the agent never gets
  SIGPIPE.
- Session ids: for Claude, `git_mf` makes the UUID and the tap warns
  `session-mismatch` if `init` differs. Codex's comes from
  `thread.started`.

Fail open means exit codes and repo changes never depend on logging. If
`runlog_start` failed or the CLI isn't executable, the agent runs with
plain text output.

How the tap reads each stream:

- Claude: `system` `init` carries `session_id`. A Bash `tool_use` block
  is matched to its `tool_result` by `tool_use_id`. The final `result`
  line holds the report. The exit code is parsed from "Exit code N" in an
  error result. That text isn't a contract, so a miss gives `exit: null`
  and one `warn exit-unparsed`.
- Codex: `thread.started` carries `thread_id`; each `item.completed` of
  type `command_execution` carries `command` and `exit_code`.
- `ref.line` points at the result line. Past the 20 MiB copy cap, the
  event gets `ref: null` and `truncated: true`.

### Verifying the Agent's Work

`git_mf` doesn't trust the agent's exit code. Before the hand-off, the
plan step records `upstream_sha`, the commit given to the agent: on every
path, `origin/<target>` if that ref exists locally, else the local
`<target>`, else null. Afterwards `git_mf` checks
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

A null `upstream_sha` judges by repo state alone, with
`warn upstream-unknown`. A tree that started clean and ends dirty, when
the outcome isn't `stopped`, adds `warn agent-left-changes`.

`stopped` exits 5, what the next `git_mf` run would return anyway;
`sync-jiyuu.sh` treats 5 as "left as is".

Artifacts: `agent.jsonl` when the tap ran; `report.md`, else
`warn report-missing`; `remerge.diff` for a `merged` merge commit;
`conflict.diff` for `stopped`.

Dirty tree: `--agent` also hands over exit 2. The plan step stops before
fetching and records `upstream_sha` from the refs it has. The agent
stashes, merges, and restores; a grown stash logs `warn agent-left-stash`.

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

- Killed: `runlog_trap_signals` turns INT, TERM, and HUP into exit 130,
  143, or 129, so `end` says `failed`. SIGKILL leaves no `end`; the run
  shows as `running` while its pid lives with the same start time
  (`pid_start` and `boot_id` match), else `incomplete`. Off Linux:
  `incomplete` after 24 hours.
- `~/.boku` unwritable or `jq` missing: no events; plain agent mode. A
  fresh machine's first `sync` logs nothing until `i-bash` installs `jq`.

## Writer APIs

```
runlog/runlog.sh              bash writer, sourced
runlog/runlog.ts              TS writer, imported
runlog/cli.ts                 ud runs: reader, tap, prune, redact-file
runlog/redact-patterns.json   shared redaction patterns
runlog/redact-patterns.md     their rules and gaps
runlog/*.test.ts
```

Rules for both writers:

- A run's events come from the process that started it, or from the tap
  in its agent pipeline.
- Writer functions always succeed. After the first error they turn off
  for the rest of that process (`BOKU_RUNLOG_DEBUG=1` prints it). Child
  processes try again, so one bad write doesn't silence a tree; they
  start their own root runs. `BOKU_RUNLOG=0` turns logging off.
- Files are `0600`, folders `0700`. Both writers and the tap refuse a
  symlink below `BOKU_HOME`: the runs folder, a day folder, the run
  folder, the run file, `index.jsonl`, `agent.jsonl`, or `report.md`.
  The run file is claimed with an exclusive create, so run ids are
  unique.
- A failed start leaves no run file, so no empty run is listed.

### Bash: `runlog/runlog.sh`

```bash
runlog_start TOOL [ARG...]       # writes start; exports BOKU_RUN_ID,
                                 # BOKU_ROOT_RUN_ID
runlog_active                    # 0 if this process's run is logging
runlog_event KIND [KEY=VAL ...]  # KEY=VAL is a string; KEY:=JSON is raw
runlog_step NAME CMD [ARG...]    # external commands only; see below
runlog_exec CMD [ARG...]         # CMD without the --json stdout copy
runlog_artifact KIND FILE        # copy (capped, redacted) into run folder
runlog_dir                       # print the run folder, creating it
runlog_file                      # print the run's events file
runlog_end EXIT [status=...]     # writes end and the index line
runlog_trap_signals              # INT, TERM, HUP exit 128+N
```

`runlog_step` keeps the command's status without tripping `set -e`, and
logs `cmd` as a JSON array:

```bash
runlog_step() {
  local -r name="$1"; shift
  local rc=0 t0
  _runlog_now; t0="$_runlog_ms"   # from EPOCHREALTIME, no fork
  runlog_exec "$@" || rc=$?
  _runlog_now
  runlog_event step name="$name" cmd:="$(json_argv "$@")" \
    exit:="$rc" dur_ms:="$(( _runlog_ms - t0 ))"
  return "$rc"
}
```

`date +%s%3N` is never used: BSD `date` has no `%N`. `json_argv` stands
for `jq -nc '$ARGS.positional' --args -- "$@"`; the `--` keeps `--quiet`
from being read as a jq option.

It wraps external commands only. A command left of `||` runs with
`set -e` off, inside any function it calls too, and `source` inside a
function makes `declare`d variables local. So `main_bash_setup` and
`source symlinks.sh` run unwrapped, followed by `step ... msg=done`.

The writer sets no traps. Each producer calls `runlog_end` from one exit
handler, so a run that dies under `set -e` still writes `end`. In
`git_mf` it also removes the temp files:

```bash
on_exit() {
  local -r code=$?
  [[ -n "$merge_log" ]] && rm -f -- "$merge_log"
  [[ -n "$prompt_tmp" ]] && rm -f -- "$prompt_tmp"
  [[ -n "$report_tmp" ]] && rm -f -- "$report_tmp"
  runlog_end "$code" ${status:+status="$status"}
}
runlog_start git_mf "$@"
trap on_exit EXIT
runlog_trap_signals
```

`status` is set only by verify. `runlog_start` runs after argument
parsing, so `--help` logs nothing. The `sync` recipe and `sync-jiyuu.sh`
use `trap 'runlog_end $?' EXIT` and `runlog_trap_signals`.

`git_mf` logs a `step` for the plan and for each `run()` command
(`msg: "dry-run"` under `--dry-run`). The target fetch and the merge
log their own `fetch-target` and `git merge` steps.

Each line is built by one jq program (`just i-bash` installs `jq`), since
hand-escaped JSON is where bugs hide: redact every string with `gsub`,
cut, measure, then append with a single `printf`. `runlog_start` compiles
each pattern in jq once. One that fails is skipped with
`warn redact-pattern-invalid` naming its `kind`, and the writer stays on.
A missing patterns file turns the writer off, so nothing is written
unredacted. `runlog_artifact` uses `"$runs_cli" redact-file` when it
works, else the jq fallback. Every internal command ends in `|| true`.

### TypeScript: `runlog/runlog.ts`

```ts
export function startRun(tool: string, opts?: StartOptions): RunLog
// RunLog: event(kind, fields), step(name, fn), artifact(kind, src),
//         end(exit, { status? })
// Pure, exported for tests: newRunId, buildEvent, redact, statusFor
```

`buildEvent` cuts strings by code point and checks `Buffer.byteLength`
against 4,095 bytes. Writes use `appendFileSync` with `O_NOFOLLOW`, so a
symlinked run file is refused and an `end` from an exit handler still
lands.

## Agent Runs

`agent.jsonl` is what happened, and the Challenges section is the agent's
own explanation. Our copy follows our pruning, not Claude's 30-day
transcript cleanup.

`git_mf.prompt.md` ends with a required section:

```markdown
## Challenges

What slowed you down or confused you: missing context, misleading git
output, permissions you lacked, slow or flaky checks. Say what git_mf or
this prompt could do to make the next run easier. Write "None" if nothing.
```

A report without it gets `warn report-missing-challenges`. The `agent`
event's `challenges` holds that section.

### Reviewing Runs

`ud runs`, or `just runs` with the same arguments (passed quoted, never
re-parsed by the shell):

```
ud runs [-n N]                  last 20 top-level runs (also: list)
ud runs show last --tree        a run's events and its children
ud runs agent 8b9c              the agent stream, one readable line each
ud runs agent 8b9c --at 57      jump to line 57 (-C context, --raw JSON)
ud runs challenges --since 30d  the learning view, newest first
ud runs redact-file FILE        redact a file in place
ud runs reindex [DAYS...]       rebuild past days' index files
ud runs prune [DAYS]            delete old days (--max-bytes N)
ud runs --plugin-info           metadata ud reads to list the plugin
```

- A run is top-level when it has no parent or its parent isn't loaded.
  Pruning by day can split a tree that crosses midnight UTC; the child
  then shows as top-level.
- A parent cycle, which only a corrupt file can make, shows each run
  once and marks the repeat `(cycle: shown above)`.
- `--since` takes `Nd`, `Nh`, or an ISO date or datetime
  (`2026-11-01`, `2026-11-01T10:00`). Anything else, such as `7`, is a
  usage error.
- `challenges` lists every agent run, including those with no report.
  Each gets its outcome, its Challenges text (or `(no report)`), and each
  failed command as a ready-to-run line:
  `ud runs agent 8b9c --at 57  # exit 1: just test`.
- `--plugin-info`, as the only argument, prints
  `{"apiVersion":1,"name":"runs",...}` for `ud`.
- Control characters print as `\xNN` (see Privacy).

The learning loop: run `challenges`, paste the `--at` lines, and fix what
repeats. For anything else, the files are plain JSONL for jq.

## Retention, Pruning, and Caching

`sync` ends with `runlog_step prune bun run runlog/cli.ts prune || true`.
Prune is a Bun tool, so it starts its own child run with the TS writer.
It deletes day folders older than 30 days (never today or yesterday, UTC),
then the oldest days while `runs/` is over 512 MiB (`warn size-cap`). It
unlinks symlinks without following them. The tap cuts stream lines over
16,384 characters in place, so line numbers stay stable, and stops
copying at 20 MiB. Rebuildable caches go in `XDG_CACHE_HOME`, which
pruning never touches.

## Privacy and Redaction

Threat model: run logs are local files, `0600` in `0700` folders, never
synced, like `~/.claude`. Redaction lowers what a shared file or a pasted
line can leak. It isn't a guarantee. Treat `agent.jsonl` and
`remerge.diff` as sensitive even after redaction: they hold files the
agent read and merged content.

The rule: agents and the terminal see real data; everything under
`BOKU_HOME` is redacted. The tap's progress lines and the report
`git_mf` prints come from redacted copies.

- The agent reads its raw prompt from a 0600 temp file. `prompt.md` is
  only the redacted log copy.
- Codex's `-o` report goes to a temp file outside the run folder, and only
  a redacted copy enters it.
- A run folder never holds an unredacted file, even on failure. A source
  that can't be redacted is deleted, and the run logs
  `warn artifact-failed`.
- Never log the environment. `argv`, string fields, artifacts, and every
  `agent.jsonl` line are redacted before any cut, so a cut never leaves
  part of a secret.
- The readers, and `git_mf` when it prints the report, escape or drop
  terminal control characters.

Saved diffs leave out these paths (`secret_excludes` in `git_mf`):
`**/secrets/**`, `**/.secrets/**`, `**/*.env*`, `**/*.pem`, `**/*.key`,
`**/id_rsa*`, `**/id_ed25519*`, `**/id_ecdsa*`, `**/.npmrc`,
`**/.pypirc`, `**/.netrc`, `**/.aws/**`, and `**/keystore/**`. Key files
are named exactly, so `src/id_generator.go` still shows.

The patterns live in `runlog/redact-patterns.json`, shared by the TS
`redact()` and the bash writer's jq `gsub`. `runlog/redact-patterns.md`
is the reference: the pattern list, the PEM block rule, the jq-syntax
rules a pattern must follow, and a Not Covered list (unlabeled hex keys,
encoded secrets, cookies, and more). `redact-parity.test.ts` runs a corpus
through both writers and fails on any difference.

Why there's no bare 64-hex rule: tx hashes, block hashes, event topics,
storage slots, and `bytes32` constants have that shape, and they're what
you follow when debugging Nibiru and EVM work. EVM keys are redacted only
after a key word such as `--private-key`, `PRIVATE_KEY =`, or
`accounts: [`.

## The `--json` Stdout Convention

`--json` prints the tool's events to stdout, ending with `end`; human text
moves to stderr. Bash tools set `BOKU_RUNLOG_STDOUT=1`, which the writer
unsets for children. Printing doesn't depend on the file, so `--json`
works with `BOKU_RUNLOG=0`. `git_mf` parses `--json` as its own flag.

- `runlog_start` duplicates stdout to a saved fd, so a later `>&2` around
  `runlog_step` can't divert events.
- External commands run through `runlog_exec`, which closes the saved
  copy for that child. Otherwise a child, or anything it leaves running
  in the background (an agent's server, git's `gc --auto`), would hold
  the copy open, and `git_mf --json | jq` would wait for EOF. A shell
  function runs with the copy open, so its own events still print.
- Each event goes to the file first, then to that fd.
- The print runs in a subshell that ignores SIGPIPE for that `printf`
  only, so children never inherit the ignored signal.
- A failed print turns printing off. A closed stdout
  (`git_mf --json | head -n 1`) stops the copy, never the run.
- The tap's `agent-session`, `agent-command`, and `agent-stream` events
  stay in the run file and don't reach stdout.

## Rollout

Phase 1:

- [x] Add `runlog/` (writers, tap, `ud runs`, tests), link `cli.ts` as
  the `ud-runs` plugin, and add `just runs *ARGS`.
  - Why: every producer needs one writer and schema, readable anywhere.
- [x] Restructure `run_agent`; log `git_mf` with `on_exit`, tap, verify.
  - Why: agent merges are where you most want to learn from failures.
- [x] Add the Challenges section to `git_mf.prompt.md`.
  - Why: only the agent can say why something was hard.
- [x] Log `sync` and `sync-jiyuu.sh` with `on_exit`; end `sync` with
  prune.
  - Why: a failed sync must still say so, and the log must stay bounded.
- [x] Add `--json` to `git_mf`.
  - Why: it proves the convention where the output is most worth parsing.

Later:

- [ ] A shared `addJsonOption(program)` for TS tools' `--json`.
  - Why: no TS tool needs machine output yet; `git_mf` proved the
    convention.
- [ ] One real Claude conflict test, gated behind `BOKU_TEST_AGENT=1`.
  - Why: fake agents test our parsing, not a stream format that changed.
- Install history in the `native.sh` scripts, `zsh/health.sh` drift, the
  TS sync scripts, recipes as child runs, and cron jobs.

Risk: stream formats change; lines are still copied and parse misses
become warnings.

## Testing Strategy

`bun:test`, real temp directories, real processes, as in
`skillsSync.test.ts`. Each test sets `BOKU_HOME` to its own `mkdtemp`.

- Writer: caps, code-point cuts in both writers, status mapping, linking,
  50 concurrent appends, symlink refusal, prune, and past-day `reindex`.
- Redaction parity: each pattern compiles alone in jq and JS, and a corpus
  comes out the same from both writers, Nibiru and EVM lines untouched.
- Fail open: unwritable `BOKU_HOME` or no `jq` gives the same exit code
  and repo state as `BOKU_RUNLOG=0`, and leaves no temp prompt behind.
- `git_mf` on real repos with a bare `origin`: each verify row,
  `--dry-run --agent`, `--json` stdout, and the agent reading the raw
  prompt.
- Tap: fake `claude` and `codex` scripts print a stream with a failed
  command and a planted token. Assert redacted files, one `agent-command`
  per command, the failure's `ref.line`, `tap-exited`, and `tap-failed`.
- Reader: orphans, cycles, `--since` forms, and control characters.

## Decisions

1. Sync never passes `--agent`: unattended agents could clobber work.
2. Agent runs keep 30-day retention; the Challenges review stays manual.
3. Homebox runs come later; `host` is already logged.
4. Reader: the `ud runs` plugin plus `just runs`, so it sits with the other
   `ud` commands instead of being its own tool.
5. Root is `~/.boku`, not XDG folders (see Layout).
6. 2026-11-09: `agent-command` logs every command, not only failed ones.
   The user confirmed this in round 2. Successes show which checks the
   agent ran, and agents shouldn't put real keys on command lines.
7. 2026-11-09: the merge agent's allowlist stays broad: `git`, `just`,
   `bun`, `cargo`, and file edits. This is the user's choice, so the agent
   can run any repo's checks. The accepted risk: prompt injection in
   merged content could read local files, such as `~/.ssh` or earlier
   runs' `agent.jsonl`, and send them out. The dotfiles repo is public,
   so this setup isn't hidden.

### Still Open

- Is 16,384 characters per stream line enough? Cutting large tool outputs
  keeps folders small but can hide the end of a long test log. The
  fallback is the full transcript, while it exists.
